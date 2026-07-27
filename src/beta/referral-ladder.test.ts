/**
 * The referral ladder's safety proof, as executable assertions.
 *
 * The first version of refer-&-earn was a flat $20 per paying referral. Lite is
 * $12/mo, so anyone could pay $12, refer themselves and walk away +$8. The
 * ladder fixes it, but only while every rung stays under what those referrals
 * actually paid — and that property is invisible by inspection once someone
 * "just bumps the first tier to $15" a year from now.
 *
 * So it is a test. If you change REFERRAL_MILESTONES and this fails, the LADDER
 * is wrong. Do not weaken the assertions to make it pass.
 *
 * Run: npm run test:ladder
 */
import {
  REFERRAL_MILESTONES,
  CHEAPEST_PLAN_USD,
  COGS_PER_USER_MONTH_USD,
  cumulativeEarnedUsd,
  milestonesReached,
  nextMilestone,
  selfReferralNetUsd,
  worstCaseMarginUsd,
} from './referral-ladder.js';

let pass = 0;
const fails: string[] = [];
const check = (name: string, cond: boolean) => {
  if (cond) pass++;
  else fails.push(name);
};
const eq = (name: string, got: unknown, want: unknown) =>
  check(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, got === want);

// ---- THE INVARIANT ---------------------------------------------------------
for (const m of REFERRAL_MILESTONES) {
  const theyPaid = m.refs * CHEAPEST_PLAN_USD;

  // 1. No self-referral arb: farming N accounts costs more than it earns.
  check(
    `rung ${m.refs}: $${m.cumulativeUsd} earned < $${theyPaid} paid (no arb)`,
    m.cumulativeUsd < theyPaid,
  );
  check(
    `rung ${m.refs}: self-referrer loses money (${selfReferralNetUsd(m)})`,
    selfReferralNetUsd(m) < 0,
  );

  // 2. Pip profits at every rung, worst case (everyone on the cheapest plan).
  check(
    `rung ${m.refs}: Pip nets $${worstCaseMarginUsd(m).toFixed(2)} > 0`,
    worstCaseMarginUsd(m) > 0,
  );

  // 3. The reward alone must not exceed gross revenue less COGS. Same thing as
  //    (2) stated the other way round; kept explicit because it is the sentence
  //    a future reader will actually be checking.
  check(
    `rung ${m.refs}: reward under revenue-minus-COGS`,
    m.cumulativeUsd < theyPaid - m.refs * COGS_PER_USER_MONTH_USD,
  );
}

// ---- ladder shape ----------------------------------------------------------
for (let i = 1; i < REFERRAL_MILESTONES.length; i++) {
  const prev = REFERRAL_MILESTONES[i - 1]!;
  const cur = REFERRAL_MILESTONES[i]!;
  check(`rung ${cur.refs}: refs strictly increasing`, cur.refs > prev.refs);
  check(`rung ${cur.refs}: cumulative strictly increasing`, cur.cumulativeUsd > prev.cumulativeUsd);
}
check('ladder is not empty', REFERRAL_MILESTONES.length > 0);
check('first rung is reachable by one referral', REFERRAL_MILESTONES[0]!.refs === 1);

// Top-ups must sum to the final cumulative, or someone is paid twice / short.
const topups = REFERRAL_MILESTONES.map(
  (m, i) => m.cumulativeUsd - (i === 0 ? 0 : REFERRAL_MILESTONES[i - 1]!.cumulativeUsd),
);
check('every top-up is positive', topups.every((t) => t > 0));
eq(
  'top-ups sum to the final cumulative',
  Number(topups.reduce((a, b) => a + b, 0).toFixed(2)),
  REFERRAL_MILESTONES[REFERRAL_MILESTONES.length - 1]!.cumulativeUsd,
);

// ---- helpers ---------------------------------------------------------------
eq('0 referrals reaches nothing', milestonesReached(0).length, 0);
eq('0 referrals has earned nothing', cumulativeEarnedUsd(0), 0);
eq('1 referral earns the first rung', cumulativeEarnedUsd(1), REFERRAL_MILESTONES[0]!.cumulativeUsd);
eq('2 referrals still on the first rung', cumulativeEarnedUsd(2), REFERRAL_MILESTONES[0]!.cumulativeUsd);
eq('3 referrals earns $20', cumulativeEarnedUsd(3), 20);
eq('4 referrals still $20', cumulativeEarnedUsd(4), 20);
eq('9 referrals earns $70', cumulativeEarnedUsd(9), 70);
eq('25 referrals earns $150', cumulativeEarnedUsd(25), 150);
eq('beyond the top rung stays at the top', cumulativeEarnedUsd(1000), 150);

eq('next rung from 0 is 1 referral', nextMilestone(0)?.refs, 1);
eq('next rung from 1 is 3 referrals', nextMilestone(1)?.refs, 3);
eq('next rung from 24 is 25', nextMilestone(24)?.refs, 25);
eq('no next rung past the top', nextMilestone(25), null);

// A rung is reached at exactly its threshold, not one past it.
eq('rung 3 reached at exactly 3', milestonesReached(3).some((m) => m.refs === 3), true);
eq('rung 3 not reached at 2', milestonesReached(2).some((m) => m.refs === 3), false);

// ---- report ----------------------------------------------------------------
console.log('\nLadder economics (worst case: every referral on the cheapest plan, monthly)\n');
console.log('  refs  earned  top-up   they paid    COGS    Pip nets   self-referrer');
REFERRAL_MILESTONES.forEach((m, i) => {
  const usd = (n: number) => `$${n.toFixed(2)}`.padStart(9);
  console.log(
    `  ${String(m.refs).padStart(4)}  ${usd(m.cumulativeUsd)} ${usd(topups[i]!)}  ` +
      `${usd(m.refs * CHEAPEST_PLAN_USD)} ${usd(m.refs * COGS_PER_USER_MONTH_USD)}  ` +
      `${usd(worstCaseMarginUsd(m))}  ${usd(selfReferralNetUsd(m))}`,
  );
});

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  for (const f of fails) console.error(`  FAIL: ${f}`);
  process.exit(1);
}
