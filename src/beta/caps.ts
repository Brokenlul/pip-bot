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
  // One-time tweet-for-a-week trial extension. extensionDays should match the
  // initial trial length baked into db/migrations/0006_trial.sql.
  trial: { extensionDays: 7 },
  // Fraction of the daily spend cap at which we shed features to flatten cost.
  degradeAtFraction: 0.8,
  alertFractions: [0.5, 0.8, 1.0] as const,
  perRequest: {
    maxToolCalls: 7, // bumped 5→7 (2026-07-24) — shitcoin deep read = scan + 2 web_searches (narrative/deployer) + follow-up
    maxLoopTurns: 3, // #1 silent cost bug: runaway loops
    maxTokens: 1500, // bumped 1100→1500 (2026-07-24) — two-playbook shitcoin reads (ATH + gates + safety + bundles + wallet intel) were truncating at 1100
    degradeMaxTokens: 400, // even tighter once degraded
  },
} as const;
