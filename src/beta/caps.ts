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
  // Per-user ceiling WITHIN a server (2026-07-24). Server plans are a shared
  // guild allowance; this stops one member draining it (and bounds spam in a
  // free/comped community). Applies on top of the guild's plan cap.
  perGuildUser: {
    dailyMsgs: 8,
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

/**
 * Plan caps (2026-07-24). Personal plans are enforced PER USER (in DMs); server
 * plans PER GUILD (shared across the server). A trial has a hard TOTAL cap across
 * the 7-day window on top of the daily cap, to bound worst-case trial cost.
 * `monthly`/`trialTotal` of null = not applied. daily === Infinity = uncapped.
 */
export interface PlanCaps {
  label: string;
  daily: number;
  monthly: number | null;
  trialTotal: number | null;
}

// Free 7-day trials (no active subscription). Context decides which one applies.
export const TRIAL_PERSONAL: PlanCaps = { label: 'free trial', daily: 12, monthly: null, trialTotal: 60 };
export const TRIAL_SERVER: PlanCaps = { label: 'server trial', daily: 25, monthly: null, trialTotal: 125 };

// Paid plans, keyed by beta_testers.tier (personal) / guilds.server_tier (server).
export const PLAN_CAPS: Record<string, PlanCaps> = {
  'personal-lite': { label: 'Lite', daily: 15, monthly: 250, trialTotal: null },
  'personal-pro': { label: 'Personal Pro', daily: 15, monthly: 250, trialTotal: null },
  'server-pro': { label: 'Server Pro', daily: 40, monthly: 450, trialTotal: null },
  elite: { label: 'Elite', daily: Number.POSITIVE_INFINITY, monthly: null, trialTotal: null },
};

export const TRIAL_DAYS = 7;
