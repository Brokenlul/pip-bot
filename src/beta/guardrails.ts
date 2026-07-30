import { createHash } from 'node:crypto';
import { getDb } from '../memory/db.js';
import { getConfig, betaModeEnabled, csvSet } from '../config.js';
import { NormalizedMessage } from '../adapters/platform.js';
import {
  CAPS,
  PLAN_CAPS,
  SUB_CAPS,
  TRIAL_SUB_CAPS,
  TRIAL_PERSONAL,
  TRIAL_SERVER,
  TRIAL_DAYS,
  type PlanCaps,
  type SubCaps,
} from './caps.js';

// ---- Cost model ($/1M tokens) ---------------------------------------------
// Cache read is ~0.1x input; cache write ~1.25x. Web search is ~$10 / 1,000.
// Model-aware since the Haiku fast-path (2026-07-24): logging the wrong prices
// for a Haiku answer would overstate spend and skew the kill-switch.
const PRICE_SONNET = { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 };
const PRICE_HAIKU = { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 };
const WEB_SEARCH_USD = 0.01;

function priceFor(model: string | undefined): typeof PRICE_SONNET {
  return model && /haiku/i.test(model) ? PRICE_HAIKU : PRICE_SONNET;
}

// Exact-match cache freshness. Short by design: it dedupes a burst of the same
// question without ever serving a stale price/funding read. The daily bucket in
// the table key just bounds row growth — freshness is enforced here.
const EXACT_CACHE_TTL_MS = 120_000;

export interface UsageTotals {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
}

export function computeCostUsd(u: UsageTotals, webSearches: number, model?: string): number {
  const price = priceFor(model);
  const t =
    u.input_tokens * price.input +
    u.cache_creation_input_tokens * price.cacheWrite +
    u.cache_read_input_tokens * price.cacheRead +
    u.output_tokens * price.output;
  return t / 1e6 + webSearches * WEB_SEARCH_USD;
}

/** Normalize a question for the free exact-match cache (lowercase, collapse ws). */
export function normalizeQuestion(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, ' ');
}
export function questionHash(q: string): string {
  return createHash('sha256').update(normalizeQuestion(q)).digest('hex').slice(0, 32);
}

