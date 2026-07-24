import { getConfig } from '../config.js';

/**
 * Conservative model routing (unlocked 2026-07-24, DISABLED BY DEFAULT
 * 2026-07-24 after a live regression). Sends only unambiguously simple asks to
 * the cheap model; everything else stays on the strong model.
 *
 * Why it ships off: on the day it landed, "When is the next fed meeting" routed
 * to Haiku, which answered "July 30-31, 2026" with `tools_used: []` — it never
 * called next_fomc_meeting, whose hardcoded (correct) answer is July 28-29 with
 * the decision on July 29. tool_choice is "auto" on this path, so nothing forces
 * a deterministic tool call, and the cheap model happily answers dates from
 * parametric memory. Sonnet had answered the same question correctly twice.
 *
 * It also failed to save money. Prompt caching is keyed per-model, so Haiku
 * cannot read Sonnet's ~29.5k cached system prompt: that turn logged
 * cache_read 0 + cache_write 29571 and cost $0.0378, versus $0.0115-$0.0121 for
 * comparable Sonnet turns reading a warm cache. Haiku's share of traffic is far
 * too small to keep its own cache warm, so the fast-path cold-writes almost
 * every time and lands ~3x above the model it was meant to undercut.
 *
 * Re-enabling requires SIMPLE_ROUTING_ENABLED=true AND a fix for the missing
 * tool call (force tool_choice for the matched intent, or verify against
 * usage_log.tools_used that the cheap model actually calls the tool).
 *
 * No extra LLM call — pure keyword/shape heuristic, so it adds no latency/cost.
 */

const SIMPLE_MAX_LEN = 120;

// Any of these forces the strong model — they signal a read, not a lookup.
const COMPLEX_RE =
  /\b(should|shall|would|long|longs?|short|shorts?|buy|sell|ape|aping|punt|thesis|scan|bundl|honeypot|rug|is it safe|why|because|compare|compared|versus|vs|outlook|forecast|predict|analy|read|thoughts|opinion|explain|breakdown|deep|order.?flow|footprint|funding|open interest|\boi\b|cvd|delta|profile|backtest|narrative|smart money|catalyst|target|entry|invalidation|risk|worth it|good buy|dump|moon|send it)\b/i;

// Known-simple intents Haiku handles reliably (deterministic tools behind them).
const PRICE_RE = /\b(price|worth|cost|how much|market ?cap|mcap|ath)\b/i;

// Calendar/next-event asks are deliberately NOT here. They are the exact shape
// the cheap model answers from memory instead of calling the (free, hardcoded)
// calendar tool, and a confidently wrong date is worse than a slower right one.
const CALENDAR_RE = /\bnext\b[^?]*\b(fomc|fed|cpi|meeting|rate decision|release|print)\b/i;

/** True only when the ask is short, clean, and a known-simple intent. */
export function isSimpleAsk(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > SIMPLE_MAX_LEN) return false;
  if (COMPLEX_RE.test(t)) return false;
  if (CALENDAR_RE.test(t)) return false;
  return PRICE_RE.test(t);
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
  // Off unless explicitly enabled. Checked before the model comparison so a
  // stale SIMPLE_ANSWER_MODEL left in the deploy env cannot resurrect routing.
  if (!cfg.SIMPLE_ROUTING_ENABLED) return cfg.ANSWER_MODEL;
  const simple = cfg.SIMPLE_ANSWER_MODEL;
  // Routing is off unless a distinct cheap model is configured.
  if (!simple || simple === cfg.ANSWER_MODEL) return cfg.ANSWER_MODEL;
  // Context-dependent turns always get the strong model.
  if (opts.hasImages || opts.threadLen > 0 || opts.isReply) return cfg.ANSWER_MODEL;
  return isSimpleAsk(opts.text) ? simple : cfg.ANSWER_MODEL;
}
