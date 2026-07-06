import { z } from 'zod';
import { Tool, zValidator } from './registry.js';
import { makeCache, withRetry } from '../core/util.js';
import { hlInfo, resolveCoinName } from './hyperliquid.js';
import {
  renderCandleChartPng,
  Candle,
  ChartLevel,
  ChartSpec,
  OverlayLine,
  ChartZone,
  SubPane,
} from '../core/candle-chart.js';
import { sma, ema, rsi, macd, vwap, bollinger, fvgZones, Series } from '../core/indicators.js';

/**
 * render_price_chart — draws a Pip-branded candlestick chart (Hyperliquid
 * candles, rendered locally, zero cost) with optional levels and indicators,
 * and attaches the PNG to the reply via ToolContext.attachImage. The model
 * gets a JSON summary (including current indicator values) back; the image
 * itself rides on the NormalizedReply.
 */

const INTERVALS = ['5m', '15m', '1h', '4h', '1d'] as const;
type Interval = (typeof INTERVALS)[number];
const INTERVAL_MS: Record<Interval, number> = {
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 3_600_000,
  '4h': 4 * 3_600_000,
  '1d': 24 * 3_600_000,
};
// 120 candles shown; extra history fetched so EMA200/MACD/RSI are already
// warmed up at the left edge of the visible window.
const DISPLAY_COUNT = 120;
const WARMUP_COUNT = 220;

const INDICATORS = [
  'ema20',
  'ema50',
  'ema100',
  'ema200',
  'sma20',
  'sma50',
  'vwap',
  'bollinger',
  'macd',
  'rsi',
  'fvg',
] as const;
type Indicator = (typeof INDICATORS)[number];

// Overlay palette — distinct from the level colors (entry white / stop clay /
// target green / level blue) so lines stay tellable-apart.
const OVERLAY_COLOR: Record<string, string> = {
  ema20: '#E8C15A',
  ema50: '#7E93FF',
  ema100: '#C77DFF',
  ema200: '#F2F4F1',
  sma20: '#5AC8E8',
  sma50: '#FF8FB1',
  vwap: '#5AC8E8',
};

const LevelSchema = z.object({
  price: z.number().positive(),
  label: z.string().max(40).optional(),
  kind: z.enum(['entry', 'stop', 'target', 'level']).optional(),
});

const InputSchema = z.object({
  coin: z.string().min(1).describe('Perp ticker on Hyperliquid (e.g. "LINK", "BTC", "HYPE").'),
  interval: z.enum(INTERVALS).optional().describe('Candle timeframe (default "1h").'),
  levels: z
    .array(LevelSchema)
    .max(6)
    .optional()
    .describe('Horizontal levels to mark: entry / stop / target / plain level, each with a price and short label.'),
  indicators: z
    .array(z.enum(INDICATORS))
    .max(5)
    .optional()
    .describe('Indicators to draw: EMA/SMA overlays, vwap, bollinger, macd, rsi (sub-panes), fvg (fair value gap zones).'),
});
type Input = z.infer<typeof InputSchema>;

interface Output {
  chart_attached: boolean;
  coin: string;
  interval: Interval;
  candles: number;
  window_start_utc: string;
  last_close: number;
  window_high: number;
  window_low: number;
  window_change_pct: number;
  levels_drawn: number;
  levels_skipped: string[];
  indicators_drawn: string[];
  /** Current values of what was drawn — reference these in the answer. */
  indicator_readout: Record<string, string>;
  source_url: string;
}

interface RawCandle {
  t: number;
  o: string;
  h: string;
  l: string;
  c: string;
  v: string;
}

const candleCache = makeCache<Candle[]>(60_000);

async function fetchCandles(coin: string, interval: Interval): Promise<Candle[]> {
  const key = `${coin}:${interval}`;
  return candleCache.wrap(key, async () => {
    const end = Date.now();
    const start = end - INTERVAL_MS[interval] * (DISPLAY_COUNT + WARMUP_COUNT + 2);
    const raw = await hlInfo<RawCandle[]>({
      type: 'candleSnapshot',
      req: { coin, interval, startTime: start, endTime: end },
    });
    return (raw ?? [])
      .map((r) => ({ t: r.t, o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c), v: Number(r.v) }))
      .slice(-(DISPLAY_COUNT + WARMUP_COUNT));
  });
}

const fmtV = (v: number | null | undefined): string =>
  v == null ? 'n/a' : parseFloat(v.toPrecision(5)).toString();

