import { z } from 'zod';
import { Tool, zValidator } from './registry.js';
import { makeCache, withRetry, fetchWithTimeout } from '../core/util.js';
import { hlInfo, resolveCoinName } from './hyperliquid.js';

/**
 * Order-flow snapshot: order-book imbalance + liquidity walls, and (for majors)
 * CVD / aggressor split / large prints off the tape. This is the honest version
 * of what ATAS / Bookmap traders want: Pip can't stream a live DOM, but it can
 * read the CURRENT book and a recent trades window the moment a trader asks.
 *
 *   - Majors: Binance USDT-M futures (perp-aligned with our funding/OI lens) for
 *     both book (fapi /depth) and flow (fapi /aggTrades, aggressor via isBuyerMaker).
 *   - Everything else (HIP-3 / HL-only perps): Hyperliquid l2Book for the book;
 *     HL REST has no public trades feed, so flow is omitted and said so.
 *
 * Only fired when a user explicitly asks about order flow / book / DOM / CVD /
 * bids-asks / aggression / walls (see the SYSTEM_PROMPT trigger).
 */

const FAPI = 'https://fapi.binance.com/fapi/v1';
const NEAR_BAND = 0.005; // ±0.5% of mid
const WIDE_BAND = 0.02; // ±2% of mid

const InputSchema = z.object({
  coin: z.string().min(1).describe('Ticker to read order flow for, e.g. "BTC", "ETH", "SOL". No "$" or "/USDT".'),
});
type Input = z.infer<typeof InputSchema>;

interface Wall {
  price: number;
  size: number;
}
interface Band {
  band_pct: number;
  bid_size: number;
  ask_size: number;
  ratio: number; // bid/ask resting size
  heavier: 'bids' | 'asks' | 'balanced';
}
interface Flow {
  trades: number;
  window_minutes: number;
  cvd: number; // net signed aggressor volume, base units
  buy_pct: number;
  sell_pct: number;
  large_prints: { price: number; size: number; side: 'buy' | 'sell'; notional: number }[];
}
interface Output {
  coin: string;
  venue: 'binance-futures' | 'hyperliquid';
  best_bid: number;
  best_ask: number;
  mid: number;
  spread_bps: number;
  imbalance_near: Band;
  imbalance_wide: Band;
  bid_walls: Wall[];
  ask_walls: Wall[];
  flow_available: boolean;
  flow?: Flow;
  source_url: string;
}

interface Level {
  px: number;
  sz: number;
}

const cache = makeCache<Output>(15_000); // order flow moves fast

const round = (n: number, dp = 4): number => {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};

function band(bids: Level[], asks: Level[], mid: number, bandPct: number): Band {
  const lo = mid * (1 - bandPct);
  const hi = mid * (1 + bandPct);
  const bidSize = bids.filter((l) => l.px >= lo).reduce((s, l) => s + l.sz, 0);
  const askSize = asks.filter((l) => l.px <= hi).reduce((s, l) => s + l.sz, 0);
  const ratio = askSize > 0 ? bidSize / askSize : bidSize > 0 ? Infinity : 1;
  const heavier = ratio >= 1.15 ? 'bids' : ratio <= 0.87 ? 'asks' : 'balanced';
  return { band_pct: bandPct * 100, bid_size: round(bidSize, 2), ask_size: round(askSize, 2), ratio: round(ratio, 2), heavier };
}

function walls(levels: Level[], mid: number, n = 4): Wall[] {
  // Consider resting size within ~5% of mid, biggest first — the levels a trader
  // would actually watch, not far-away dust.
  const near = levels.filter((l) => Math.abs(l.px - mid) / mid <= 0.05);
  return [...near]
    .sort((a, b) => b.sz - a.sz)
    .slice(0, n)
    .map((l) => ({ price: round(l.px, 2), size: round(l.sz, 2) }));
}

function bookOutput(coin: string, venue: Output['venue'], bids: Level[], asks: Level[], source_url: string): Omit<Output, 'flow_available' | 'flow'> {
  const bb = bids[0];
  const ba = asks[0];
  if (!bb || !ba) throw new Error(`empty book for ${coin}`);
  const best_bid = bb.px;
  const best_ask = ba.px;
  const mid = (best_bid + best_ask) / 2;
  return {
    coin,
    venue,
    best_bid: round(best_bid, 2),
    best_ask: round(best_ask, 2),
    mid: round(mid, 2),
    spread_bps: round(((best_ask - best_bid) / mid) * 10_000, 2),
    imbalance_near: band(bids, asks, mid, NEAR_BAND),
    imbalance_wide: band(bids, asks, mid, WIDE_BAND),
    bid_walls: walls(bids, mid),
    ask_walls: walls(asks, mid),
    source_url,
  };
}

// ---- Binance futures (majors): book + flow --------------------------------

