import { Candle } from './candle-chart.js';

/**
 * Indicator math for Pip's rendered charts. Pure functions over OHLCV — every
 * output array is aligned 1:1 with the input candles (null during warm-up), so
 * the renderer can plot them directly and the tool can slice the display
 * window without re-indexing.
 */

export type Series = (number | null)[];

export function sma(values: number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values: number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  if (values.length < period) return out;
  // Seed with the SMA of the first `period` values (standard convention).
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function rsi(closes: number[], period = 14): Series {
  const out: Series = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i]! - closes[i - 1]!;
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = 100 - 100 / (1 + (avgLoss === 0 ? Infinity : avgGain / avgLoss));
  // Wilder smoothing from here on.
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export interface MacdResult {
  macd: Series;
  signal: Series;
  hist: Series;
}

export function macd(closes: number[], fast = 12, slow = 26, signalP = 9): MacdResult {
  const fastE = ema(closes, fast);
  const slowE = ema(closes, slow);
  const line: Series = closes.map((_, i) =>
    fastE[i] != null && slowE[i] != null ? fastE[i]! - slowE[i]! : null,
  );
  // Signal = EMA of the MACD line, computed over its non-null tail.
  const start = line.findIndex((v) => v != null);
  const signal: Series = new Array(closes.length).fill(null);
  if (start >= 0) {
    const tail = ema(line.slice(start) as number[], signalP);
    for (let i = 0; i < tail.length; i++) signal[start + i] = tail[i] ?? null;
  }
  const hist: Series = line.map((v, i) => (v != null && signal[i] != null ? v - signal[i]! : null));
  return { macd: line, signal, hist };
}

/** VWAP anchored at the start of the array (the visible window's open). */
export function vwap(candles: Candle[]): Series {
  const out: Series = new Array(candles.length).fill(null);
  let pv = 0;
  let vol = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!;
    const tp = (c.h + c.l + c.c) / 3;
    pv += tp * c.v;
    vol += c.v;
    out[i] = vol > 0 ? pv / vol : null;
  }
  return out;
}

export interface BollingerResult {
  upper: Series;
  mid: Series;
  lower: Series;
}

export function bollinger(closes: number[], period = 20, mult = 2): BollingerResult {
  const mid = sma(closes, period);
  const upper: Series = new Array(closes.length).fill(null);
  const lower: Series = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    const m = mid[i]!;
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += (closes[j]! - m) ** 2;
    const sd = Math.sqrt(s / period);
    upper[i] = m + mult * sd;
    lower[i] = m - mult * sd;
  }
  return { upper, mid, lower };
}

/**
 * Fair value gaps — the objective piece of the SMC toolkit. Bullish FVG at i:
 * low[i] gaps above high[i-2]; bearish mirrored. A zone counts as filled once
 * a later candle trades fully through it.
 */
export interface Fvg {
  index: number; // candle where the gap completed
  top: number;
  bottom: number;
  bullish: boolean;
  filled: boolean;
}

export function fvgZones(candles: Candle[], minGapFrac = 0.001): Fvg[] {
  const zones: Fvg[] = [];
  for (let i = 2; i < candles.length; i++) {
    const a = candles[i - 2]!;
    const c = candles[i]!;
    if (c.l > a.h && (c.l - a.h) / a.h >= minGapFrac) {
      zones.push({ index: i, top: c.l, bottom: a.h, bullish: true, filled: false });
    } else if (c.h < a.l && (a.l - c.h) / a.l >= minGapFrac) {
      zones.push({ index: i, top: a.l, bottom: c.h, bullish: false, filled: false });
    }
  }
  for (const z of zones) {
    for (let i = z.index + 1; i < candles.length; i++) {
      const c = candles[i]!;
      if (z.bullish ? c.l <= z.bottom : c.h >= z.top) {
        z.filled = true;
        break;
      }
    }
  }
  return zones;
}
