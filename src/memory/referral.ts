/*
 * Refer & earn — recording referrals and settling the money.
 *
 * ALL reward arithmetic lives HERE, in the bot, and nowhere else. The payment
 * webhooks in pip-site do not compute rewards and do not need the ladder: they
 * only ever create the subscription, and this settles against it afterwards.
 * That is deliberate — duplicating a payout ladder across three module systems
 * (bot TS, pip-site ESM, dashboard CJS) means one of them eventually drifts,
 * and a drifted ladder pays the wrong amount of real money.
 *
 * Settlement is time-driven, not event-driven, because a referral qualifies
 * REFERRAL_HOLDBACK_DAYS after conversion, when nobody is doing anything. It
 * runs on a poller (src/core/referral-poller.ts) and is safe to call at any
 * time from anywhere: every step is idempotent and guarded by a unique index.
 *
 * See db/migrations/0018_referrals.sql and src/beta/referral-ladder.ts.
 */
import { getDb } from './db.js';
import {
  REFERRAL_HOLDBACK_DAYS,
  REFERRAL_MAX_PAYABLE_PER_MONTH,
  cumulativeEarnedUsd,
  milestonesReached,
  nextMilestone,
  type Milestone,
} from '../beta/referral-ladder.js';

const DAY_MS = 86_400_000;

/**
 * Code alphabet: no 0/O/1/I/L. These get read aloud, typed from a phone, and
 * pasted out of a DM — an ambiguous character costs a referral.
 */
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const CODE_LEN = 6;

export function isReferralCode(v: string): boolean {
  return new RegExp(`^[${CODE_ALPHABET}]{${CODE_LEN}}$`).test(v.toLowerCase());
}

function makeCode(): string {
  let s = '';
  for (let i = 0; i < CODE_LEN; i++) {
    s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return s;
}

/**
 * That user's referral code, minting one on first ask. The code lives on their
 * beta_testers row, so it survives claimHandleRow's rekey from @handle to the
 * numeric id — the row moves, the code moves with it.
 */
export async function getOrMintReferralCode(
  platform: string,
  userId: string,
): Promise<string | null> {
  const db = getDb();
  if (!db) return null;

  const { data, error } = await db
    .from('beta_testers')
    .select('referral_code')
    .eq('platform', platform)
    .eq('platform_id', userId)
    .limit(1);
  if (error) {
    console.warn(`[referral] code lookup: ${error.message}`);
    return null;
  }
  const existing = (data?.[0] as { referral_code: string | null } | undefined)?.referral_code;
  if (existing) return existing;

  // Retry on collision: the unique index is the arbiter, not a pre-check.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = makeCode();
    const { error: e2 } = await db
      .from('beta_testers')
      .update({ referral_code: code })
      .eq('platform', platform)
      .eq('platform_id', userId)
      .is('referral_code', null);
    if (!e2) {
      // Re-read: a concurrent caller may have won and set a different code.
      const { data: after } = await db
        .from('beta_testers')
        .select('referral_code')
        .eq('platform', platform)
        .eq('platform_id', userId)
        .limit(1);
      const got = (after?.[0] as { referral_code: string | null } | undefined)?.referral_code;
      if (got) return got;
    }
  }
  console.warn(`[referral] could not mint a code for ${platform}:${userId}`);
  return null;
}

/** Who owns a code. Null when it doesn't exist. */
export async function ownerOfCode(
  code: string,
): Promise<{ platform: string; platformId: string } | null> {
  const db = getDb();
  if (!db || !isReferralCode(code)) return null;
  const { data, error } = await db
    .from('beta_testers')
    .select('platform, platform_id')
    .eq('referral_code', code.toLowerCase())
    .limit(1);
  if (error) {
    console.warn(`[referral] ownerOfCode: ${error.message}`);
    return null;
  }
  const row = data?.[0] as { platform: string; platform_id: string } | undefined;
  return row ? { platform: row.platform, platformId: row.platform_id } : null;
}

