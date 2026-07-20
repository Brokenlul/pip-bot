import { z } from 'zod';
import { Tool, zValidator } from './registry.js';
import { makeCache, withRetry, abortRetry, fetchWithTimeout } from '../core/util.js';

/**
 * Footprint (a.k.a. cluster / bid-ask ladder) built off the Binance USDT-M tape.
 *
 * A footprint is the same aggTrades feed `order-flow.ts` already reads, binned
 * two ways instead of summed into one CVD number: time bin (candle) x price
 * bucket, and inside every cell the volume that traded into the bid (sell
 * aggressor) vs into the ask (buy aggressor). Everything ATAS-style traders
 * actually act on — stacked imbalances, absorption, delta divergence,
 * unfinished auctions — is derived from that grid here, so Pip can READ the
 * footprint in text rather than only draw it.
 *
 * Honest limits, and they matter:
 *   - aggTrades pages at 1000 trades. 1000 BTC prints is ~2 minutes of tape, so
 *     a deep window costs many round trips. MAX_PAGES caps that; when the cap
 *     binds we keep the window's RECENT end (anchor at the newest trade and walk
 *     back) and report `truncated` + the minutes actually covered.
 *   - Binance USDT-M only. Hyperliquid REST has no public trades feed, so
 *     HL-only perps and HIP-3 markets cannot produce a footprint at all.
 */

const FAPI = 'https://fapi.binance.com/fapi/v1';
/**
 * Page budget. aggTrades costs 20 request-weight a call against a 2400/min IP
 * budget, so 30 pages was 600 weight for ONE footprint — enough that a couple of
 * back-to-back reads earned a 429 and then a 418 IP ban in testing. 12 pages
 * caps a single read at 240 weight and still covers ~25 min of BTC tape.
 */
const MAX_PAGES = 12;
const PAGE = 1000;
/** Spacing between pages, and a mutex, so concurrent callers can't burst us into a ban. */
const PAGE_SPACING_MS = 60;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let tapeChain: Promise<unknown> = Promise.resolve();
/** Serialize tape reads process-wide — the page budget is per-IP, not per-call. */
function queueTape<T>(fn: () => Promise<T>): Promise<T> {
  const run = tapeChain.then(fn, fn);
  tapeChain = run.catch(() => undefined);
  return run;
}

/** Binance says slow down (429) or has banned us (418) — retrying makes it worse. */
function guardRateLimit(status: number): void {
  if (status === 429 || status === 418) {
    abortRetry(
      status === 418
        ? 'Binance has temporarily blocked our IP for request rate. Footprint reads are unavailable for a few minutes — try again shortly.'
        : 'Binance is rate-limiting us right now. Try the footprint again in a moment.',
    );
  }
}

export const FP_INTERVALS = ['1m', '5m', '15m'] as const;
export type FpInterval = (typeof FP_INTERVALS)[number];
const INTERVAL_MS: Record<FpInterval, number> = { '1m': 60_000, '5m': 300_000, '15m': 900_000 };

/** Diagonal imbalance threshold — one side ≥3x the other, the ATAS default. */
const IMB_RATIO = 3;
/** Consecutive same-side imbalances that make a "stack" worth trading off. */
const STACK_MIN = 3;

export interface FpCell {
  price: number; // bucket low edge
  bid: number; // sell-aggressor volume (hit the bid)
  ask: number; // buy-aggressor volume (lifted the ask)
}

export interface FpImbalance {
  price: number;
  side: 'bid' | 'ask';
  ratio: number;
}

export interface FpStack {
  side: 'bid' | 'ask';
  low: number;
  high: number;
  count: number;
}

export interface FpCandle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  cells: FpCell[]; // ascending by price, only non-empty buckets
  bid: number;
  ask: number;
  delta: number;
  volume: number;
  poc: number; // bucket price with the most total volume
  imbalances: FpImbalance[];
  stacks: FpStack[];
  unfinished: 'high' | 'low' | 'both' | null;
  /** The bin is still forming — its delta and range are incomplete. */
  partial: boolean;
}

export interface FpSignal {
  kind: 'stacked_imbalance' | 'absorption' | 'delta_divergence' | 'unfinished_auction' | 'poc_migration';
  note: string;
  price?: number;
}

export interface FootprintData {
  coin: string;
  interval: FpInterval;
  tick: number; // price bucket size
  candles: FpCandle[];
  trades: number;
  windowMinutes: number;
  truncated: boolean;
  cumDelta: number;
  last: number;
  signals: FpSignal[];
  source_url: string;
}

