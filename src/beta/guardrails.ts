import { createHash } from 'node:crypto';
import { getDb } from '../memory/db.js';
import { getConfig, betaModeEnabled, csvSet } from '../config.js';
import { NormalizedMessage } from '../adapters/platform.js';
import { CAPS } from './caps.js';

// ---- Cost model (Claude Sonnet 4.6 — $/1M tokens) --------------------------
// Update these if ANSWER_MODEL changes. Cache read is ~0.1x input; cache write
// ~1.25x. Web search is billed per search (~$10 / 1,000).
const PRICE = { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 };
const WEB_SEARCH_USD = 0.01;

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

export function computeCostUsd(u: UsageTotals, webSearches: number): number {
  const t =
    u.input_tokens * PRICE.input +
    u.cache_creation_input_tokens * PRICE.cacheWrite +
    u.cache_read_input_tokens * PRICE.cacheRead +
    u.output_tokens * PRICE.output;
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
    })
    .throwOnError();
}

export interface SafetyEventRow {
  platform: string;
  guildId: string;
  userId: string;
  /** Which backstop fired: a hard-blocked prompt-leak, or a logged signal-language slip. */
  kind: 'prompt_leak' | 'signal_language';
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

/** The slice of a beta_testers row the gate needs (trial window + extension). */
interface TesterRow {
  access_until: string | null;
  extension_used: boolean;
}
const TESTER_COLS = 'access_until, extension_used';

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
  'access_until, extension_used, tier, subscription_provider, subscription_id, subscription_status';

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
  return { access_until: merged, extension_used: existing.extension_used };
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

// ---- Trial window + one-time tweet extension --------------------------------
// Every tester gets a 7-day window (DB default, 0006_trial.sql). When it
// lapses they can unlock ONE extra week by tweeting about Pip and pasting the
// link in chat. Verification is manual by design: the founder gets the link by
// DM and revokes fakes in SQL — the $ caps bound what a fake can ever cost.

const TWEET_URL_RE = /https?:\/\/(?:www\.)?(?:x|twitter)\.com\/\w{1,15}\/status\/\d+/i;

function accessLapsed(t: TesterRow, now: number): boolean {
  if (!t.access_until) return false; // row predates the trial migration — fail open
  const ends = new Date(t.access_until).getTime();
  // 'infinity' (never lapses) parses to NaN, and NaN comparisons are false.
  return Number.isFinite(ends) && now > ends;
}

/** Atomically claim the one tweet extension. False if already used (or DB down). */
async function grantTweetExtension(msg: NormalizedMessage, tweetUrl: string): Promise<boolean> {
  const db = getDb();
  if (!db) return false;
  const until = new Date(Date.now() + CAPS.trial.extensionDays * 86_400_000).toISOString();
  const { data, error } = await db
    .from('beta_testers')
    .update({
      access_until: until,
      extension_used: true,
      extension_tweet_url: tweetUrl,
      extension_claimed_at: new Date().toISOString(),
    })
    .eq('platform', msg.platform)
    .eq('platform_id', msg.userId)
    .eq('extension_used', false) // the one-time guard, enforced in the row itself
    .select('platform_id');
  if (error) {
    console.warn(`[beta] grantTweetExtension: ${error.message}`);
    return false;
  }
  return (data?.length ?? 0) > 0;
}

/** DM the founder the claimed tweet link for manual verification. */
async function notifyTweetClaim(msg: NormalizedMessage, tweetUrl: string): Promise<void> {
  const cfg = getConfig();
  if (!cfg.FOUNDER_DISCORD_ID || !founderNotifier) return;
  await founderNotifier(
    cfg.FOUNDER_DISCORD_ID,
    `🐦 Tweet extension claimed by ${msg.platform}:${msg.userId} (${msg.userName ?? 'unknown'})\n${tweetUrl}\n` +
      `If it's fake, revoke with: update beta_testers set access_until = now() ` +
      `where platform = '${msg.platform}' and platform_id = '${msg.userId}';`,
  ).catch(() => {});
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

// ---- The gate --------------------------------------------------------------

export interface GateDecision {
  allow: boolean;
  /** When blocked: a message to post (unless silent). */
  replyText?: string;
  /** When blocked silently (wrong channel, cooldown): drop without replying. */
  silent?: boolean;
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
    tester = { access_until: null, extension_used: false };
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
    if (guilds.size && listCoversPlatform && !guilds.has(msg.guildId)) return blockedSilent('guild allowlist', msg);
    const channels = csvSet(cfg.BETA_ALLOWED_CHANNELS);
    if (channels.size && msg.channelId && !channels.has(msg.channelId)) return blockedSilent('channel allowlist', msg);
  }

  // 2b. Per-user trial window (user decision 2026-07-07): 7 free days, then
  //     ONE extra week for tweeting about Pip (link pasted in chat, verified
  //     manually by the founder), then paid. Checked before the cooldown so a
  //     pasted tweet link is never silently dropped.
  if (accessLapsed(tester, now)) {
    // A paid checkout grant may be waiting under their @handle — claim/merge it
    // before nudging. If it un-lapses them, the next check falls through to serve.
    const upgraded = await claimHandleRow(msg, tester);
    if (upgraded) tester = upgraded;
  }
  if (accessLapsed(tester, now)) {
    const tweetUrl = msg.text.match(TWEET_URL_RE)?.[0];
    if (tweetUrl && !tester.extension_used) {
      if (await grantTweetExtension(msg, tweetUrl)) {
        void notifyTweetClaim(msg, tweetUrl);
        return blocked("Tweet received, you've unlocked one more free week 🌱 Enjoy! (I do check the links, so keep it up 👀)");
      }
      return blocked("Couldn't record that just now, paste the tweet link again in a minute.");
    }
    // Reply on EVERY ping (founder decision 2026-07-15): a lapsed user who @s
    // Pip should always get the expired notice — never silence. Reactive only
    // (fires in response to their message, never an outbound DM), and it's a
    // canned string with no model call, so repeats cost nothing.
    if (!tester.extension_used) {
      return blocked(
        'Your free week with Pip is up 🌱 Two ways to keep going:\n' +
          '1. Tweet what you think of Pip, then paste the tweet link here. Unlocks one more free week (one time).\n' +
          `2. Or ${payLine()}`,
      );
    }
    return blocked(`Your bonus week is up. Thanks for testing Pip 🌱 To keep going, ${payLine()}`);
  }

  // 3. Cooldown (in-memory) — kills spam bursts & accidental double-fires.
  const last = lastMessageAt.get(userKey) ?? 0;
  if (now - last < CAPS.perUser.cooldownMs) return blockedSilent('cooldown', msg);

  // 4. Read today's spend/usage in one hop — feeds the global, per-guild, and
  //    per-user caps below.
  const rows = await todayUsage();
  const globalSpend = rows.reduce((s, r) => s + Number(r.cost_usd), 0);
  const globalMsgs = rows.length;
  const spendCap = cfg.BETA_DAILY_SPEND_USD;
  void maybeAlert(globalSpend, spendCap); // non-blocking founder DM on threshold

  // 5. Global kill-switch — the real protection.
  if (globalSpend >= spendCap || globalMsgs >= cfg.BETA_DAILY_GLOBAL_MSGS) {
    return blocked("Pip's daily budget is spent, back at midnight UTC. This keeps Pip running for everyone 🌱");
  }

  // 5b. Per-server spend cap — one busy guild can't drain the global budget.
  //     DMs skip this (bounded by the per-user cap instead).
  if (!isDM) {
    const guildSpend = rows
      .filter((r) => r.guild_id === msg.guildId)
      .reduce((s, r) => s + Number(r.cost_usd), 0);
    if (guildSpend >= cfg.BETA_GUILD_DAILY_SPEND_USD) {
      return blocked(
        "This server's daily Pip budget is spent — back at midnight UTC. DMs still work in the meantime 🌱",
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

  if (!isFounder) {
    if (mine.length >= cfg.BETA_USER_DAILY_MSGS) {
      return blocked("You've hit today's limit, it resets at midnight UTC. This keeps Pip running for everyone 🌱");
    }
    const mySpend = mine.reduce((s, r) => s + Number(r.cost_usd), 0);
    if (mySpend >= cfg.BETA_USER_DAILY_SPEND_USD) {
      return blocked("You've used today's Pip budget, it resets at midnight UTC 🌱");
    }
  }

  // Degrade mode + per-user feature budgets.
  const degraded = globalSpend >= spendCap * CAPS.degradeAtFraction;
  const mySearches = mine.reduce((s, r) => s + (r.web_searches ?? 0), 0);
  const myVision = mine.filter((r) => r.had_vision).length;
  const myScans = mine.filter((r) => (r.tools_used ?? []).includes('token_scan')).length;

  lastMessageAt.set(userKey, now); // consume the cooldown slot on a served turn
  return {
    allow: true,
    enrolled,
    degraded,
    features: {
      web: isFounder || (!degraded && mySearches < CAPS.perUser.webSearches),
      vision: isFounder || (!degraded && myVision < CAPS.perUser.vision),
      scan: isFounder || myScans < CAPS.perUser.scans,
    },
  };
}

function blocked(replyText: string): GateDecision {
  return { allow: false, replyText, features: { web: false, vision: false, scan: false }, degraded: false };
}
function blockedSilent(reason: string, msg: NormalizedMessage): GateDecision {
  // Silent drops MUST leave a trace — an unlogged drop looks identical to an
  // outage from the user's side (took weeks to notice TG groups were blocked).
  console.log(`[beta] silent block (${reason}): ${msg.platform}:${msg.userId} in ${msg.guildId}`);
  return { allow: false, silent: true, features: { web: false, vision: false, scan: false }, degraded: false };
}