export type RecordOutcome =
  | 'recorded'
  | 'self_referral'
  | 'already_referred'
  | 'unknown_code'
  | 'unavailable';

/**
 * Attach a new user to whoever referred them. Best-effort and never throws.
 *
 * Two guards, and the second one is the DB's job on purpose: application-level
 * "check then insert" races, a unique index does not.
 */
export async function recordReferral(args: {
  code: string;
  referredPlatform: string;
  referredPlatformId: string;
  referredHandle?: string;
  visitorId?: string | null;
}): Promise<RecordOutcome> {
  const db = getDb();
  if (!db) return 'unavailable';
  const code = args.code.toLowerCase();
  if (!isReferralCode(code)) return 'unknown_code';

  const owner = await ownerOfCode(code);
  if (!owner) return 'unknown_code';

  // Self-referral, on both identifiers. The handle form matters: a paid grant
  // lands under '@handle' until the bot rekeys it, so the same human can be
  // '@bob' and '1234' at once.
  const referredHandleKey = args.referredHandle ? `@${args.referredHandle.toLowerCase()}` : null;
  if (
    owner.platform === args.referredPlatform &&
    (owner.platformId === args.referredPlatformId || owner.platformId === referredHandleKey)
  ) {
    return 'self_referral';
  }

  const { error } = await db.from('referrals').insert({
    code,
    referrer_platform: owner.platform,
    referrer_platform_id: owner.platformId,
    referred_platform: args.referredPlatform,
    referred_platform_id: args.referredPlatformId,
    visitor_id: args.visitorId ?? null,
    status: 'pending',
    meta: args.referredHandle ? { handle: args.referredHandle.toLowerCase() } : {},
  });
  if (error) {
    // 23505 = unique violation = they were already referred by someone. First
    // referrer wins, permanently; that IS the rule, so this is not an error.
    if (error.code === '23505') return 'already_referred';
    console.warn(`[referral] recordReferral: ${error.message}`);
    return 'unavailable';
  }
  console.log(
    `[referral] ${args.referredPlatform}:${args.referredPlatformId} referred by ${owner.platform}:${owner.platformId} (${code})`,
  );
  return 'recorded';
}

interface ReferralRow {
  id: number;
  referrer_platform: string;
  referrer_platform_id: string;
  referred_platform: string;
  referred_platform_id: string;
  converted_at: string | null;
  status: string;
  meta: { handle?: string } | null;
}

interface PaidTester {
  platform: string;
  platform_id: string;
  subscription_provider: string | null;
  subscription_id: string | null;
  subscription_status: string | null;
}

export interface SettleResult {
  converted: number;
  qualified: number;
  payouts: number;
}

/**
 * Advance every referral as far as the facts allow. Idempotent: safe to run on
 * a timer, and safe to run twice at once.
 *
 *   pending   -> converted   the referred user now has an active subscription
 *   converted -> qualified   the conversion survived the holdback
 *   qualified -> payouts     milestone rows inserted for newly reached rungs
 *
 * Matching is done in memory against the whole tester table rather than with a
 * join per referral: that table is tiny (~60 rows) and will be for a long time,
 * and it lets one query cover BOTH the numeric id and the '@handle' form a
 * freshly-paid row still carries.
 */
