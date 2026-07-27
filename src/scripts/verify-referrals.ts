/**
 * Live round-trip for refer & earn against the real schema.
 *
 * Uses platform '__test__' throughout so nothing can collide with a real user,
 * and deletes everything it created at the end. The guards worth proving here
 * (referred-once, milestone-once) are UNIQUE INDEXES, so a faked database would
 * not exercise the thing that actually protects the money.
 */
import 'dotenv/config';
import { getDb } from '../memory/db.js';
import {
  getOrMintReferralCode,
  recordReferral,
  settleReferrals,
  referralStats,
} from '../memory/referral.js';

const P = '__test__';
const REFERRER = 'ref-owner';
const FRIENDS = ['friend-a', 'friend-b', 'friend-c'];

let pass = 0;
const fails: string[] = [];
const check = (n: string, c: boolean) => { if (c) pass++; else fails.push(n); };
const eq = (n: string, got: unknown, want: unknown) =>
  check(`${n} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, got === want);

const db = getDb();
if (!db) { console.error('no db'); process.exit(1); }

async function cleanup() {
  await db!.from('referral_payouts').delete().eq('referrer_platform', P);
  await db!.from('referrals').delete().eq('referrer_platform', P);
  await db!.from('referrals').delete().eq('referred_platform', P);
  await db!.from('beta_testers').delete().eq('platform', P);
}

async function main() {
  await cleanup();

  // Seed the referrer and three friends as testers.
  for (const id of [REFERRER, ...FRIENDS]) {
    await db!.from('beta_testers').insert({ platform: P, platform_id: id, name: id }).throwOnError();
  }

  // ---- code minting --------------------------------------------------------
  const code = await getOrMintReferralCode(P, REFERRER);
  check('code minted', Boolean(code && /^[a-hj-km-np-z2-9]{6}$/.test(code)));
  eq('code is stable on re-ask', await getOrMintReferralCode(P, REFERRER), code);

  // ---- guards --------------------------------------------------------------
  eq('self-referral rejected', await recordReferral({
    code: code!, referredPlatform: P, referredPlatformId: REFERRER,
  }), 'self_referral');

  eq('unknown code rejected', await recordReferral({
    code: 'zzzzzz', referredPlatform: P, referredPlatformId: FRIENDS[0]!,
  }), 'unknown_code');

  eq('first referral records', await recordReferral({
    code: code!, referredPlatform: P, referredPlatformId: FRIENDS[0]!,
  }), 'recorded');

  // The unique index is the guard, not app logic.
  eq('same person cannot be referred twice', await recordReferral({
    code: code!, referredPlatform: P, referredPlatformId: FRIENDS[0]!,
  }), 'already_referred');

  for (const f of FRIENDS.slice(1)) {
    eq(`referral recorded for ${f}`, await recordReferral({
      code: code!, referredPlatform: P, referredPlatformId: f,
    }), 'recorded');
  }

  // ---- nothing settles while nobody has paid -------------------------------
  let r = await settleReferrals();
  eq('no conversions before anyone pays', r.converted, 0);
  const s0 = await referralStats(P, REFERRER);
  eq('3 pending', s0.pending, 3);
  eq('nothing earned yet', s0.earnedUsd, 0);
  eq('next rung is 1 referral', s0.next?.refs, 1);

  // ---- one friend pays -----------------------------------------------------
  await db!.from('beta_testers')
    .update({ subscription_provider: 'dodo', subscription_id: 'sub_test_1', subscription_status: 'active' })
    .eq('platform', P).eq('platform_id', FRIENDS[0]!).throwOnError();

  r = await settleReferrals();
  eq('one conversion detected', r.converted, 1);
  eq('but nothing qualifies yet (holdback)', r.qualified, 0);
  eq('and no payout yet', r.payouts, 0);

  const s1 = await referralStats(P, REFERRER);
  eq('1 converted', s1.converted, 1);
  eq('still $0 earned during holdback', s1.earnedUsd, 0);

  // ---- fast-forward past the holdback --------------------------------------
  const old = new Date(Date.now() - 8 * 86_400_000).toISOString();
  await db!.from('referrals').update({ converted_at: old })
    .eq('referrer_platform', P).eq('status', 'converted').throwOnError();

  r = await settleReferrals();
  eq('one qualifies', r.qualified, 1);
  eq('first milestone awarded', r.payouts, 1);

  const { data: pay1 } = await db!.from('referral_payouts').select('*').eq('referrer_platform', P);
  eq('exactly one payout row', pay1?.length, 1);
  eq('milestone is the 1-referral rung', pay1?.[0]?.milestone_refs, 1);
  eq('cumulative $5', Number(pay1?.[0]?.cumulative_usd), 5);
  eq('top-up $5', Number(pay1?.[0]?.topup_usd), 5);
  eq('status payable', pay1?.[0]?.status, 'payable');

  // ---- idempotency: settling again must not pay twice ----------------------
  r = await settleReferrals();
  eq('second settle awards nothing', r.payouts, 0);
  const { data: pay2 } = await db!.from('referral_payouts').select('id').eq('referrer_platform', P);
  eq('still exactly one payout row', pay2?.length, 1);

  const s2 = await referralStats(P, REFERRER);
  eq('1 qualified', s2.qualified, 1);
  eq('$5 earned', s2.earnedUsd, 5);
  eq('$0 paid out so far', s2.paidUsd, 0);
  eq('next rung is 3 referrals', s2.next?.refs, 3);

  // ---- reach the 3-referral rung -------------------------------------------
  for (const f of FRIENDS.slice(1)) {
    await db!.from('beta_testers')
      .update({ subscription_provider: 'moonpay', subscription_id: `sub_${f}`, subscription_status: 'active' })
      .eq('platform', P).eq('platform_id', f).throwOnError();
  }
  await settleReferrals(); // pending -> converted
  await db!.from('referrals').update({ converted_at: old })
    .eq('referrer_platform', P).eq('status', 'converted').throwOnError();
  r = await settleReferrals();
  eq('two more qualify', r.qualified, 2);
  eq('the 3-referral rung is awarded', r.payouts, 1);

  const { data: pay3 } = await db!.from('referral_payouts')
    .select('milestone_refs, cumulative_usd, topup_usd').eq('referrer_platform', P)
    .order('milestone_refs');
  eq('two payout rows now', pay3?.length, 2);
  eq('second rung cumulative $20', Number(pay3?.[1]?.cumulative_usd), 20);
  // The top-up is the DIFFERENCE, not the whole amount — paying $20 again here
  // would be a $5 overpayment on every referrer who ever crosses this rung.
  eq('second rung top-up is $15, not $20', Number(pay3?.[1]?.topup_usd), 15);

  const s3 = await referralStats(P, REFERRER);
  eq('3 qualified', s3.qualified, 3);
  eq('$20 earned total', s3.earnedUsd, 20);
  eq('next rung is 5', s3.next?.refs, 5);

  console.log(`\n${pass} passed, ${fails.length} failed`);
  for (const f of fails) console.error(`  FAIL: ${f}`);
}

main()
  .catch((e) => { console.error(e); fails.push(`threw: ${e.message}`); })
  .finally(async () => {
    await cleanup();
    const { count } = await db!.from('referrals').select('id', { count: 'exact', head: true }).eq('referrer_platform', P);
    console.log(`cleanup: ${count ?? 0} test referral rows left (want 0)`);
    process.exit(fails.length ? 1 : 0);
  });
