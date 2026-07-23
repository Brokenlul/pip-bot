import { getConfig } from '../config.js';

/**
 * Conservative model routing (unlocked 2026-07-24). Sends only unambiguously
 * simple asks to the cheap model; everything else stays on the strong model.
 * A mis-route to Haiku degrades the answer, so the bar for "simple" is high:
 * short, no image, not a follow-up in an active thread, no analysis/trade words,
 * and it must positively match a known-simple intent (price or next-event).
 *
 * No extra LLM call — pure keyword/shape heuristic, so it adds no latency/cost.
 */

const SIMPLE_MAX_LEN = 120;

// Any of these forces the strong model — they signal a read, not a lookup.
const COMPLEX_RE =
  /\b(should|shall|would|long|longs?|short|shorts?|buy|sell|ape|aping|punt|thesis|scan|bundl|honeypot|rug|is it safe|why|because|compare|compared|versus|vs|outlook|forecast|predict|analy|read|thoughts|opinion|explain|breakdown|deep|order.?flow|footprint|funding|open interest|\boi\b|cvd|delta|profile|backtest|narrative|smart money|catalyst|target|entry|invalidation|risk|worth it|good buy|dump|moon|send it)\b/i;

// Known-simple intents Haiku handles reliably (deterministic tools behind them).
const PRICE_RE = /\b(price|worth|cost|how much|market ?cap|mcap|ath)\b/i;
const NEXT_EVENT_RE = /\bnext\b[^?]*\b(fomc|fed|cpi|meeting|rate decision|release|print)\b/i;

/** True only when the ask is short, clean, and a known-simple intent. */
export function isSimpleAsk(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > SIMPLE_MAX_LEN) return false;
  if (COMPLEX_RE.test(t)) return false;
  return PRICE_RE.test(t) || NEXT_EVENT_RE.test(t);
}

/**
 * Choose the model for this turn. Falls back to the strong model whenever
 * routing is disabled, context is present (image / active thread / reply), or
 * the ask isn't a clean simple intent.
 */
export function pickAnswerModel(opts: {
  text: string;
  hasImages: boolean;
  threadLen: number;
  isReply: boolean;
}): string {
  const cfg = getConfig();
  const simple = cfg.SIMPLE_ANSWER_MODEL;
  // Routing is off unless a distinct cheap model is configured.
  if (!simple || simple === cfg.ANSWER_MODEL) return cfg.ANSWER_MODEL;
  // Context-dependent turns always get the strong model.
  if (opts.hasImages || opts.threadLen > 0 || opts.isReply) return cfg.ANSWER_MODEL;
  return isSimpleAsk(opts.text) ? simple : cfg.ANSWER_MODEL;
}