interface AggTrade {
  a: number;
  p: string;
  q: string;
  m: boolean;
  T: number;
}

const cache = makeCache<FootprintData>(20_000);

const round = (n: number, dp = 4): number => {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};

/**
 * Prices quoted in a signal must resolve to the BUCKET they describe — a 0.002
 * tick rendered at 2dp collapses three distinct levels onto one number and the
 * read stops being actionable.
 */
function priceFmt(tick: number): (p: number) => string {
  const dp = tick >= 1 ? 0 : Math.min(8, Math.ceil(-Math.log10(tick)));
  return (p) => p.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

/** A human-readable bucket size near `raw` (1 / 2 / 2.5 / 5 x 10^k). */
function niceTick(raw: number): number {
  if (!(raw > 0)) return 1;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  return step * mag;
}

/** Walk aggTrades forward from `fromId`, stopping at `endMs` or the page cap. */
async function fetchTape(pair: string, startMs: number, endMs: number): Promise<{ trades: AggTrade[]; truncated: boolean }> {
  // Seed ids at both ends: the first trade at/after startMs, and the newest
  // trade overall. If the span between them exceeds our page budget we shift the
  // start forward so the window we DO fetch ends at now — recent tape is the
  // point of a footprint; stale tape is worthless.
  const [seedRes, tipRes] = await Promise.all([
    fetchWithTimeout(`${FAPI}/aggTrades?symbol=${pair}&startTime=${startMs}&endTime=${Math.min(startMs + 60_000, endMs)}&limit=1`),
    fetchWithTimeout(`${FAPI}/aggTrades?symbol=${pair}&limit=1`),
  ]);
  if (seedRes.status === 400 || tipRes.status === 400) {
    // A bad symbol is deterministic — retrying it just burns request weight.
    abortRetry(`"${pair.replace(/USDT$/, '')}" isn't on Binance USDT-M futures — a footprint needs a public trade tape, which Hyperliquid-only markets don't expose.`);
  }
  guardRateLimit(seedRes.status);
  guardRateLimit(tipRes.status);
  if (!seedRes.ok || !tipRes.ok) throw new Error(`binance aggTrades seed ${seedRes.status}/${tipRes.status}`);
  const seed = (await seedRes.json()) as AggTrade[];
  const tip = (await tipRes.json()) as AggTrade[];
  const firstSeed = seed[0];
  const lastTip = tip[0];
  if (!firstSeed || !lastTip) throw new Error(`no recent trades for ${pair}`);

  const budget = MAX_PAGES * PAGE;
  const span = lastTip.a - firstSeed.a;
  const truncated = span > budget;
  let fromId = truncated ? lastTip.a - budget : firstSeed.a;

  const trades: AggTrade[] = [];
  for (let p = 0; p < MAX_PAGES; p++) {
    if (p > 0) await sleep(PAGE_SPACING_MS);
    const res = await fetchWithTimeout(`${FAPI}/aggTrades?symbol=${pair}&fromId=${fromId}&limit=${PAGE}`);
    guardRateLimit(res.status);
    if (!res.ok) throw new Error(`binance aggTrades ${res.status}`);
    const page = (await res.json()) as AggTrade[];
    if (!page.length) break;
    for (const t of page) if (t.T <= endMs) trades.push(t);
    const last = page[page.length - 1]!;
    if (page.length < PAGE || last.T >= endMs) break;
    fromId = last.a + 1;
  }
  if (!trades.length) throw new Error(`no trades in the requested window for ${pair}`);
  return { trades, truncated };
}

/** Bin a tape into time x price cells and derive per-candle footprint stats. */
export function buildFootprint(trades: AggTrade[], interval: FpInterval, rowsPerCandle = 9): { candles: FpCandle[]; tick: number } {
  const stepMs = INTERVAL_MS[interval];

  const byBin = new Map<number, AggTrade[]>();
  for (const t of trades) {
    const bin = Math.floor(t.T / stepMs) * stepMs;
    const arr = byBin.get(bin);
    if (arr) arr.push(t);
    else byBin.set(bin, [t]);
  }

  // One bucket size for the whole window so rows line up across candles, but
  // sized off a TYPICAL CANDLE's range rather than the window's. Sizing off the
  // window collapses each candle to 2-3 rows, which starves the diagonal
  // imbalance test — it needs a real ladder to compare across. Median, not mean,
  // so one volatile candle can't coarsen the whole grid.
  const ranges = [...byBin.values()]
    .map((ts) => {
      const ps = ts.map((t) => Number(t.p));
      return Math.max(...ps) - Math.min(...ps);
    })
    .filter((r) => r > 0)
    .sort((a, b) => a - b);
  const medRange = ranges.length ? ranges[Math.floor(ranges.length / 2)]! : 0;
  const anyPrice = Number(trades[0]!.p);
  const tick = niceTick(medRange > 0 ? medRange / rowsPerCandle : anyPrice * 1e-4);

  const candles: FpCandle[] = [];
  for (const bin of [...byBin.keys()].sort((a, b) => a - b)) {
    const ts = byBin.get(bin)!;
    const cellMap = new Map<number, FpCell>();
    let bid = 0;
    let ask = 0;
    let h = -Infinity;
    let l = Infinity;
    for (const t of ts) {
      const px = Number(t.p);
      const q = Number(t.q);
      if (px > h) h = px;
      if (px < l) l = px;
      const bucket = round(Math.floor(px / tick) * tick, 8);
      let cell = cellMap.get(bucket);
      if (!cell) {
        cell = { price: bucket, bid: 0, ask: 0 };
        cellMap.set(bucket, cell);
      }
      // isBuyerMaker === false → the buyer was the taker → lifted the ask.
      if (t.m === false) {
        cell.ask += q;
        ask += q;
      } else {
        cell.bid += q;
        bid += q;
      }
    }
    const cells = [...cellMap.values()].sort((a, b) => a.price - b.price).map((c) => ({ price: c.price, bid: round(c.bid, 4), ask: round(c.ask, 4) }));
    if (!cells.length) continue;

    let poc = cells[0]!;
    for (const c of cells) if (c.bid + c.ask > poc.bid + poc.ask) poc = c;

    candles.push({
      t: bin,
      o: Number(ts[0]!.p),
      h,
      l,
      c: Number(ts[ts.length - 1]!.p),
      cells,
      bid: round(bid, 3),
      ask: round(ask, 3),
      delta: round(ask - bid, 3),
      volume: round(ask + bid, 3),
      poc: poc.price,
      imbalances: diagonalImbalances(cells),
      stacks: [],
      unfinished: unfinishedAuction(cells),
      partial: bin + stepMs > Date.now(),
    });
  }
  for (const c of candles) c.stacks = stackImbalances(c.imbalances, tick);
  return { candles, tick };
}

/**
 * Diagonal imbalance: a footprint compares buyers to the sellers they had to
 * outbid, which sits one level DOWN — so ask[i] is measured against bid[i-1],
 * and bid[i] against ask[i+1]. Comparing a cell's own bid to its own ask is the
 * classic beginner mistake; those two never traded against each other.
 */
function diagonalImbalances(cells: FpCell[]): FpImbalance[] {
  const out: FpImbalance[] = [];
  for (let i = 0; i < cells.length; i++) {
    const cur = cells[i]!;
    const below = cells[i - 1];
    const above = cells[i + 1];
    if (below && cur.ask > 0) {
      const ratio = below.bid > 0 ? cur.ask / below.bid : Infinity;
      if (ratio >= IMB_RATIO) out.push({ price: cur.price, side: 'ask', ratio: Number.isFinite(ratio) ? round(ratio, 2) : 99 });
    }
    if (above && cur.bid > 0) {
      const ratio = above.ask > 0 ? cur.bid / above.ask : Infinity;
      if (ratio >= IMB_RATIO) out.push({ price: cur.price, side: 'bid', ratio: Number.isFinite(ratio) ? round(ratio, 2) : 99 });
    }
  }
  return out;
}

/** 3+ consecutive same-side imbalances — the level traders actually defend. */
function stackImbalances(imbs: FpImbalance[], tick: number): FpStack[] {
  const stacks: FpStack[] = [];
  for (const side of ['bid', 'ask'] as const) {
    const levels = imbs
      .filter((i) => i.side === side)
      .map((i) => i.price)
      .sort((a, b) => a - b);
    let run: number[] = [];
    const flush = () => {
      if (run.length >= STACK_MIN) stacks.push({ side, low: run[0]!, high: run[run.length - 1]!, count: run.length });
      run = [];
    };
    for (const p of levels) {
      const prev = run[run.length - 1];
      if (prev === undefined || Math.abs(p - prev - tick) < tick * 0.01) run.push(p);
      else {
        flush();
        run = [p];
      }
    }
    flush();
  }
  return stacks;
}

/**
 * Unfinished auction: at a true extreme the last print is one-sided (the auction
 * finished — buyers exhausted at the high, sellers at the low). Volume on BOTH
 * sides of the extreme cell means the move was cut short, and that level tends
 * to get revisited.
 */
function unfinishedAuction(cells: FpCell[]): 'high' | 'low' | 'both' | null {
  // A single-bucket candle has no distinct high and low cell — the same cell
  // would be reported as both, quoting one price as the high AND the low.
  if (cells.length < 2) return null;
  // "Both sides non-zero" alone fires on nearly every candle — one stray print
  // on the wrong side is enough. A finished auction is decisively one-sided, so
  // require the weaker side to be a real share of the stronger before calling
  // the extreme unfinished.
  const twoSided = (c: FpCell) => {
    const weak = Math.min(c.bid, c.ask);
    const strong = Math.max(c.bid, c.ask);
    return strong > 0 && weak / strong >= 0.25;
  };
  const hiOpen = twoSided(cells[cells.length - 1]!);
  const loOpen = twoSided(cells[0]!);
  return hiOpen && loOpen ? 'both' : hiOpen ? 'high' : loOpen ? 'low' : null;
}

/** Window-level reads — the part worth more than the picture. */
function deriveSignals(candles: FpCandle[], tick: number): FpSignal[] {
  const out: FpSignal[] = [];
  const fmt = priceFmt(tick);
  // The newest bin is usually still forming. Its delta is small and its range
  // narrow purely because it is seconds old, which fakes "weaker delta"
  // divergences and phantom absorption — so every signal is derived from
  // COMPLETED candles only.
  const done = candles.filter((c) => !c.partial);
  if (done.length < 2) return out;
  const recent = done.slice(-5);

  // Stacked imbalances in the recent candles — strongest first.
  const stacks = recent
    .flatMap((c) => c.stacks.map((s) => ({ ...s, t: c.t })))
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);
  for (const s of stacks) {
    out.push({
      kind: 'stacked_imbalance',
      price: s.low,
      note: `${s.count} stacked ${s.side === 'ask' ? 'buy' : 'sell'} imbalances ${s.low === s.high ? `at ${fmt(s.low)}` : `${fmt(s.low)}–${fmt(s.high + tick)}`} — ${s.side === 'ask' ? 'aggressive buyers lifting through offers; support on a retest' : 'aggressive sellers hitting bids; resistance on a retest'}`,
    });
  }

  // Absorption: heavy volume parked at a candle extreme that price then rejected.
  for (const c of recent) {
    const range = c.h - c.l;
    // Needs a real ladder — on a 1-2 bucket candle "the POC is at the extreme"
    // is trivially true and the read is meaningless.
    if (range <= 0 || c.volume <= 0 || c.cells.length < 3) continue;
    const pocHigh = (c.poc - c.l) / range > 0.75;
    const pocLow = (c.poc - c.l) / range < 0.25;
    const closedLow = (c.c - c.l) / range < 0.4;
    const closedHigh = (c.c - c.l) / range > 0.6;
    const pocCell = c.cells.find((x) => x.price === c.poc);
    if (!pocCell) continue;
    const share = (pocCell.bid + pocCell.ask) / c.volume;
    if (share < 0.2) continue; // needs to be a genuine concentration, not a flat candle
    if (pocHigh && closedLow && pocCell.ask > pocCell.bid) {
      out.push({ kind: 'absorption', price: c.poc, note: `Buyers absorbed at ${fmt(c.poc)} — ${Math.round(share * 100)}% of the candle's volume went off at the highs on buy aggression, then price closed back at the lows. Sellers held it.` });
    } else if (pocLow && closedHigh && pocCell.bid > pocCell.ask) {
      out.push({ kind: 'absorption', price: c.poc, note: `Sellers absorbed at ${fmt(c.poc)} — ${Math.round(share * 100)}% of the candle's volume went off at the lows on sell aggression, then price closed back at the highs. Buyers held it.` });
    }
  }

  // Delta divergence: a new price extreme the delta refused to confirm.
  if (done.length >= 4) {
    const last = done[done.length - 1]!;
    const prior = done.slice(0, -1);
    const priorHigh = Math.max(...prior.map((c) => c.h));
    const priorLow = Math.min(...prior.map((c) => c.l));
    const maxDelta = Math.max(...prior.map((c) => c.delta));
    const minDelta = Math.min(...prior.map((c) => c.delta));
    if (last.h >= priorHigh && last.delta < maxDelta) {
      out.push({ kind: 'delta_divergence', price: last.h, note: `New high at ${fmt(last.h)} on weaker delta (${last.delta > 0 ? '+' : ''}${last.delta} vs ${maxDelta > 0 ? '+' : ''}${maxDelta} earlier) — the push up isn't backed by fresh aggressive buying.` });
    }
    if (last.l <= priorLow && last.delta > minDelta) {
      out.push({ kind: 'delta_divergence', price: last.l, note: `New low at ${fmt(last.l)} on weaker negative delta (${last.delta > 0 ? '+' : ''}${last.delta} vs ${minDelta} earlier) — sellers aren't pressing the break.` });
    }
  }

  // Unfinished business at the extremes of the most recent completed candle.
  const last = done[done.length - 1];
  if (last?.unfinished === 'high' || last?.unfinished === 'both') {
    out.push({ kind: 'unfinished_auction', price: last.h, note: `Unfinished auction at the ${fmt(last.h)} high — two-sided volume at the extreme, so the level tends to get revisited.` });
  }
  if (last?.unfinished === 'low' || last?.unfinished === 'both') {
    out.push({ kind: 'unfinished_auction', price: last.l, note: `Unfinished auction at the ${fmt(last.l)} low — two-sided volume at the extreme, so the level tends to get revisited.` });
  }

  // Where value is migrating across the window.
  if (done.length >= 3) {
    const firstPoc = done[0]!.poc;
    const lastPoc = done[done.length - 1]!.poc;
    const steps = Math.round((lastPoc - firstPoc) / tick);
    if (Math.abs(steps) >= 2) {
      out.push({ kind: 'poc_migration', price: lastPoc, note: `Value migrating ${steps > 0 ? 'up' : 'down'} — per-candle POC moved ${fmt(firstPoc)} → ${fmt(lastPoc)} over the window.` });
    }
  }

  return out;
}

