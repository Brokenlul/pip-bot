/**
 * Beta guardrail constants. Per-user caps make the beta fair; the global daily
 * kill-switch makes it safe; the allowlist makes it yours. Spend caps live in
 * env (config.ts) so they can be tuned without a deploy; the rest are here.
 */
export const CAPS = {
  perUser: {
    webSearches: 5, // $0.01 each + big token fan-out
    vision: 5, // vision = expensive input tokens
    scans: 10, // token_scan multi-tool fan-out, priciest text call
    cooldownMs: 20_000, // kills spam bursts & double-fires
    maxQuestionLen: 500, // bounds input tokens
  },
  // Fraction of the daily spend cap at which we shed features to flatten cost.
  degradeAtFraction: 0.8,
  alertFractions: [0.5, 0.8, 1.0] as const,
  perRequest: {
    maxToolCalls: 5, // stop runaway agent fan-out
    maxLoopTurns: 3, // #1 silent cost bug: runaway loops
    maxTokens: 700, // answers are chat-sized by design
    degradeMaxTokens: 400, // even tighter once degraded
  },
} as const;
