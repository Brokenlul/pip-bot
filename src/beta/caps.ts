/**
 * Beta guardrail constants. Per-user caps make the beta fair; the global daily
 * kill-switch makes it safe; the allowlist makes it yours. Spend caps live in
 * env (config.ts) so they can be tuned without a deploy; the rest are here.
 */
export const CAPS = {
  perUser: {
    cooldownMs: 20_000, // kills spam bursts & double-fires
    maxQuestionLen: 500, // bounds input tokens
  },
  // No per-member ceiling within a server. One existed briefly (8/day,
  // 2026-07-24 to 2026-07-27) but it bounded nothing the guild's own daily and
  // total caps didn't already bound, while being the limit that bit first on
  // real usage. See the note in guardrails.ts betaGate.
  // One-time tweet-for-a-week trial extension. extensionDays should match the
  // initial trial length baked into db/migrations/0006_trial.sql.
  trial: { extensionDays: 7 },
  // Fraction of the daily spend cap at which we shed features to flatten cost.
  degradeAtFraction: 0.8,
  alertFractions: [0.5, 0.8, 1.0] as const,
  perRequest: {
    maxToolCalls: 7, // bumped 5→7 (2026-07-24) — shitcoin deep read = scan + 2 web_searches (narrative/deployer) + follow-up
    maxLoopTurns: 3, // #1 silent cost bug: runaway loops
    maxTokens: 1500, // DEEP tier. bumped 1100→1500 (2026-07-24) — two-playbook shitcoin reads (ATH + gates + safety + bundles + wallet intel) were truncating at 1100
    // 2026-07-30: output token count is the dominant cost/latency driver (near-
    // linear — ~6s avg under 200 output tokens vs ~51s avg around 1900), and
    // 57% of turns ran 400-1000+ tokens even on asks the system prompt's own
    // "match depth to the ask" rule calls SIMPLE/STANDARD. These are a hard
    // backstop per src/core/route.ts classifyDepth, tuned so 'simple' stays
    // comfortably under the <10s P95 target and 'standard' cuts the heavy tail
    // without touching genuinely deep reads (still 1500 above).
    simpleMaxTokens: 220,
    standardMaxTokens: 550,
    degradeMaxTokens: 400, // even tighter once degraded — overrides depth tier entirely
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

/**
 * Per-day feature sub-caps (2026-07-30 rebalance). Previously a single flat
 * CAPS.perUser applied identically to every tier; that guarded the wrong
 * lever — web_search measured at 2.6x the overall median cost while
 * token_scan/vision sat near-median but were capped just as tight. Now tiered:
 * web_search tightened, token_scan/vision loosened, roughly in proportion to
 * measured cost. Trial is deliberately UNCHANGED (still the old flat 5/10/5) —
 * not part of this rebalance. Elite is left uncapped, mirroring its existing
 * uncapped daily message cap; real Elite customization is a manual/custom
 * case, not something to hardcode here.
 */
export interface SubCaps {
  webSearches: number;
  scans: number; // token_scan
  vision: number; // image-upload analysis only, NOT render_price_chart
}

export const SUB_CAPS: Record<string, SubCaps> = {
  'personal-lite': { webSearches: 3, scans: 10, vision: 8 },
  'personal-pro': { webSearches: 4, scans: 15, vision: 12 },
  'server-pro': { webSearches: 8, scans: 30, vision: 20 },
  elite: { webSearches: Number.POSITIVE_INFINITY, scans: Number.POSITIVE_INFINITY, vision: Number.POSITIVE_INFINITY },
};

// Free trial (both personal + server) — unchanged, same numbers as the old flat CAPS.perUser.
export const TRIAL_SUB_CAPS: SubCaps = { webSearches: 5, scans: 10, vision: 5 };