/** Widest window we ever fetch — every caller slices this down. */
const WINDOW_CANDLES = 14;

/**
 * Cached per coin+interval, NOT per requested candle count: the text tool and
 * the chart tool ask for different counts of the same market, and keying on the
 * count made the common "read it and show me" turn fetch the same tape twice.
 * We always pull the widest window and slice.
 */
export async function footprintData(coin: string, interval: FpInterval = '1m', candleCount = 12): Promise<FootprintData> {
  const sym = coin.trim().replace(/^\$/, '').toUpperCase();
  const want = Math.min(candleCount, WINDOW_CANDLES);
  const key = `${sym}:${interval}`;
  const hit = cache.get(key);
  if (hit) return sliceWindow(hit, want);

  const pair = `${sym}USDT`;
  const stepMs = INTERVAL_MS[interval];
  const end = Date.now();
  const start = Math.floor((end - WINDOW_CANDLES * stepMs) / stepMs) * stepMs;

  const { trades, truncated } = await queueTape(() => fetchTape(pair, start, end));
  const { candles, tick } = buildFootprint(trades, interval);
  if (candles.length < 2) throw new Error(`Not enough tape for a ${sym} footprint on ${interval}.`);

  // Drop a leading partial bin when the page cap cut into it — a half-sampled
  // candle would show a fake delta and fake imbalances.
  const trimmed = truncated && candles.length > 2 ? candles.slice(1) : candles;

  const first = trades[0]!;
  const lastTrade = trades[trades.length - 1]!;
  const data: FootprintData = {
    coin: sym,
    interval,
    tick,
    candles: trimmed,
    trades: trades.length,
    windowMinutes: round((lastTrade.T - first.T) / 60_000, 1),
    truncated,
    cumDelta: round(
      trimmed.reduce((s, c) => s + c.delta, 0),
      3,
    ),
    last: Number(lastTrade.p),
    signals: deriveSignals(trimmed, tick),
    source_url: `https://www.binance.com/en/futures/${pair}`,
  };
  cache.set(key, data);
  return sliceWindow(data, want);
}

