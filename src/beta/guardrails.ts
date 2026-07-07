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

/**
 * Telegram invites are added by @handle (the numeric id is unknowable until the
 * person messages the bot). If this user's handle matches a pending `@handle`
 * row, claim it: rekey the row to their numeric id so every later check hits
 * the fast platform_id path.
 */
async function claimHandleInvite(msg: NormalizedMessage): Promise<TesterRow | null> {
  if (msg.platform !== 'telegram' || !msg.userName) return null;
  const db = getDb();
  if (!db) return null;
  const handle = `@${msg.userName.toLowerCase()}`;
  const { data, error } = await db
    .from('beta_testers')
    .update({ platform_id: msg.userId, name: msg.userName })
    .eq('platform', 'telegram')
    .eq('platform_id', handle)
    .select(TESTER_COLS);
  if (error) {
    console.warn(`[beta] claimHandleInvite: ${error.message}`);
    return null;
  }
  const claimed = (data?.[0] as TesterRow | undefined) ?? null;
  if (claimed) console.log(`[beta] telegram ${handle} claimed by id ${msg.userId}`);
  return claimed;
}

/** First-touch enrollment from an allowlisted server. Idempotent (PK upsert). */
async function autoEnroll(platform: string, platformId: string, name?: string): Promise<TesterRow | null> {
  const db = getDb();
  if (!db) return null;
  const { data, error } = await db
    .from('beta_testers')
    .upsert(
      { platform, platform_id: platformId, name: name ?? 'auto' },
      { onConflict: 'platform,platform_id', ignoreDuplicates: true },
    )
    .select(TESTER_COLS);
  if (error) {
    console.warn(`[beta] autoEnroll: ${error.message}`);
    return null;
  }
  console.log(`[beta] auto-enrolled ${platform}:${platformId} (${name ?? 'auto'}) via server invite`);
  // ignoreDuplicates returns no row when we raced an existing insert — re-read.
  return (data?.[0] as TesterRow | undefined) ?? getTester(platform, platformId);
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
  return url ? `grab full access here: ${url}` : "paid access is coming soon — you'll hear about it first.";
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
}

const ALLOW_ALL: GateDecision = {
  allow: true,
  features: { web: true, vision: true, scan: true },
  degraded: false,
};

const lastMessageAt = new Map<string, number>(); // userKey -> ms (cooldown)
const politeRepliedToday = new Set<string>(); // non-testers: one reply/day
const trialNoticedToday = new Set<string>(); // expired trials: one nudge/day

/**
 * The single pre-LLM checkpoint. Returns a decision the adapter acts on BEFORE
 * any model call, so nobody uninvited — and no runaway day — spends a cent.
 */