/** Compute the requested indicators over full history, sliced to the window. */
function buildIndicators(
  all: Candle[],
  windowCandles: Candle[],
  wanted: Indicator[],
): { overlays: OverlayLine[]; band: ChartSpec['band']; zones: ChartZone[]; subPanes: SubPane[]; readout: Record<string, string> } {
  const offset = all.length - windowCandles.length;
  const cut = (s: Series) => s.slice(offset);
  const closes = all.map((c) => c.c);
  const overlays: OverlayLine[] = [];
  const subPanes: SubPane[] = [];
  const zones: ChartZone[] = [];
  let band: ChartSpec['band'];
  const readout: Record<string, string> = {};
  const lastOf = (s: Series) => [...s].reverse().find((v) => v != null) ?? null;

  for (const ind of wanted) {
    if (/^(ema|sma)\d+$/.test(ind)) {
      const period = Number(ind.slice(3));
      const series = ind.startsWith('ema') ? ema(closes, period) : sma(closes, period);
      overlays.push({ label: ind.toUpperCase(), color: OVERLAY_COLOR[ind]!, points: cut(series) });
      readout[ind] = fmtV(lastOf(series));
    } else if (ind === 'vwap') {
      // Anchored at the visible window's open, not the warm-up start.
      const series = vwap(windowCandles);
      overlays.push({ label: 'VWAP', color: OVERLAY_COLOR.vwap!, points: series, dashed: true });
      readout.vwap = `${fmtV(lastOf(series))} (anchored at window open)`;
    } else if (ind === 'bollinger') {
      const bb = bollinger(closes);
      band = { label: 'BB(20,2)', color: '#8FA398', upper: cut(bb.upper), lower: cut(bb.lower) };
      overlays.push({ label: 'BB mid', color: '#8FA398', points: cut(bb.mid), dashed: true });
      readout.bollinger = `upper ${fmtV(lastOf(bb.upper))} · mid ${fmtV(lastOf(bb.mid))} · lower ${fmtV(lastOf(bb.lower))}`;
    } else if (ind === 'macd') {
      const m = macd(closes);
      const histWin = cut(m.hist);
      subPanes.push({
        title: 'MACD (12,26,9)',
        series: [
          { label: 'MACD', color: '#5AC8E8', points: cut(m.macd) },
          { label: 'signal', color: '#E8C15A', points: cut(m.signal) },
        ],
        histogram: { points: histWin, posColor: '#12A15A', negColor: '#C25B37' },
        guides: [0],
      });
      const hLast = lastOf(m.hist);
      const hPrev = [...m.hist].filter((v) => v != null).slice(-4, -1);
      const trend =
        hLast != null && hPrev.length >= 2
          ? Math.abs(hLast) > Math.abs(hPrev[hPrev.length - 1]!)
            ? 'expanding'
            : 'contracting'
          : 'n/a';
      readout.macd = `macd ${fmtV(lastOf(m.macd))} · signal ${fmtV(lastOf(m.signal))} · histogram ${fmtV(hLast)} (${hLast != null && hLast >= 0 ? 'positive' : 'negative'}, ${trend})`;
    } else if (ind === 'rsi') {
      const series = rsi(closes);
      subPanes.push({
        title: 'RSI (14)',
        series: [{ label: 'RSI', color: '#C77DFF', points: cut(series) }],
        yDomain: [0, 100],
        guides: [30, 70],
      });
      readout.rsi = fmtV(lastOf(series));
    } else if (ind === 'fvg') {
      const unfilled = fvgZones(all)
        .filter((zn) => !zn.filled && zn.index >= offset - 40) // recent, still-open gaps
        .slice(-5);
      for (const zn of unfilled) {
        zones.push({
          top: zn.top,
          bottom: zn.bottom,
          fromIndex: Math.max(0, zn.index - offset),
          color: zn.bullish ? '#12A15A' : '#C25B37',
          label: `FVG${zn.bullish ? ' ↑' : ' ↓'}`,
        });
      }
      readout.fvg = unfilled.length
        ? unfilled
            .map((zn) => `${zn.bullish ? 'bullish' : 'bearish'} ${fmtV(zn.bottom)}–${fmtV(zn.top)}`)
            .join('; ')
        : 'no unfilled fair value gaps in the visible window';
    }
  }
  return { overlays, band, zones, subPanes, readout };
}