/**
 * Narrow a cached full-window read to the most recent `n` candles. Delta and the
 * signals are recomputed over the slice — carrying the full window's cumulative
 * delta onto a shorter view would misreport what the user is actually shown.
 */
function sliceWindow(d: FootprintData, n: number): FootprintData {
  if (d.candles.length <= n) return d;
  const candles = d.candles.slice(-n);
  return {
    ...d,
    candles,
    cumDelta: round(
      candles.reduce((s, c) => s + c.delta, 0),
      3,
    ),
    // Span of the bins plus the last bin's own duration.
    windowMinutes: round((candles[candles.length - 1]!.t - candles[0]!.t + INTERVAL_MS[d.interval]) / 60_000, 1),
    signals: deriveSignals(candles, d.tick),
  };
}

// ---- footprint (text read) --------------------------------------------------
// Deliberately returns the SIGNALS plus a compact per-candle summary rather than
// the full cell grid: the grid is thousands of numbers the model would only
// mis-summarise, and the tradeable content is the derived reads.

const InputSchema = z.object({
  coin: z.string().min(1).describe('Ticker, e.g. "BTC", "ETH", "SOL". No "$" or "/USDT".'),
  interval: z.enum(FP_INTERVALS).optional().describe('Footprint candle size (default "1m").'),
  candles: z.number().int().min(4).max(20).optional().describe('How many candles of tape to read (default 12).'),
});
type Input = z.infer<typeof InputSchema>;