export async function settleReferrals(): Promise<SettleResult> {
  const db = getDb();
  const out: SettleResult = { converted: 0, qualified: 0, payouts: 0 };
  if (!db) return out;

  const { data: openRows, error: e1 } = await db
    .from('referrals')
    .select(
      'id, referrer_platform, referrer_platform_id, referred_platform, referred_platform_id, converted_at, status, meta',
    )
    .in('status', ['pending', 'converted'])
    .limit(1000);
  if (e1) {
    console.warn(`[referral] settle load: ${e1.message}`);
    return out;
  }
  const open = (openRows ?? []) as ReferralRow[];
  if (!open.length) return out;

  // ---- pending -> converted -------------------------------------------------
  const pending = open.filter((r) => r.status === 'pending');
  if (pending.length) {
    const { data: paidRows, error: e2 } = await db
      .from('beta_testers')
      .select('platform, platform_id, subscription_provider, subscription_id, subscription_status')
      .not('subscription_provider', 'is', null);
    if (e2) {
      console.warn(`[referral] settle testers: ${e2.message}`);
    } else {
      const paid = new Map<string, PaidTester>();
      for (const t of (paidRows ?? []) as PaidTester[]) {
        if ((t.subscription_status ?? 'active') !== 'active') continue;
        paid.set(`${t.platform}:${String(t.platform_id).toLowerCase()}`, t);
      }
      for (const r of pending) {
        const byId = paid.get(`${r.referred_platform}:${r.referred_platform_id.toLowerCase()}`);
        const byHandle = r.meta?.handle
          ? paid.get(`${r.referred_platform}:@${r.meta.handle.toLowerCase()}`)
          : undefined;
        const hit = byId ?? byHandle;
        if (!hit) continue;
        const { error } = await db
          .from('referrals')
          .update({
            status: 'converted',
            converted_at: new Date().toISOString(),
            subscription_provider: hit.subscription_provider,
            subscription_id: hit.subscription_id,
          })
          .eq('id', r.id)
          .eq('status', 'pending'); // guard: don't re-stamp a row someone else moved
        if (error) console.warn(`[referral] mark converted ${r.id}: ${error.message}`);
        else {
          out.converted++;
          r.status = 'converted';
          r.converted_at = new Date().toISOString();
        }
      }
    }
  }

  // ---- converted -> qualified (holdback expired) ----------------------------
  const cutoff = Date.now() - REFERRAL_HOLDBACK_DAYS * DAY_MS;
  const ripe = open.filter(
    (r) => r.status === 'converted' && r.converted_at && new Date(r.converted_at).getTime() <= cutoff,
  );
  for (const r of ripe) {
    const { error } = await db
      .from('referrals')
      .update({ status: 'qualified', qualified_at: new Date().toISOString() })
      .eq('id', r.id)
      .eq('status', 'converted');
    if (error) console.warn(`[referral] qualify ${r.id}: ${error.message}`);
    else out.qualified++;
  }

  // ---- milestones -----------------------------------------------------------
  // Only referrers who just gained a qualified referral can have crossed a rung.
  const touched = new Set(ripe.map((r) => `${r.referrer_platform} ${r.referrer_platform_id}`));
  for (const key of touched) {
    const [platform, platformId] = key.split(' ') as [string, string];
    out.payouts += await awardMilestones(platform, platformId);
  }

  if (out.converted || out.qualified || out.payouts) {
    console.log(
      `[referral] settled: ${out.converted} converted, ${out.qualified} qualified, ${out.payouts} payout(s)`,
    );
  }
  return out;
}

/**
 * Insert payout rows for any rung this referrer has reached and not been
 * credited for. The unique index on (referrer, milestone_refs) is what makes
 * double-payment impossible — a duplicate insert is EXPECTED under concurrency
 * and is swallowed, not logged as a failure.
 */
