import { z } from 'zod';
import { Tool, zValidator } from './registry.js';
import { makeCache, fetchWithTimeout } from '../core/util.js';

/**
 * Free, keyless historical OHLC via Binance's public spot klines endpoint —
 * lets Pip actually BACKTEST a trader's claim/framework against real price
 * history instead of eyeballing a chart or declining ("I don't have OHLC
 * access"). Years of raw candles are too much to hand the model directly
 * (context + cost), so this compresses each symbol's history down to its
 * swing high/low pivots — the same primitive a trader would mark by hand —
 * and lets the model reason over THAT (compare BTC vs an alt's swing
 * sequence, check hit-rates, etc.) rather than hardcoding any one framework
 * (divergence, support/resistance, …) into the tool itself.
 */

const BINANCE_KLINES_URL = 'https://api.binance.com/api/v3/klines';
const BINANCE_LIMIT = 1000; // Binance's per-request cap
const MAX_CANDLES_PER_SYMBOL = 6000; // bounds latency/cost; honestly reported when it truncates
const MAX_SWINGS_RETURNED = 80; // most-recent-first cap per symbol

const INTERVAL_MS: Record<string, number> = {
  '1h': 3_600_000,
  '4h': 4 * 3_600_000,
  '1d': 24 * 3_600_000,
  '1w': 7 * 24 * 3_600_000,
};

const SYMBOL_RE = /^\$?[A-Za-z0-9]{1,10}$/;
const InputSchema = z.object({
  symbols: z
    .array(z.string().trim().refine((s) => SYMBOL_RE.test(s), { message: 'Not a plausible ticker.' }))
    .min(1)
    .max(4)
    .describe('Ticker symbols to check, e.g. ["BTC","ETH","SOL"] — matched against Binance USDT pairs.'),
  interval: z.enum(['1h', '4h', '1d', '1w']).optional().describe('Candle interval (default 4h).'),
  lookback_days: z
    .number()
    .int()
    .min(7)
    .max(1095)
    .optional()
    .describe('How far back to look, in days (default 365, max ~3 years).'),
  pivot_strength: z
    .number()
    .int()
    .min(2)
    .max(10)
    .optional()
    .describe('Candles required on both sides to confirm a swing point (default 3). Higher = fewer, more significant swings.'),
});
type Input = z.infer<typeof InputSchema>;

interface RawCandle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface SwingPoint {
  time_iso: string;
  type: 'high' | 'low';
  price: number;
}

interface SymbolResult {
  symbol: string;
  pair: string;
  interval: string;
  from_iso: string;
  to_iso: string;
  candles_covered: number;
  current_price: number;
  swings: SwingPoint[];
  swings_truncated: boolean; // more swings existed than MAX_SWINGS_RETURNED — only the most recent are shown
  history_truncated: boolean; // requested lookback exceeded MAX_CANDLES_PER_SYMBOL — actual coverage is shorter
}

interface Output {
  interval: string;
  pivot_strength: number;
  results: SymbolResult[];
  errors: { symbol: string; message: string }[];
}

async function fetchPage(pair: string, interval: string, startMs: number, endMs: number): Promise<RawCandle[]> {
  const url = `${BINANCE_KLINES_URL}?symbol=${pair}&interval=${interval}&startTime=${startMs}&endTime=${endMs}&limit=${BINANCE_LIMIT}`;
  const res = await fetchWithTimeout(url, {}, 10_000);
  if (res.status === 400) throw new Error(`unknown symbol/pair ${pair}`);
  if (!res.ok) throw new Error(`binance klines ${res.status}`);
  const rows = (await res.json()) as unknown[][];
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => ({
    openTime: Number(r[0]),
    open: Number(r[1]),
    high: Number(r[2]),
    low: Number(r[3]),
    close: Number(r[4]),
  }));
}

async function fetchCandles(
  pair: string,
  interval: string,
  requestedStartMs: number,
  endMs: number,
): Promise<{ candles: RawCandle[]; truncated: boolean }> {
  const intervalMs = INTERVAL_MS[interval]!;
  const cappedStartMs = Math.max(requestedStartMs, endMs - MAX_CANDLES_PER_SYMBOL * intervalMs);
  const truncated = cappedStartMs > requestedStartMs;
  const totalCandles = Math.max(1, Math.ceil((endMs - cappedStartMs) / intervalMs));
  const pages = Math.ceil(totalCandles / BINANCE_LIMIT);
  const windowMs = BINANCE_LIMIT * intervalMs;

  const pageResults = await Promise.all(
    Array.from({ length: pages }, (_, i) => {
      const wStart = cappedStartMs + i * windowMs;
      const wEnd = Math.min(endMs, wStart + windowMs - 1);
      return fetchPage(pair, interval, wStart, wEnd);
    }),
  );
  const candles = pageResults.flat().sort((a, b) => a.openTime - b.openTime);
  return { candles, truncated };
}

