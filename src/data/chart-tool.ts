import { z } from 'zod';
import { Tool, zValidator } from './registry.js';
import { makeCache, withRetry } from '../core/util.js';
import { hlInfo, resolveCoinName } from './hyperliquid.js';
import { renderCandleChartPng, Candle, ChartLevel } from '../core/candle-chart.js';

/**
 * render_price_chart — draws a Pip-branded candlestick chart (Hyperliquid
 * candles, rendered locally, zero cost) and attaches the PNG to the reply via
 * ToolContext.attachImage. The model gets a small JSON summary back; the image
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
const CANDLE_COUNT = 120;

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
    const start = end - INTERVAL_MS[interval] * (CANDLE_COUNT + 2);
    const raw = await hlInfo<RawCandle[]>({
      type: 'candleSnapshot',
      req: { coin, interval, startTime: start, endTime: end },
    });
    return (raw ?? [])
      .map((r) => ({ t: r.t, o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c), v: Number(r.v) }))
      .slice(-CANDLE_COUNT);
  });
}

export const priceChartTool: Tool<Input, Output> = {
  name: 'render_price_chart',
  description:
    'Draw a branded candlestick chart image (Hyperliquid candles: any standard perp like BTC/ETH/SOL/HYPE/LINK, plus builder markets like TSLA/BOT) and ATTACH it to your reply automatically. Optionally mark up to 6 horizontal levels — entry / stop / target / plain level — each with a price and short label. Use it whenever a user asks to SEE something on a chart ("show me on a chart", "can you chart that", "visualize these levels") or when a picture of the levels you are discussing would land better than prose. The image is attached for you; just refer to it naturally ("chart attached — the $7.62 line is the retest zone"). You CAN render charts — never claim you cannot.',
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
        const candles = await fetchCandles(coin, interval);
        if (candles.length < 2) throw new Error(`No candle data for ${coin} on ${interval}.`);

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

        const png = renderCandleChartPng({
          title: `${coin} · ${interval.toUpperCase()}`,
          subtitle: 'perp · last 120 candles',
          candles,
          levels,
        });
        const filename = `pip-chart-${coin.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${interval}.png`;
        const attached = ctx.attachImage?.(filename, png) ?? false;
        if (!attached) throw new Error('Chart limit for this reply reached — refer to the chart already attached.');

        const first = candles[0]!;
        const last = candles[candles.length - 1]!;
        return {
          chart_attached: true,
          coin,
          interval: interval,
          candles: candles.length,
          window_start_utc: new Date(first.t).toISOString(),
          last_close: last.c,
          window_high: hi,
          window_low: lo,
          window_change_pct: Number((((last.c - first.o) / first.o) * 100).toFixed(2)),
          levels_drawn: levels.length,
          levels_skipped: skipped,
          source_url: `https://app.hyperliquid.xyz/trade/${coin}`,
        };
      },
      `chart:${input.coin}:${input.interval ?? '1h'}`,
    );
  },
  citation: (_, out) => ({ label: `Hyperliquid candles (${out.coin} ${out.interval})`, url: out.source_url }),
};