function dayStartUtc(): Date {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

// ---- Persistence -----------------------------------------------------------

export interface UsageLogRow {
  platform: string;
  guildId: string;
  userId: string;
  questionHash: string;
  usage: UsageTotals;
  webSearches: number;
  hadVision: boolean;
  toolsUsed: string[];
  costUsd: number;
  latencyMs: number;
  degraded: boolean;
  cacheHit: boolean;
  failed: boolean;
  /** Why a failed turn failed ("timeout" or "<kind>[:<status>][:<error_type>] <message>"), truncated to 500 chars. */
  errorDetail?: string;
  /** 'simple' | 'standard' | 'deep' (src/core/route.ts classifyDepth) — lets the
   *  admin dashboard track the cost/latency targets against simple/standard
   *  traffic separately from genuinely deep reads that legitimately run long. */
  askDepth?: string;
}

/** Fire-and-forget write of one request's usage + cost. Never throws. */
export async function logUsage(row: UsageLogRow): Promise<void> {
  const db = getDb();
  if (!db) return;
  await db
    .from('usage_log')
    .insert({
      platform: row.platform,
      guild_id: row.guildId,
      user_id: row.userId,
      question_hash: row.questionHash,
      input_tokens: row.usage.input_tokens,
      cache_write_tokens: row.usage.cache_creation_input_tokens,
      cache_read_tokens: row.usage.cache_read_input_tokens,
      output_tokens: row.usage.output_tokens,
      web_searches: row.webSearches,
      had_vision: row.hadVision,
      tools_used: row.toolsUsed,
      cost_usd: Number(row.costUsd.toFixed(5)),
      latency_ms: row.latencyMs,
      degraded: row.degraded,
      cache_hit: row.cacheHit,
      failed: row.failed,
      error_detail: row.errorDetail ?? null,
      ask_depth: row.askDepth ?? null,
    })
    .throwOnError();
}

export interface SafetyEventRow {
  platform: string;
  guildId: string;
  userId: string;
  /** Which backstop fired: a hard-blocked prompt-leak, or a logged signal-language slip. */
  kind: 'prompt_leak' | 'signal_language' | 'injection_attempt';
  /** The matched snippets (signal_language) or a short note; omit for prompt_leak. */
  detail?: string;
  questionHash?: string;
}

/** Fire-and-forget durable record of a security backstop firing. The ephemeral
 *  console.warn in agent.ts stays for local dev; this makes the same events
 *  queryable from Supabase instead of lost when Railway's console log rotates.
 *  Never throws. */
export async function logSafetyEvent(row: SafetyEventRow): Promise<void> {
  const db = getDb();
  if (!db) return;
  await db
    .from('safety_event')
    .insert({
      platform: row.platform,
      guild_id: row.guildId,
      user_id: row.userId,
      kind: row.kind,
      detail: row.detail ?? null,
      question_hash: row.questionHash ?? null,
    })
    .throwOnError();
}

export interface GateEventRow {
  platform: string;
  guildId: string;
  userId: string;
  gateType: string;
  capValue?: number | null;
}

/** Fire-and-forget durable record of a betaGate block or feature-degrade firing.
 *  Console logging (blockedSilent) stays for local dev; this makes cap-hits
 *  queryable from Supabase as a willingness-to-pay signal. Never throws. */
export async function logGateEvent(row: GateEventRow): Promise<void> {
  const db = getDb();
  if (!db) return;
  await db
    .from('gate_event')
    .insert({
      platform: row.platform,
      guild_id: row.guildId,
      user_id: row.userId,
      gate_type: row.gateType,
      cap_value: row.capValue ?? null,
    })
    .throwOnError();
}

/** Record a 👍/👎 on one of Pip's answers (one vote per user per message). */
export async function recordFeedback(opts: {
  platform: string;
  guildId: string;
  messageId: string;
  raterId: string;
  rating: 'up' | 'down';
}): Promise<void> {
  const db = getDb();
  if (!db) return;
  await db
    .from('feedback')
    .upsert(
      {
        platform: opts.platform,
        guild_id: opts.guildId,
        message_id: opts.messageId,
        rater_id: opts.raterId,
        rating: opts.rating,
      },
      { onConflict: 'platform,message_id,rater_id' },
    )
    .throwOnError();
}

interface TodayRow {
  user_id: string;
  guild_id: string;
  cost_usd: number;
  web_searches: number;
  had_vision: boolean;
  tools_used: string[];
}

async function todayUsage(): Promise<TodayRow[]> {
  const db = getDb();
  if (!db) return [];
  const { data, error } = await db
    .from('usage_log')
    .select('user_id, guild_id, cost_usd, web_searches, had_vision, tools_used')
    .gte('created_at', dayStartUtc().toISOString());
  if (error) {
    console.warn(`[beta] todayUsage: ${error.message}`);
    return [];
  }
  return (data ?? []) as TodayRow[];
}

function monthStartUtc(): Date {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

interface GuildPlan {
  server_tier: string | null;
  server_access_until: string | null;
  created_at: string | null;
}

/** Per-guild plan state (Server Pro). Null when the guild row isn't found. */
async function getGuildPlan(guildId: string): Promise<GuildPlan | null> {
  const db = getDb();
  if (!db) return null;
  const { data, error } = await db
    .from('guilds')
    .select('server_tier, server_access_until, created_at')
    .eq('id', guildId)
    .limit(1);
  if (error) {
    console.warn(`[beta] getGuildPlan: ${error.message}`);
    return null;
  }
  return (data?.[0] as GuildPlan | undefined) ?? null;
}

/**
 * Count usage_log rows for one scope (a user OR a guild), optionally since a
 * timestamp. Used for the monthly cap (since month start) and the trial total
 * (no lower bound — a trial scope's rows are all within its 7-day window).
 * head:true keeps it a cheap COUNT with no row transfer.
 */
async function usageCountForScope(
  scope: { user_id: string } | { guild_id: string },
  sinceIso?: string,
): Promise<number> {
  const db = getDb();
  if (!db) return 0;
  const [col, val] = 'user_id' in scope ? ['user_id', scope.user_id] : ['guild_id', scope.guild_id];
  let q = db.from('usage_log').select('id', { count: 'exact', head: true }).eq(col, val);
  if (sinceIso) q = q.gte('created_at', sinceIso);
  const { count, error } = await q;
  if (error) {
    console.warn(`[beta] usageCountForScope: ${error.message}`);
    return 0;
  }
  return count ?? 0;
}

/** The slice of a beta_testers row the gate needs (trial window + plan). */
interface TesterRow {
  access_until: string | null;
  tier?: string | null;
  subscription_status?: string | null;
}
const TESTER_COLS = 'access_until, tier, subscription_status';

async function getTester(platform: string, platformId: string): Promise<TesterRow | null> {
  const db = getDb();
  if (!db) return null;
  const { data, error } = await db
    .from('beta_testers')
    .select(TESTER_COLS)
    .eq('platform', platform)
    .eq('platform_id', platformId)
    .limit(1);
  if (error) {
    console.warn(`[beta] getTester: ${error.message}`);
    return null;
  }
  return (data?.[0] as TesterRow | undefined) ?? null;
}

/** The wider slice needed to merge a paid grant onto an existing row. */
interface HandleRow extends TesterRow {
  tier: string | null;
  subscription_provider: string | null;
  subscription_id: string | null;
  subscription_status: string | null;
}
const HANDLE_COLS =
  'access_until, tier, subscription_provider, subscription_id, subscription_status';

/** The later of two access_until values; 'infinity'/unparseable (never lapses) wins. */
function laterAccess(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  const ta = new Date(a).getTime();
  const tb = new Date(b).getTime();
  if (!Number.isFinite(ta)) return a;
  if (!Number.isFinite(tb)) return b;
  return ta >= tb ? a : b;
}

/**
 * Claim a pending row keyed by the user's `@handle` (their numeric id is
 * unknowable until they message Pip). Two things land keyed this way:
 *   - a Telegram whitelist invite, and
 *   - a PAID checkout grant written by the pip-site webhooks (either platform).
 *
 * If the user has no numeric row yet, rekey the handle row to their id. If they
 * already have one (e.g. a trial user who just paid), merge the grant in — take
 * the later access_until + the subscription fields — and drop the handle row.
 * Returns the effective row, or `existing` when there's nothing to claim.
 */
async function claimHandleRow(
  msg: NormalizedMessage,
  existing: TesterRow | null,
): Promise<TesterRow | null> {
  if (!msg.userName) return existing;
  const db = getDb();
  if (!db) return existing;
  const handle = `@${msg.userName.toLowerCase()}`;

  const { data, error } = await db
    .from('beta_testers')
    .select(HANDLE_COLS)
    .eq('platform', msg.platform)
    .eq('platform_id', handle)
    .limit(1);
  if (error) {
    console.warn(`[beta] claimHandleRow lookup: ${error.message}`);
    return existing;
  }
  const hr = data?.[0] as HandleRow | undefined;
  if (!hr) return existing;

  // No numeric row → rekey the handle row to the id (fast path forever after).
  if (!existing) {
    const { data: up, error: e2 } = await db
      .from('beta_testers')
      .update({ platform_id: msg.userId, name: msg.userName })
      .eq('platform', msg.platform)
      .eq('platform_id', handle)
      .select(TESTER_COLS);
    if (e2) {
      console.warn(`[beta] claimHandleRow rekey: ${e2.message}`);
      return existing;
    }
    const claimed = (up?.[0] as TesterRow | undefined) ?? null;
    if (claimed) console.log(`[beta] ${msg.platform} ${handle} claimed by id ${msg.userId}`);
    return claimed ?? existing;
  }

  // Numeric row exists → merge the grant into it, then remove the handle row.
  const merged = laterAccess(existing.access_until, hr.access_until);
  const patch: Record<string, unknown> = { access_until: merged };
  if (hr.subscription_provider) {
    patch.tier = hr.tier;
    patch.subscription_provider = hr.subscription_provider;
    patch.subscription_id = hr.subscription_id;
    patch.subscription_status = hr.subscription_status;
  }
  const { error: e3 } = await db
    .from('beta_testers')
    .update(patch)
    .eq('platform', msg.platform)
    .eq('platform_id', msg.userId);
  if (e3) {
    console.warn(`[beta] claimHandleRow merge: ${e3.message}`);
    return existing;
  }
  await db
    .from('beta_testers')
    .delete()
    .eq('platform', msg.platform)
    .eq('platform_id', handle);
  console.log(
    `[beta] merged ${hr.subscription_provider ?? 'invite'} grant into ${msg.platform}:${msg.userId}`,
  );
  return { access_until: merged };
}

/**
 * First-touch enrollment on any surface, DMs included. Idempotent (PK upsert).
 *
 * `created` distinguishes a genuine first touch from a repeat, which is what
 * lets an adapter greet a new arrival exactly once. With ignoreDuplicates a
 * returned row means the INSERT really happened; no row means we raced an
 * existing one, so we re-read and report created:false.
 */
async function autoEnroll(
  platform: string,
  platformId: string,
  name?: string,
): Promise<{ row: TesterRow | null; created: boolean }> {
  const db = getDb();
  if (!db) return { row: null, created: false };
  const { data, error } = await db
    .from('beta_testers')
    .upsert(
      { platform, platform_id: platformId, name: name ?? 'auto' },
      { onConflict: 'platform,platform_id', ignoreDuplicates: true },
    )
    .select(TESTER_COLS);
  if (error) {
    console.warn(`[beta] autoEnroll: ${error.message}`);
    return { row: null, created: false };
  }
  const inserted = data?.[0] as TesterRow | undefined;
  if (inserted) {
    console.log(`[beta] auto-enrolled ${platform}:${platformId} (${name ?? 'auto'}) on first touch`);
    return { row: inserted, created: true };
  }
  return { row: await getTester(platform, platformId), created: false };
}

// ---- Free exact-match answer cache ----------------------------------------

export async function exactCacheGet(
  guildId: string,
  hash: string,
): Promise<{ answer: string; sources: Array<{ label: string; url?: string }> } | null> {
  const db = getDb();
  if (!db) return null;
  const { data, error } = await db
    .from('exact_cache')
    .select('answer, sources')
    .eq('guild_id', guildId)
    .eq('question_hash', hash)
    .eq('bucket_date', dayStartUtc().toISOString().slice(0, 10))
    .gte('created_at', new Date(Date.now() - EXACT_CACHE_TTL_MS).toISOString())
    .limit(1);
  if (error || !data?.length) return null;
  return { answer: data[0]!.answer, sources: data[0]!.sources ?? [] };
}

export async function exactCachePut(
  guildId: string,
  hash: string,
  answer: string,
  sources: Array<{ label: string; url?: string }>,
): Promise<void> {
  const db = getDb();
  if (!db) return;
  await db
    .from('exact_cache')
    .upsert(
      {
        guild_id: guildId,
        question_hash: hash,
        bucket_date: dayStartUtc().toISOString().slice(0, 10),
        answer,
        sources,
        created_at: new Date().toISOString(), // refresh freshness on re-store
      },
      { onConflict: 'guild_id,question_hash,bucket_date' },
    )
    .throwOnError();
}

// ---- Founder alerts (registered by the Discord adapter) --------------------

type Notifier = (userId: string, text: string) => Promise<void>;
let founderNotifier: Notifier | null = null;
export function setFounderNotifier(fn: Notifier): void {
  founderNotifier = fn;
}
const alertedToday = new Set<string>(); // `${day}:${fraction}` — one alert each

async function maybeAlert(spend: number, cap: number): Promise<void> {
  const cfg = getConfig();
  if (!cfg.FOUNDER_DISCORD_ID || !founderNotifier) return;
  const day = dayStartUtc().toISOString().slice(0, 10);
  for (const f of CAPS.alertFractions) {
    if (spend >= cap * f && !alertedToday.has(`${day}:${f}`)) {
      alertedToday.add(`${day}:${f}`);
      const pct = Math.round(f * 100);
      const note =
        f >= 1
          ? `🛑 Pip daily spend cap hit: $${spend.toFixed(2)} / $${cap}. Serving stopped for today.`
          : f >= CAPS.degradeAtFraction
            ? `⚠️ Pip at ${pct}% of daily budget ($${spend.toFixed(2)} / $${cap}). Degrade mode ON.`
            : `Pip at ${pct}% of daily budget ($${spend.toFixed(2)} / $${cap}).`;
      await founderNotifier(cfg.FOUNDER_DISCORD_ID, note).catch(() => {});
    }
  }
}

// ---- Trial window -----------------------------------------------------------
// Every tester gets a 7-day window (DB default, 0006_trial.sql), then they pay.
//
// The tweet-for-a-free-week extension was REMOVED 2026-07-27 (founder decision:
// enough tweets). The beta_testers.extension_* columns are deliberately kept —
// they hold the record of who claimed one while it ran, and the admin console
// still reports that history. Nothing writes them any more.

function accessLapsed(t: TesterRow, now: number): boolean {
  if (!t.access_until) return false; // row predates the trial migration — fail open
  const ends = new Date(t.access_until).getTime();
  // 'infinity' (never lapses) parses to NaN, and NaN comparisons are false.
  return Number.isFinite(ends) && now > ends;
}

function payLine(): string {
  const url = getConfig().BETA_UPGRADE_URL;
  if (url) return `grab full access here: ${url}`;
  // Payments went live 2026-07-17, so the old "coming soon, you'll hear about
  // it first" fallback is now FALSE and costs a conversion every time it fires:
  // it tells a ready-to-pay user to sit and wait for something that exists.
  // Reaching this branch means BETA_UPGRADE_URL is missing from the environment.
  console.warn('[beta] BETA_UPGRADE_URL is not set, upgrade prompts are going out without a checkout link');
  return 'paid access is live now, ask in the server for the checkout link.';
}

// ---- Plan resolution + enforcement (2026-07-24) ----------------------------

/** The personal plan for a DM: an active personal subscription, else the trial.
 *  tierKey is null on trial — subCapsFor() below treats null as trial too. */
function personalPlan(tester: TesterRow): { plan: PlanCaps; tierKey: string | null } {
  const tier = tester.tier ?? '';
  const active = tester.subscription_status === 'active';
  if (active && (tier === 'personal-lite' || tier === 'personal-pro' || tier === 'elite')) {
    return { plan: PLAN_CAPS[tier]!, tierKey: tier };
  }
  return { plan: TRIAL_PERSONAL, tierKey: null };
}

/** Resolve the per-day feature sub-caps for a tier key (null = trial). */
function subCapsFor(tierKey: string | null): SubCaps {
  return tierKey ? (SUB_CAPS[tierKey] ?? TRIAL_SUB_CAPS) : TRIAL_SUB_CAPS;
}

/**
 * Server access + plan for a guild. Server plans are per-GUILD: an active
 * Server Pro subscription (server_access_until in the future), else the guild's
 * 7-day trial (created_at + TRIAL_DAYS). `ok:false` means the guild's trial
 * lapsed with no paid plan — nudge them to Server Pro.
 */
function guildAccess(gp: GuildPlan | null, now: number): { ok: boolean; plan: PlanCaps; tierKey: string | null } {
  const paidUntil = gp?.server_access_until ? new Date(gp.server_access_until).getTime() : 0;
  const tier = gp?.server_tier ?? '';
  if (paidUntil > now && (tier === 'server-pro' || tier === 'elite') && PLAN_CAPS[tier]) {
    return { ok: true, plan: PLAN_CAPS[tier]!, tierKey: tier };
  }
  // Free guild trial from first-seen. Unknown created_at (older rows) fails OPEN
  // to trial caps rather than locking out an active server; the global +
  // per-guild spend caps still bound cost.
  const created = gp?.created_at ? new Date(gp.created_at).getTime() : null;
  const trialEnds = created != null ? created + TRIAL_DAYS * 86_400_000 : null;
  if (trialEnds == null || now < trialEnds) return { ok: true, plan: TRIAL_SERVER, tierKey: null };
  return { ok: false, plan: TRIAL_SERVER, tierKey: null };
}

interface PlanBlockResult {
  text: string;
  gateType: 'daily_cap' | 'monthly_cap' | 'trial_total';
  capValue: number;
}

/**
 * Enforce a plan's message caps for a scope (a user in DMs, a guild in servers).
 * Returns a block (message + which cap fired, for gate_event) when a cap is
 * hit, else null. Daily count is passed in (already read from today's rows);
 * monthly + trial-total are cheap COUNT hops that only run when the plan
 * actually has those caps.
 */
async function planBlock(
  plan: PlanCaps,
  scope: { user_id: string } | { guild_id: string },
  todayCount: number,
  isServer: boolean,
): Promise<PlanBlockResult | null> {
  if (todayCount >= plan.daily) {
    return {
      text: isServer
        ? "This server's hit its daily Pip limit, resets at midnight UTC 🌱"
        : "You've hit today's limit, it resets at midnight UTC 🌱",
      gateType: 'daily_cap',
      capValue: plan.daily,
    };
  }
  if (plan.monthly != null) {
    const used = await usageCountForScope(scope, monthStartUtc().toISOString());
    if (used >= plan.monthly) {
      return {
        text: isServer
          ? `This server has used its ${plan.label} monthly allowance (${plan.monthly}). Resets on the 1st, UTC 🌱`
          : `You've used your ${plan.label} monthly allowance (${plan.monthly}). Resets on the 1st, UTC 🌱`,
        gateType: 'monthly_cap',
        capValue: plan.monthly,
      };
    }
  }
  if (plan.trialTotal != null) {
    const used = await usageCountForScope(scope);
    if (used >= plan.trialTotal) {
      return {
        text: isServer
          ? `This server's free trial is used up (${plan.trialTotal} messages). To keep Pip here, ${payLine()}`
          : `Your free trial is used up (${plan.trialTotal} messages). To keep going, ${payLine()}`,
        gateType: 'trial_total',
        capValue: plan.trialTotal,
      };
    }
  }
  return null;
}

// ---- The gate --------------------------------------------------------------

export interface GateDecision {
  allow: boolean;
  /** When blocked: a message to post (unless silent). */
  replyText?: string;
  /** When blocked silently (wrong channel, cooldown): drop without replying. */
  silent?: boolean;
  /**
   * Server cap/lapse blocks: DM this text to the user instead of nagging the
   * channel. The adapter tries once; if their DMs are closed it drops silently.
   * Set at most once per user per day (see serverBlock) so repeats never spam.
   */
  dmText?: string;
  /** Per-request feature budget handed to the agent when allowed. */
  features: { web: boolean; vision: boolean; scan: boolean };
  degraded: boolean;
  /**
   * True only on the message that actually created this user's row, so an
   * adapter can greet a genuinely new arrival exactly once. Never set on a
   * repeat message, and never set when the enrol write failed.
   */
  enrolled?: boolean;
}

const ALLOW_ALL: GateDecision = {
  allow: true,
  features: { web: true, vision: true, scan: true },
  degraded: false,
};

const lastMessageAt = new Map<string, number>(); // userKey -> ms (cooldown)
const lastNudgeAt = new Map<string, number>(); // userKey -> ms (server DM nudge)
const DM_NUDGE_TTL_MS = 24 * 60 * 60 * 1000; // at most one server-block DM per user/day

/**
 * A server-context block: never nag the channel. DM the user the reason at most
 * once per day (the adapter drops it silently if their DMs are closed), and drop
 * the message silently otherwise. Keeps a hit-limit user from spamming the
 * server AND from being publicly pay-walled in front of everyone.
 */
function serverBlock(
  msg: NormalizedMessage,
  now: number,
  text: string,
  gateType: string,
  capValue?: number,
): GateDecision {
  const userKey = `${msg.platform}:${msg.userId}`;
  const last = lastNudgeAt.get(userKey) ?? 0;
  const dmText = now - last >= DM_NUDGE_TTL_MS ? text : undefined;
  if (dmText) lastNudgeAt.set(userKey, now);
  // Log every time the underlying condition fires, even on a day we suppress
  // the repeat DM (dmText undefined) — the DM-nudge TTL bounds how often we
  // NAG someone, not how often we count them hitting the cap.
  logGate(msg, gateType, capValue);
  return { allow: false, silent: true, dmText, features: { web: false, vision: false, scan: false }, degraded: false };
}

/**
 * The single pre-LLM checkpoint. Returns a decision the adapter acts on BEFORE
 * any model call, so nobody uninvited — and no runaway day — spends a cent.
 */
export async function betaGate(msg: NormalizedMessage): Promise<GateDecision> {
  if (!betaModeEnabled()) return ALLOW_ALL;
  const cfg = getConfig();
  const now = Date.now();
  const userKey = `${msg.platform}:${msg.userId}`;

  // 0. Hard stop switch. Retained as an emergency "pause Pip for everyone"
  //    lever, but it is NOT part of normal public operation — leave BETA_ENDS_AT
  //    unset. If it ever holds a past timestamp, Pip goes dark for every user,
  //    testers included, which is exactly what it did through the private beta.
  if (cfg.BETA_ENDS_AT) {
    const ends = new Date(cfg.BETA_ENDS_AT).getTime();
    if (Number.isFinite(ends) && now > ends) {
      return blocked(
        cfg.BETA_END_MESSAGE ??
          "Pip is paused for maintenance right now 🌱 Back shortly — thanks for your patience.",
        msg,
        'beta_paused',
      );
    }
  }

  // 1. Enrollment. PUBLIC ACCESS (user decision 2026-07-22): Pip is no longer
  //    private beta. Anyone who reaches Pip on any surface is enrolled on first
  //    touch and starts the standard trial — beta_testers.access_until defaults
  //    to now() + 7 days (0006_trial.sql), so this grants no more than a normal
  //    signup would.
  //
  //    DMs used to be excluded here, which silently turned away every visitor
  //    arriving from the website's Telegram CTA — t.me/pipinvestbot can only
  //    ever open a DM, so that path could never enrol anyone. Cost is bounded
  //    by the per-user / per-guild / global caps below, not by an allowlist.
  let enrolled = false;
  let tester = await getTester(msg.platform, msg.userId);
  if (!tester) tester = await claimHandleRow(msg, null);
  if (!tester) {
    const res = await autoEnroll(msg.platform, msg.userId, msg.userName);
    tester = res.row;
    enrolled = res.created;
  }
  if (!tester) {
    // autoEnroll only returns null when the DB write itself failed. Fail OPEN
    // on a fresh trial rather than turning a real user away — a Supabase blip
    // must not surface to a new arrival as a rejection. The spend caps below
    // still apply, so this cannot run away.
    console.warn(`[beta] enrol failed, serving open: ${msg.platform}:${msg.userId}`);
    tester = { access_until: null };
  }

  // 2. Optional server / channel restriction — only bites when the env lists
  //    are non-empty (empty = open to any server Pip is invited to). DMs from
  //    testers always pass.
  const isDM = msg.guildId.startsWith('dm:');
  if (!isDM) {
    const guilds = csvSet(cfg.BETA_ALLOWED_GUILDS);
    // The list only constrains the platform it names ids for: bare Discord
    // snowflakes must not lock out Telegram groups (`tg:<chatId>`) and vice
    // versa — a stale Discord-only list was silently blocking ALL TG groups.
    const listCoversPlatform = [...guilds].some(
      (g) => g.startsWith('tg:') === msg.guildId.startsWith('tg:'),
    );
    if (guilds.size && listCoversPlatform && !guilds.has(msg.guildId)) {
      return blockedSilent('guild allowlist', 'guild_allowlist', msg);
    }
    const channels = csvSet(cfg.BETA_ALLOWED_CHANNELS);
    if (channels.size && msg.channelId && !channels.has(msg.channelId)) {
      return blockedSilent('channel allowlist', 'channel_allowlist', msg);
    }
    // Community server ONLY: confine Pip to #ask-pip so it isn't @-mentioned
    // (and billed) across every channel of a busy free community. Silent drop
    // elsewhere — no channel nag. Other servers are untouched.
    if (
      cfg.PIP_COMMUNITY_GUILD_ID &&
      cfg.PIP_COMMUNITY_CHANNEL_ID &&
      msg.guildId === cfg.PIP_COMMUNITY_GUILD_ID &&
      msg.channelId &&
      msg.channelId !== cfg.PIP_COMMUNITY_CHANNEL_ID
    ) {
      return blockedSilent('community channel restriction', 'community_channel', msg);
    }
  }

  // Per-user-billing servers (opt-in list, e.g. HAVELI): the guild's own plan
  // is ignored entirely and each member is gated on their own personal trial/
  // subscription instead — see PIP_PER_USER_BILLING_GUILDS in config.ts.
  const perUserBilling = !isDM && csvSet(cfg.PIP_PER_USER_BILLING_GUILDS).has(msg.guildId);

  // 2b. Personal trial window (user decision 2026-07-07): 7 free days, then ONE
  //     extra week for tweeting about Pip, then paid. This governs PERSONAL (DM)
  //     access only — a Server Pro member must not be blocked in the server by
  //     their own lapsed personal trial (server access is the guild's plan, at
  //     the cap stage below) UNLESS the guild is on the per-user-billing list,
  //     where a lapsed member is exactly what should block. The claim/merge
  //     runs in any context so a paid grant under their @handle is always
  //     picked up.
  if (accessLapsed(tester, now)) {
    const upgraded = await claimHandleRow(msg, tester);
    if (upgraded) tester = upgraded;
  }
  if (isDM && accessLapsed(tester, now)) {
    // Reply on EVERY ping (founder decision 2026-07-15): a lapsed user who @s
    // Pip should always get the expired notice — never silence. Reactive only
    // (fires in response to their message, never an outbound DM), and it's a
    // canned string with no model call, so repeats cost nothing.
    return blocked(`Your free week with Pip is up 🌱 To keep going, ${payLine()}`, msg, 'personal_trial_lapsed');
  }
  if (perUserBilling && accessLapsed(tester, now)) {
    // Same lapse, but DM-not-public (serverBlock) since this fires in a server.
    return serverBlock(
      msg,
      now,
      `Your free trial with Pip is up 🌱 To keep using Pip here, ${payLine()}`,
      'personal_trial_lapsed',
    );
  }

  // 3. Cooldown (in-memory) — kills spam bursts & accidental double-fires.
  const last = lastMessageAt.get(userKey) ?? 0;
  if (now - last < CAPS.perUser.cooldownMs) {
    return blockedSilent('cooldown', 'cooldown', msg, CAPS.perUser.cooldownMs);
  }

  // 4. Read today's spend/usage in one hop — feeds the global, per-guild, and
  //    per-user caps below.
  const rows = await todayUsage();
  const globalSpend = rows.reduce((s, r) => s + Number(r.cost_usd), 0);
  const globalMsgs = rows.length;
  const spendCap = cfg.BETA_DAILY_SPEND_USD;
  void maybeAlert(globalSpend, spendCap); // non-blocking founder DM on threshold

  // 5. Global kill-switch — the real protection.
  if (globalSpend >= spendCap || globalMsgs >= cfg.BETA_DAILY_GLOBAL_MSGS) {
    const overSpend = globalSpend >= spendCap;
    return blocked(
      "Pip's daily budget is spent, back at midnight UTC. This keeps Pip running for everyone 🌱",
      msg,
      overSpend ? 'global_spend_cap' : 'global_msg_cap',
      overSpend ? spendCap : cfg.BETA_DAILY_GLOBAL_MSGS,
    );
  }

  // 5b. Per-server spend cap — one busy guild can't drain the global budget.
  //     DMs skip this (bounded by the per-user cap instead).
  if (!isDM) {
    const guildSpend = rows
      .filter((r) => r.guild_id === msg.guildId)
      .reduce((s, r) => s + Number(r.cost_usd), 0);
    if (guildSpend >= cfg.BETA_GUILD_DAILY_SPEND_USD) {
      // DM-not-public, same as the other server-context blocks.
      return serverBlock(
        msg,
        now,
        "That server's daily Pip budget is spent for today, back at midnight UTC 🌱 DMs still work in the meantime.",
        'guild_spend_cap',
        cfg.BETA_GUILD_DAILY_SPEND_USD,
      );
    }
  }

  // 6/6b/7. Per-user daily message cap, spend cap, and feature budgets — all
  // exempted for the founder's own account. These bound a TESTER's usage;
  // dogfooding the product on your own account isn't the thing they exist to
  // stop, and the global kill-switch + per-guild cap above still bound
  // runaway cost even for the founder. Founder is already excluded from
  // pilot metrics the same way (dashboard) — this mirrors that.
  const isFounder = Boolean(cfg.FOUNDER_DISCORD_ID) && msg.userId === cfg.FOUNDER_DISCORD_ID;
  const mine = rows.filter((r) => r.user_id === msg.userId);

  // Resolved by whichever branch below actually runs; null (trial sub-caps)
  // for the founder path, where it's moot since features short-circuit on
  // isFounder anyway.
  let tierKey: string | null = null;

  if (!isFounder) {
    // Plan- and context-aware caps (2026-07-24). Personal plans are enforced
    // PER USER (DMs); server plans PER GUILD (shared). Each plan carries a daily
    // cap plus, where applicable, a monthly allowance and a hard trial total.
    if (isDM) {
      const personal = personalPlan(tester);
      tierKey = personal.tierKey;
      const block = await planBlock(personal.plan, { user_id: msg.userId }, mine.length, false);
      if (block) return blocked(block.text, msg, block.gateType, block.capValue);
      // Per-user daily SPEND backstop — bounds an expensive burst that stays
      // under the message count cap (the plan caps are message-count based).
      const mySpend = mine.reduce((s, r) => s + Number(r.cost_usd), 0);
      if (mySpend >= cfg.BETA_USER_DAILY_SPEND_USD) {
        return blocked(
          "You've used today's Pip budget, it resets at midnight UTC 🌱",
          msg,
          'user_spend_cap',
          cfg.BETA_USER_DAILY_SPEND_USD,
        );
      }
    } else if (perUserBilling) {
      // Per-user-billing server: skip the guild's own plan entirely — gate
      // this member on their own personal plan instead, same rule as the DM
      // branch above, just DM'd instead of posted publicly.
      const personal = personalPlan(tester);
      tierKey = personal.tierKey;
      const block = await planBlock(personal.plan, { user_id: msg.userId }, mine.length, false);
      if (block) return serverBlock(msg, now, block.text, block.gateType, block.capValue);
      const mySpend = mine.reduce((s, r) => s + Number(r.cost_usd), 0);
      if (mySpend >= cfg.BETA_USER_DAILY_SPEND_USD) {
        return serverBlock(
          msg,
          now,
          "You've used today's Pip budget, it resets at midnight UTC 🌱",
          'user_spend_cap',
          cfg.BETA_USER_DAILY_SPEND_USD,
        );
      }
    } else {
      // Server context. Every block here is DM-not-public (serverBlock): a
      // hit-limit user is never pay-walled in front of the whole server.
      const access = guildAccess(await getGuildPlan(msg.guildId), now);
      tierKey = access.tierKey;
      if (!access.ok) {
        return serverBlock(
          msg,
          now,
          `Pip's free trial in that server is up 🌱 To keep Pip there, an admin can ${payLine()}`,
          'guild_trial_lapsed',
        );
      }
      // No per-member sub-cap (removed 2026-07-27). It bought no cost
      // protection — the guild's own daily + total caps already bound the
      // worst case — and at 8/day it was the constraint that actually bit
      // first: SaveTheWhal3s' most engaged member sent 12 on install day, so
      // Pip would have gone silent on the keenest user in a server that was
      // mid-evaluation. Silence reads as "the bot is broken", which is what
      // killed that server. One member CAN now use the guild's whole daily
      // allowance; that is the accepted trade.
      const guildToday = rows.filter((r) => r.guild_id === msg.guildId).length;
      const block = await planBlock(access.plan, { guild_id: msg.guildId }, guildToday, true);
      if (block) return serverBlock(msg, now, block.text, block.gateType, block.capValue);
    }
  }

  // Degrade mode + per-user feature budgets, tier-aware (2026-07-30 rebalance).
  const degraded = globalSpend >= spendCap * CAPS.degradeAtFraction;
  const subCaps = subCapsFor(tierKey);
  const mySearches = mine.reduce((s, r) => s + (r.web_searches ?? 0), 0);
  const myVision = mine.filter((r) => r.had_vision).length;
  const myScans = mine.filter((r) => (r.tools_used ?? []).includes('token_scan')).length;

  // Feature sub-cap hits are a SOFT degrade, not a block — allow stays true,
  // only that one capability turns off, so these can't return early like the
  // block points above. Logged as their own gate_type regardless of the
  // separate `degraded` (approaching-global-cap) state: this is specifically
  // "this user hit their tier's per-day count on this tool," a WTP signal.
  if (!isFounder) {
    if (mySearches >= subCaps.webSearches) logGate(msg, 'feature_web', subCaps.webSearches);
    if (myVision >= subCaps.vision) logGate(msg, 'feature_vision', subCaps.vision);
    if (myScans >= subCaps.scans) logGate(msg, 'feature_scan', subCaps.scans);
  }

  lastMessageAt.set(userKey, now); // consume the cooldown slot on a served turn
  return {
    allow: true,
    enrolled,
    degraded,
    features: {
      web: isFounder || (!degraded && mySearches < subCaps.webSearches),
      vision: isFounder || (!degraded && myVision < subCaps.vision),
      scan: isFounder || myScans < subCaps.scans,
    },
  };
}

function logGate(msg: NormalizedMessage, gateType: string, capValue?: number): void {
  void logGateEvent({ platform: msg.platform, guildId: msg.guildId, userId: msg.userId, gateType, capValue }).catch(
    () => {},
  );
}

function blocked(replyText: string, msg: NormalizedMessage, gateType: string, capValue?: number): GateDecision {
  logGate(msg, gateType, capValue);
  return { allow: false, replyText, features: { web: false, vision: false, scan: false }, degraded: false };
}
function blockedSilent(reason: string, gateType: string, msg: NormalizedMessage, capValue?: number): GateDecision {
  // Silent drops MUST leave a trace — an unlogged drop looks identical to an
  // outage from the user's side (took weeks to notice TG groups were blocked).
  console.log(`[beta] silent block (${reason}): ${msg.platform}:${msg.userId} in ${msg.guildId}`);
  logGate(msg, gateType, capValue);
  return { allow: false, silent: true, features: { web: false, vision: false, scan: false }, degraded: false };
}