interface CandleSummary {
  time_utc: string;
  open: number;
  high: number;
  low: number;
  close: number;
  bid_volume: number;
  ask_volume: number;
  delta: number;
  poc: number;
  stacked_imbalances: string[];
  unfinished: 'high' | 'low' | 'both' | null;
  /** True for the newest bin while it is still forming — do not read its delta as final. */
  still_forming?: boolean;
}

interface Output {
  coin: string;
  interval: FpInterval;
  price_bucket: number;
  window_minutes: number;
  trades_read: number;
  window_capped: boolean;
  last_price: number;
  cumulative_delta: number;
  signals: { kind: string; note: string; price?: number }[];
  candles: CandleSummary[];
  source_url: string;
}

export const footprintTool: Tool<Input, Output> = {
  name: 'footprint',
  description:
    'FOOTPRINT / cluster read of the live tape: per-candle bid-vs-ask volume at every price level, and the reads that come off it — stacked diagonal imbalances (3+ consecutive levels where one side is ≥3x the other), absorption (heavy volume at an extreme that price then rejected), delta divergence (a new price high/low the delta refused to confirm), unfinished auctions (two-sided volume at a candle extreme), and per-candle POC migration. Use when a trader asks about the footprint, cluster chart, bid-ask ladder, order-flow imbalances, absorption, delta divergence, or "who is actually being aggressive at this level", and when checking whether a level held on real aggression before calling it support/resistance. Binance USDT-M futures only — Hyperliquid-only perps have no public trade tape and cannot produce a footprint. Reads a short recent window (minutes, not days); it is a tape read, not a full session profile — for session-scale volume-at-price use render_profile instead.',
  inputSchema: {
    type: 'object',
    properties: {
      coin: { type: 'string', description: 'Ticker, e.g. "BTC", "ETH". No $ prefix.' },
      interval: { type: 'string', enum: [...FP_INTERVALS], description: 'Footprint candle size; default "1m".' },
      candles: { type: 'number', description: 'Candles of tape to read, 4-20; default 12.' },
    },
    required: ['coin'],
  },
  validate: zValidator(InputSchema),
  execute: async (input) => {
    return withRetry(async () => {
      const d = await footprintData(input.coin, input.interval ?? '1m', input.candles ?? 12);
      const fmt = priceFmt(d.tick);
      return {
        coin: d.coin,
        interval: d.interval,
        price_bucket: d.tick,
        window_minutes: d.windowMinutes,
        trades_read: d.trades,
        window_capped: d.truncated,
        last_price: d.last,
        cumulative_delta: d.cumDelta,
        signals: d.signals.map((s) => ({ kind: s.kind, note: s.note, ...(s.price === undefined ? {} : { price: s.price }) })),
        candles: d.candles.map((c) => ({
          time_utc: new Date(c.t).toISOString().slice(11, 16),
          open: c.o,
          high: c.h,
          low: c.l,
          close: c.c,
          bid_volume: c.bid,
          ask_volume: c.ask,
          delta: c.delta,
          poc: c.poc,
          stacked_imbalances: c.stacks.map((s) => `${s.count}x ${s.side === 'ask' ? 'buy' : 'sell'} ${fmt(s.low)}-${fmt(s.high + d.tick)}`),
          unfinished: c.unfinished,
          ...(c.partial ? { still_forming: true } : {}),
        })),
        source_url: d.source_url,
      };
    }, `footprint:${input.coin}`);
  },
  citation: (_input, out) => ({ label: `Footprint (Binance ${out.coin}-PERP ${out.interval})`, url: out.source_url }),
};