export const priceChartTool: Tool<Input, Output> = {
  name: 'render_price_chart',
  description:
    'Draw a branded candlestick chart image (Hyperliquid candles: any standard perp like BTC/ETH/SOL/HYPE/LINK, plus builder markets like TSLA/BOT) and ATTACH it to your reply automatically. Options: up to 6 horizontal levels (entry / stop / target / level, each with price + short label) AND indicators — ema20/ema50/ema100/ema200, sma20/sma50, vwap, bollinger, macd, rsi (drawn as sub-panes), fvg (unfilled fair-value-gap zones, the objective SMC building block). Use it whenever a user asks to SEE something on a chart or asks for an indicator ("use MACD", "add RSI", "show the EMAs", "mark the FVGs"). The tool result includes indicator_readout with the current values — weave those numbers into your answer. You CAN render charts with indicators — never claim you cannot. What you cannot do: annotate someone else\'s screenshot or replicate a proprietary paid indicator suite (e.g. full LuxAlgo SMC labels) — offer the closest of your own instead.',
  inputSchema: {
    type: 'object',
    properties: {
      coin: { type: 'string', description: 'Perp ticker (e.g. "LINK", "BTC", "HYPE"). No $ prefix.' },
      interval: {
        type: 'string',
        enum: [...INTERVALS],
        description: 'Candle timeframe. Match what the conversation is about; default "1h".',
      },
      levels: {
        type: 'array',
        maxItems: 6,
        description: 'Horizontal levels to draw on the chart.',
        items: {
          type: 'object',
          properties: {
            price: { type: 'number', description: 'Price of the level.' },
            label: { type: 'string', description: 'Short label, e.g. "entry", "SL — thesis broken", "TP zone".' },
            kind: {
              type: 'string',
              enum: ['entry', 'stop', 'target', 'level'],
              description: 'Styles the line: entry=white, stop=clay, target=green, level=blue.',
            },
          },
          required: ['price'],
        },
      },
      indicators: {
        type: 'array',
        maxItems: 5,
        items: { type: 'string', enum: [...INDICATORS] },
        description:
          'Indicators to draw. Overlays: ema20/ema50/ema100/ema200, sma20/sma50, vwap, bollinger. Sub-panes: macd, rsi. Zones: fvg (unfilled fair value gaps).',
      },
    },
    required: ['coin'],
  },
  validate: zValidator(InputSchema),
  execute: async (input, ctx) => {
    return withRetry(
      async () => {
        const interval = input.interval ?? '1h';
        const coin = await resolveCoinName(input.coin);
        if (!coin) throw new Error(`Coin "${input.coin}" not found on Hyperliquid — confirm the ticker.`);
        const all = await fetchCandles(coin, interval);
        if (all.length < 2) throw new Error(`No candle data for ${coin} on ${interval}.`);
        const candles = all.slice(-DISPLAY_COUNT);

        const lo = Math.min(...candles.map((c) => c.l));
        const hi = Math.max(...candles.map((c) => c.h));
        const span = hi - lo || hi * 0.01 || 1;
        const levels: ChartLevel[] = [];
        const skipped: string[] = [];
        for (const lv of input.levels ?? []) {
          // Mirror the renderer's drawable window so the summary is honest.
          if (lv.price >= lo - span * 0.6 && lv.price <= hi + span * 0.6) levels.push(lv);
          else skipped.push(`${lv.label ?? 'level'} @ ${lv.price} (outside the visible ${interval} window)`);
        }

        const wanted = [...new Set(input.indicators ?? [])];
        const { overlays, band, zones, subPanes, readout } = buildIndicators(all, candles, wanted);

        const png = renderCandleChartPng({
          title: `${coin} · ${interval.toUpperCase()}`,
          subtitle: 'perp · last 120 candles',
          candles,
          levels,
          overlays,
          band,
          zones,
          subPanes,
        });
        const filename = `pip-chart-${coin.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${interval}.png`;
        const attached = ctx.attachImage?.(filename, png) ?? false;
        if (!attached) throw new Error('Chart limit for this reply reached — refer to the chart already attached.');

        const first = candles[0]!;
        const last = candles[candles.length - 1]!;
        return {
          chart_attached: true,
          coin,
          interval,
          candles: candles.length,
          window_start_utc: new Date(first.t).toISOString(),
          last_close: last.c,
          window_high: hi,
          window_low: lo,
          window_change_pct: Number((((last.c - first.o) / first.o) * 100).toFixed(2)),
          levels_drawn: levels.length,
          levels_skipped: skipped,
          indicators_drawn: wanted,
          indicator_readout: readout,
          source_url: `https://app.hyperliquid.xyz/trade/${coin}`,
        };
      },
      `chart:${input.coin}:${input.interval ?? '1h'}`,
    );
  },
  citation: (_, out) => ({ label: `Hyperliquid candles (${out.coin} ${out.interval})`, url: out.source_url }),
};