async function fetchBinance(sym: string): Promise<Output | null> {
  const pair = `${sym}USDT`;
  const depthRes = await fetchWithTimeout(`${FAPI}/depth?symbol=${pair}&limit=500`);
  if (depthRes.status === 400) return null; // not listed → caller falls back to HL
  if (!depthRes.ok) throw new Error(`binance depth ${depthRes.status}`);
  const depth = (await depthRes.json()) as { bids: [string, string][]; asks: [string, string][] };
  const bids: Level[] = depth.bids.map(([p, s]) => ({ px: Number(p), sz: Number(s) }));
  const asks: Level[] = depth.asks.map(([p, s]) => ({ px: Number(p), sz: Number(s) }));
  if (!bids.length || !asks.length) throw new Error(`binance depth empty for ${pair}`);

  const base = bookOutput(sym, 'binance-futures', bids, asks, `https://www.binance.com/en/futures/${pair}`);

  // Flow from the recent tape. Best-effort: a book read still returns if this fails.
  let flow: Flow | undefined;
  try {
    const tRes = await fetchWithTimeout(`${FAPI}/aggTrades?symbol=${pair}&limit=1000`);
    if (tRes.ok) {
      const trades = (await tRes.json()) as { p: string; q: string; m: boolean; T: number }[];
      if (trades.length) {
        let buyVol = 0;
        let sellVol = 0;
        for (const t of trades) {
          const q = Number(t.q);
          if (t.m === false) buyVol += q; // buyer was taker → BUY aggressor
          else sellVol += q;
        }
        const prints = trades
          .map((t) => ({ price: Number(t.p), size: Number(t.q), side: (t.m === false ? 'buy' : 'sell') as 'buy' | 'sell', notional: Number(t.p) * Number(t.q) }))
          .sort((a, b) => b.notional - a.notional)
          .slice(0, 5)
          .map((p) => ({ price: round(p.price, 2), size: round(p.size, 3), side: p.side, notional: round(p.notional, 0) }));
        const total = buyVol + sellVol;
        const first = trades[0];
        const last = trades[trades.length - 1];
        flow = {
          trades: trades.length,
          window_minutes: first && last ? round((last.T - first.T) / 60_000, 1) : 0,
          cvd: round(buyVol - sellVol, 2),
          buy_pct: total > 0 ? round((buyVol / total) * 100, 1) : 0,
          sell_pct: total > 0 ? round((sellVol / total) * 100, 1) : 0,
          large_prints: prints,
        };
      }
    }
  } catch (e) {
    console.warn(`[order-flow] binance aggTrades ${pair}: ${(e as Error).message}`);
  }

  return { ...base, flow_available: Boolean(flow), flow };
}

// ---- Hyperliquid fallback (HIP-3 / HL-only): book only --------------------

async function fetchHyperliquid(sym: string): Promise<Output> {
  const name = await resolveCoinName(sym);
  if (!name) throw new Error(`"${sym}" not found on Binance futures or Hyperliquid — check the ticker.`);
  const book = await hlInfo<{ levels: [Array<{ px: string; sz: string }>, Array<{ px: string; sz: string }>] }>({ type: 'l2Book', coin: name });
  const bids: Level[] = book.levels[0].map((l) => ({ px: Number(l.px), sz: Number(l.sz) }));
  const asks: Level[] = book.levels[1].map((l) => ({ px: Number(l.px), sz: Number(l.sz) }));
  if (!bids.length || !asks.length) throw new Error(`hyperliquid l2Book empty for ${name}`);
  const base = bookOutput(name, 'hyperliquid', bids, asks, `https://app.hyperliquid.xyz/trade/${name}`);
  return { ...base, flow_available: false };
}

export const orderFlowTool: Tool<Input, Output> = {
  name: 'order_flow',
  description:
    'Snapshot of ORDER FLOW for a market: order-book imbalance (resting bid vs ask size near price), the biggest liquidity walls each side, and — for majors — CVD / net delta, aggressor buy-vs-sell split, and the largest recent prints off the tape. Use ONLY when a trader explicitly asks about order flow, the order book / DOM / depth, bids vs asks, walls, CVD / delta, aggression, or "who is hitting the tape". Do NOT use it for plain price, trend, funding, or chart questions. Majors read from Binance USDT-M futures (book + flow); other coins (HIP-3 tokenized equities, HL-only perps) return a book-only read from Hyperliquid. This is a point-in-time snapshot, not a live stream, and resting size can be spoofed.',
  inputSchema: {
    type: 'object',
    properties: {
      coin: { type: 'string', description: 'Ticker, e.g. "BTC", "ETH", "SOL". No $ prefix, no /USDT.' },
    },
    required: ['coin'],
  },
  validate: zValidator(InputSchema),
  execute: async (input) => {
    return withRetry(async () => {
      const sym = input.coin.trim().replace(/^\$/, '').toUpperCase();
      const hit = cache.get(sym);
      if (hit) return hit;
      const out = (await fetchBinance(sym)) ?? (await fetchHyperliquid(sym));
      cache.set(sym, out);
      return out;
    }, `order-flow:${input.coin}`);
  },
  citation: (_input, out) => ({
    label: out.venue === 'binance-futures' ? `Order flow (Binance ${out.coin}-PERP)` : `Order flow (Hyperliquid ${out.coin})`,
    url: out.source_url,
  }),
};