/** Classic fractal pivot: a candle is a swing high/low when its high/low is
 * the extreme among `strength` candles on both sides. */
function findSwings(candles: RawCandle[], strength: number): { time: number; type: 'high' | 'low'; price: number }[] {
  const out: { time: number; type: 'high' | 'low'; price: number }[] = [];
  for (let i = strength; i < candles.length - strength; i++) {
    const c = candles[i]!;
    let isHigh = true;
    let isLow = true;
    for (let k = i - strength; k <= i + strength; k++) {
      if (k === i) continue;
      const o = candles[k]!;
      if (o.high >= c.high) isHigh = false;
      if (o.low <= c.low) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) out.push({ time: c.openTime, type: 'high', price: c.high });
    if (isLow) out.push({ time: c.openTime, type: 'low', price: c.low });
  }
  return out;
}

const cache = makeCache<Output>(30 * 60_000); // history is static except the newest forming candle

export const historicalSwingsTool: Tool<Input, Output> = {
  name: 'historical_swings',
  description:
    "Backtest a trader's claim or framework against REAL historical price data (free, from Binance spot candles) — use this whenever someone asks you to backtest, verify 'is this true historically', or answer 'what happened last time X' for crypto assets. Returns each symbol's swing high/low pivots (the same points a trader would mark by hand) over the requested lookback, compressed from raw candles so you can compare sequences across symbols (e.g. did an alt hold a higher low while BTC made a lower low), count how often a pattern held, and cite real dates/prices — never eyeball or fabricate this from memory.",
  inputSchema: {
    type: 'object',
    properties: {
      symbols: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        maxItems: 4,
        description: 'Ticker symbols, e.g. ["BTC","ETH","SOL"].',
      },
      interval: { type: 'string', enum: ['1h', '4h', '1d', '1w'], description: 'Candle interval (default 4h).' },
      lookback_days: { type: 'integer', description: 'How far back to look, in days (default 365, max ~1095).' },
      pivot_strength: {
        type: 'integer',
        description: 'Candles required on both sides to confirm a swing point (default 3; higher = fewer/bigger swings).',
      },
    },
    required: ['symbols'],
  },
  validate: zValidator(InputSchema),
  execute: async (input) => {
    const interval = input.interval ?? '4h';
    const lookbackDays = input.lookback_days ?? 365;
    const strength = input.pivot_strength ?? 3;
    const symbols = [...new Set(input.symbols.map((s) => s.replace(/^\$/, '').toUpperCase()))];
    const cacheKey = `${symbols.join(',')}:${interval}:${lookbackDays}:${strength}`;

    return cache.wrap(cacheKey, async () => {
      const endMs = Date.now();
      const startMs = endMs - lookbackDays * 24 * 3_600_000;

      const errors: { symbol: string; message: string }[] = [];
      const results: SymbolResult[] = [];

      await Promise.all(
        symbols.map(async (symbol) => {
          const pair = `${symbol}USDT`;
          try {
            const { candles, truncated } = await fetchCandles(pair, interval, startMs, endMs);
            if (candles.length === 0) throw new Error('no candle data returned');
            const rawSwings = findSwings(candles, strength);
            const swingsTruncated = rawSwings.length > MAX_SWINGS_RETURNED;
            const swings: SwingPoint[] = rawSwings.slice(-MAX_SWINGS_RETURNED).map((s) => ({
              time_iso: new Date(s.time).toISOString(),
              type: s.type,
              price: s.price,
            }));
            results.push({
              symbol,
              pair,
              interval,
              from_iso: new Date(candles[0]!.openTime).toISOString(),
              to_iso: new Date(candles[candles.length - 1]!.openTime).toISOString(),
              candles_covered: candles.length,
              current_price: candles[candles.length - 1]!.close,
              swings,
              swings_truncated: swingsTruncated,
              history_truncated: truncated,
            });
          } catch (e) {
            errors.push({ symbol, message: (e as Error).message });
          }
        }),
      );

      return { interval, pivot_strength: strength, results, errors };
    });
  },
  citation: () => ({
    label: 'Binance historical candles',
    url: 'https://www.binance.com/en/trade',
  }),
};