// ---- indicator_snapshot -----------------------------------------------------
// Same candles + math as the chart tool, no image. Exists because the model
// otherwise ASSERTS price-vs-MA relationships from memory (it told a user to
// watch the 4h EMA200 as support while price was 3% below it).

const SnapshotInputSchema = z.object({
  coin: z.string().min(1),
  interval: z.enum(INTERVALS).optional(),
  indicators: z.array(z.enum(INDICATORS)).max(6).optional(),
});
type SnapshotInput = z.infer<typeof SnapshotInputSchema>;

interface SnapshotOutput {
  coin: string;
  interval: Interval;
  last_close: number;
  window_high: number;
  window_low: number;
  window_change_pct: number;
  /** Current values, same format as the chart readout. */
  indicator_readout: Record<string, string>;
  /** Explicit ABOVE/BELOW relation of the last close vs each overlay line. */
  price_vs: Record<string, string>;
  source_url: string;
}

const DEFAULT_SNAPSHOT: Indicator[] = ['ema20', 'ema50', 'ema200', 'rsi', 'macd'];

export const indicatorSnapshotTool: Tool<SnapshotInput, SnapshotOutput> = {
  name: 'indicator_snapshot',
  description:
    'Current indicator VALUES for any Hyperliquid perp (BTC/ETH/SOL/… + builder markets) on a chosen timeframe, WITHOUT drawing a chart: ema20/50/100/200, sma20/50, vwap, bollinger, macd, rsi, fvg. Returns each value plus an explicit "price is ABOVE/BELOW X by N%" relation. Use this BEFORE stating anything about moving averages, RSI, MACD, or price-vs-level relationships in a text answer — never assert those from memory. Defaults to ema20/ema50/ema200 + rsi + macd.',
  inputSchema: {
    type: 'object',
    properties: {
      coin: { type: 'string', description: 'Perp ticker (e.g. "BTC", "HYPE"). No $ prefix.' },
      interval: {
        type: 'string',
        enum: [...INTERVALS],
        description: 'Candle timeframe the claim is about (default "1h").',
      },
      indicators: {
        type: 'array',
        maxItems: 6,
        items: { type: 'string', enum: [...INDICATORS] },
        description: 'Which indicators to compute. Omit for ema20/ema50/ema200 + rsi + macd.',
      },
    },
    required: ['coin'],
  },
  validate: zValidator(SnapshotInputSchema),
  execute: async (input) => {
    return withRetry(
      async () => {
        const interval = input.interval ?? '1h';
        const coin = await resolveCoinName(input.coin);
        if (!coin) throw new Error(`Coin "${input.coin}" not found on Hyperliquid — confirm the ticker.`);
        const all = await fetchCandles(coin, interval);
        if (all.length < 2) throw new Error(`No candle data for ${coin} on ${interval}.`);
        const candles = all.slice(-DISPLAY_COUNT);
        const wanted = [...new Set(input.indicators?.length ? input.indicators : DEFAULT_SNAPSHOT)];
        const { overlays, readout } = buildIndicators(all, candles, wanted);

        const last = candles[candles.length - 1]!;
        const priceVs: Record<string, string> = {};
        for (const ov of overlays) {
          const v = [...ov.points].reverse().find((x) => x != null);
          if (v == null) continue;
          const diffPct = ((last.c - v) / v) * 100;
          priceVs[ov.label] = `price is ${diffPct >= 0 ? 'ABOVE' : 'BELOW'} ${ov.label} by ${Math.abs(diffPct).toFixed(2)}%`;
        }

        const first = candles[0]!;
        return {
          coin,
          interval,
          last_close: last.c,
          window_high: Math.max(...candles.map((c) => c.h)),
          window_low: Math.min(...candles.map((c) => c.l)),
          window_change_pct: Number((((last.c - first.o) / first.o) * 100).toFixed(2)),
          indicator_readout: readout,
          price_vs: priceVs,
          source_url: `https://app.hyperliquid.xyz/trade/${coin}`,
        };
      },
      `indsnap:${input.coin}:${input.interval ?? '1h'}`,
    );
  },
  citation: (_, out) => ({ label: `Hyperliquid candles (${out.coin} ${out.interval})`, url: out.source_url }),
};