export async function betaGate(msg: NormalizedMessage): Promise<GateDecision> {
  if (!betaModeEnabled()) return ALLOW_ALL;
  const cfg = getConfig();
  const now = Date.now();
  const userKey = `${msg.platform}:${msg.userId}`;

  // 0. Beta window closed → wrap-up, no serving.
  if (cfg.BETA_ENDS_AT) {
    const ends = new Date(cfg.BETA_ENDS_AT).getTime();
    if (Number.isFinite(ends) && now > ends) {
      return blocked(
        cfg.BETA_END_MESSAGE ??
          "The Pip beta has wrapped — thank you for testing 🌱 We're folding your feedback in. You'll hear when Pip is back.",
      );
    }
  }

  // 1. Enrollment. The server INVITE is the trust boundary (user decision
  //    2026-07-06): anyone who reaches Pip inside any server it was added to
  //    is auto-enrolled — adding the bot needs Manage Server, and the per-guild
  //    spend cap + per-user caps bound every new enrollee. DMs stay tester-only
  //    (no auto-enroll from DMs; a DM-first user needs a guild touch or a
  //    manual/handle invite first).
  let tester = await getTester(msg.platform, msg.userId);
  if (!tester) tester = await claimHandleInvite(msg);
  if (!tester && !msg.guildId.startsWith('dm:')) {
    tester = await autoEnroll(msg.platform, msg.userId, msg.userName);
  }
  if (!tester) {
    const day = dayStartUtc().toISOString().slice(0, 10);
    const key = `${day}:${userKey}`;
    if (politeRepliedToday.has(key)) return blockedSilent();
    politeRepliedToday.add(key);
    return blocked('Pip is in private beta right now. Sit tight — public access is coming soon. 🌱');
  }

  // 2. Optional server / channel restriction — only bites when the env lists
  //    are non-empty (empty = open to any server Pip is invited to). DMs from
  //    testers always pass.
  const isDM = msg.guildId.startsWith('dm:');
  if (!isDM) {
    const guilds = csvSet(cfg.BETA_ALLOWED_GUILDS);
    if (guilds.size && !guilds.has(msg.guildId)) return blockedSilent();
    const channels = csvSet(cfg.BETA_ALLOWED_CHANNELS);
    if (channels.size && msg.channelId && !channels.has(msg.channelId)) return blockedSilent();
  }

  // 2b. Per-user trial window (user decision 2026-07-07): 7 free days, then
  //     ONE extra week for tweeting about Pip (link pasted in chat, verified
  //     manually by the founder), then paid. Checked before the cooldown so a
  //     pasted tweet link is never silently dropped.
  if (accessLapsed(tester, now)) {
    const tweetUrl = msg.text.match(TWEET_URL_RE)?.[0];
    if (tweetUrl && !tester.extension_used) {
      if (await grantTweetExtension(msg, tweetUrl)) {
        void notifyTweetClaim(msg, tweetUrl);
        return blocked("Tweet received — you've unlocked one more free week 🌱 Enjoy! (I do check the links, so keep it up 👀)");
      }
      return blocked("Couldn't record that just now — paste the tweet link again in a minute.");
    }
    // Nudge once per day, then go quiet — an expired user spamming questions
    // shouldn't get an expired notice per message.
    const noticeKey = `${dayStartUtc().toISOString().slice(0, 10)}:${userKey}`;
    if (trialNoticedToday.has(noticeKey)) return blockedSilent();
    trialNoticedToday.add(noticeKey);
    if (!tester.extension_used) {
      return blocked(
        'Your free week with Pip is up 🌱 Two ways to keep going:\n' +
          '1. Tweet what you think of Pip, then paste the tweet link here — unlocks one more free week (one time).\n' +
          `2. Or ${payLine()}`,
      );
    }
    return blocked(`Your bonus week is up — thanks for testing Pip 🌱 To keep going, ${payLine()}`);
  }

  // 3. Cooldown (in-memory) — kills spam bursts & accidental double-fires.
  const last = lastMessageAt.get(userKey) ?? 0;
  if (now - last < CAPS.perUser.cooldownMs) return blockedSilent();

  // 4. Read today's spend/usage in one hop — feeds the global, per-guild, and
  //    per-user caps below.
  const rows = await todayUsage();
  const globalSpend = rows.reduce((s, r) => s + Number(r.cost_usd), 0);
  const globalMsgs = rows.length;
  const spendCap = cfg.BETA_DAILY_SPEND_USD;
  void maybeAlert(globalSpend, spendCap); // non-blocking founder DM on threshold

  // 5. Global kill-switch — the real protection.
  if (globalSpend >= spendCap || globalMsgs >= cfg.BETA_DAILY_GLOBAL_MSGS) {
    return blocked("Pip's daily beta budget is spent — back at midnight UTC. This keeps the beta free for everyone 🌱");
  }

  // 5b. Per-server spend cap — one busy guild can't drain the global budget.
  //     DMs skip this (bounded by the per-user cap instead).
  if (!isDM) {
    const guildSpend = rows
      .filter((r) => r.guild_id === msg.guildId)
      .reduce((s, r) => s + Number(r.cost_usd), 0);
    if (guildSpend >= cfg.BETA_GUILD_DAILY_SPEND_USD) {
      return blocked(
        "This server's daily Pip budget is spent — back at midnight UTC. DMs still work if you're a beta tester 🌱",
      );
    }
  }

  // 6. Per-user daily message cap.
  const mine = rows.filter((r) => r.user_id === msg.userId);
  if (mine.length >= cfg.BETA_USER_DAILY_MSGS) {
    return blocked("You've hit today's beta limit — resets at midnight UTC. This keeps the beta free for everyone 🌱");
  }

  // 6b. Per-user daily spend cap ($) — follows the user across guilds and DMs.
  const mySpend = mine.reduce((s, r) => s + Number(r.cost_usd), 0);
  if (mySpend >= cfg.BETA_USER_DAILY_SPEND_USD) {
    return blocked("You've used today's Pip budget — it resets at midnight UTC 🌱");
  }

  // 7. Degrade mode + per-user feature budgets.
  const degraded = globalSpend >= spendCap * CAPS.degradeAtFraction;
  const mySearches = mine.reduce((s, r) => s + (r.web_searches ?? 0), 0);
  const myVision = mine.filter((r) => r.had_vision).length;
  const myScans = mine.filter((r) => (r.tools_used ?? []).includes('token_scan')).length;

  lastMessageAt.set(userKey, now); // consume the cooldown slot on a served turn
  return {
    allow: true,
    degraded,
    features: {
      web: !degraded && mySearches < CAPS.perUser.webSearches,
      vision: !degraded && myVision < CAPS.perUser.vision,
      scan: myScans < CAPS.perUser.scans,
    },
  };
}

function blocked(replyText: string): GateDecision {
  return { allow: false, replyText, features: { web: false, vision: false, scan: false }, degraded: false };
}
function blockedSilent(): GateDecision {
  return { allow: false, silent: true, features: { web: false, vision: false, scan: false }, degraded: false };
}