async function awardMilestones(platform: string, platformId: string): Promise<number> {
  const db = getDb();
  if (!db) return 0;

  const { count, error: e1 } = await db
    .from('referrals')
    .select('id', { count: 'exact', head: true })
    .eq('referrer_platform', platform)
    .eq('referrer_platform_id', platformId)
    .eq('status', 'qualified');
  if (e1) {
    console.warn(`[referral] count qualified: ${e1.message}`);
    return 0;
  }
  const qualified = count ?? 0;
  const reached = milestonesReached(qualified);
  if (!reached.length) return 0;

  const { data: existing, error: e2 } = await db
    .from('referral_payouts')
    .select('milestone_refs, cumulative_usd, reached_at')
    .eq('referrer_platform', platform)
    .eq('referrer_platform_id', platformId);
  if (e2) {
    console.warn(`[referral] load payouts: ${e2.message}`);
    return 0;
  }
  const rows = (existing ?? []) as { milestone_refs: number; cumulative_usd: number; reached_at: string }[];
  const already = new Set(rows.map((r) => r.milestone_refs));
  const missing = reached.filter((m) => !already.has(m.refs));
  if (!missing.length) return 0;

  // Circuit breaker: an unusual burst of milestones inside one month is the
  // shape farming takes. Hold them for a human rather than marking them payable.
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const thisMonth = rows.filter((r) => new Date(r.reached_at) >= monthStart).length;

  let paidSoFar = rows.reduce((max, r) => Math.max(max, Number(r.cumulative_usd)), 0);
  let inserted = 0;
  for (const [i, m] of missing.sort((a, b) => a.refs - b.refs).entries()) {
    const topup = Number((m.cumulativeUsd - paidSoFar).toFixed(2));
    const overCap = thisMonth + i + 1 > REFERRAL_MAX_PAYABLE_PER_MONTH;
    const { error } = await db.from('referral_payouts').insert({
      referrer_platform: platform,
      referrer_platform_id: platformId,
      milestone_refs: m.refs,
      cumulative_usd: m.cumulativeUsd,
      topup_usd: topup,
      status: overCap ? 'held' : 'payable',
      note: overCap ? `over ${REFERRAL_MAX_PAYABLE_PER_MONTH}/month — review before paying` : null,
    });
    if (error) {
      // 23505 = another settle run got there first. That is the guard working.
      if (error.code !== '23505') console.warn(`[referral] award ${m.refs}: ${error.message}`);
      continue;
    }
    paidSoFar = m.cumulativeUsd;
    inserted++;
    console.log(
      `[referral] ${platform}:${platformId} reached ${m.refs} referrals — $${topup} top-up (total $${m.cumulativeUsd})${overCap ? ' [HELD]' : ''}`,
    );
  }
  return inserted;
}

/** Void a referral whose payment was refunded inside the holdback. */
export async function voidReferralForRefund(
  platform: string,
  platformIdOrHandle: string,
): Promise<void> {
  const db = getDb();
  if (!db) return;
  const { error } = await db
    .from('referrals')
    .update({ status: 'void', meta: { voided: 'refund' } })
    .eq('referred_platform', platform)
    .eq('referred_platform_id', platformIdOrHandle)
    .in('status', ['pending', 'converted']); // never claw back a qualified rung
  if (error) console.warn(`[referral] void on refund: ${error.message}`);
}

export interface ReferralStats {
  code: string | null;
  pending: number;
  converted: number;
  qualified: number;
  earnedUsd: number;
  paidUsd: number;
  next: Milestone | null;
}

/** What to show someone who asks for their link. */
export async function referralStats(platform: string, userId: string): Promise<ReferralStats> {
  const empty: ReferralStats = {
    code: null, pending: 0, converted: 0, qualified: 0, earnedUsd: 0, paidUsd: 0, next: nextMilestone(0),
  };
  const db = getDb();
  if (!db) return empty;

  const code = await getOrMintReferralCode(platform, userId);
  const { data: rows, error } = await db
    .from('referrals')
    .select('status')
    .eq('referrer_platform', platform)
    .eq('referrer_platform_id', userId);
  if (error) {
    console.warn(`[referral] stats: ${error.message}`);
    return { ...empty, code };
  }
  const counts = { pending: 0, converted: 0, qualified: 0 };
  for (const r of (rows ?? []) as { status: string }[]) {
    if (r.status === 'pending') counts.pending++;
    else if (r.status === 'converted') counts.converted++;
    else if (r.status === 'qualified') counts.qualified++;
  }

  const { data: payouts } = await db
    .from('referral_payouts')
    .select('topup_usd, status')
    .eq('referrer_platform', platform)
    .eq('referrer_platform_id', userId);
  const paidUsd = ((payouts ?? []) as { topup_usd: number; status: string }[])
    .filter((p) => p.status === 'paid')
    .reduce((s, p) => s + Number(p.topup_usd), 0);

  return {
    code,
    ...counts,
    earnedUsd: cumulativeEarnedUsd(counts.qualified),
    paidUsd,
    next: nextMilestone(counts.qualified),
  };
}
