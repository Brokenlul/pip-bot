/**
 * The refer-&-earn reward ladder, and the arithmetic that keeps it safe.
 *
 * A referrer earns cash when someone they referred becomes a PAYING subscriber.
 * The amounts are CUMULATIVE — the number is everything earned so far, and
 * reaching a rung pays the difference (the "top-up"), not the whole amount
 * again.
 *
 * WHY A LADDER AND NOT A FLAT BOUNTY. The first design was a flat $20 per
 * paying referral. Lite is $12/mo, so anyone could pay $12, refer themselves,
 * and walk away +$8 — a flat bounty above the cheapest plan price is always
 * arbitrageable. Every rung below stays under what those referrals actually
 * paid, so self-referral loses money at every level:
 *
 *   refs  earned  top-up   they paid   COGS    Pip nets   self-referrer
 *      1      $5      $5         $12   $3.60      +$3.40           -$7
 *      3     $20     $15         $36  $10.80      +$5.20          -$16
 *      5     $40     $20         $60  $18.00      +$2.00          -$20
 *      9     $70     $30        $108  $32.40      +$5.60          -$38
 *     25    $150     $80        $300  $90.00     +$60.00         -$150
 *
 * Worst case throughout: every referral on the cheapest plan, monthly. Anything
 * on Pro, Server Pro or yearly is strictly better, and because each milestone
 * pays once, every month after the first is pure margin.
 *
 * THE INVARIANT, enforced by pip-site/test/referral-ladder.test.mjs:
 *   cumulativeUsd < refs * CHEAPEST_PLAN_USD          (no self-referral arb)
 *   worstCaseMarginUsd(rung) > 0                       (Pip profits at every rung)
 * If you change the ladder and that test fails, the ladder is wrong. Do not
 * weaken the test to make it pass.
 */

export interface Milestone {
  /** Qualified referrals needed to reach this rung. */
  refs: number;
  /** TOTAL earned at this rung, not the increment. */
  cumulativeUsd: number;
}

export const REFERRAL_MILESTONES: readonly Milestone[] = [
  { refs: 1, cumulativeUsd: 5 },
  { refs: 3, cumulativeUsd: 20 },
  { refs: 5, cumulativeUsd: 40 },
  { refs: 9, cumulativeUsd: 70 },
  { refs: 25, cumulativeUsd: 150 },
] as const;

/**
 * Days a conversion must survive before it counts. Covers the refund and
 * chargeback window: without it, someone pays, triggers a payout, and refunds.
 */
export const REFERRAL_HOLDBACK_DAYS = 7;

/** personal-lite monthly. The floor the whole ladder is safe against. */
export const CHEAPEST_PLAN_USD = 12;

/** Measured, not guessed: $0.12/day for the median active user (2026-07-27). */
export const COGS_PER_USER_MONTH_USD = 3.6;

/**
 * Circuit breaker. Beyond this many milestone payouts in a calendar month, a
 * referrer's rewards land as `held` for a human to look at instead of `payable`.
 * Nothing is ever auto-sent regardless — this just flags the shape of abuse.
 */
export const REFERRAL_MAX_PAYABLE_PER_MONTH = 3;

/** Every rung reached at this many qualified referrals. */
export function milestonesReached(qualifiedCount: number): Milestone[] {
  return REFERRAL_MILESTONES.filter((m) => qualifiedCount >= m.refs);
}

/** The rung they're working towards — the motivation, so always show it. */
export function nextMilestone(qualifiedCount: number): Milestone | null {
  return REFERRAL_MILESTONES.find((m) => qualifiedCount < m.refs) ?? null;
}

/** Total cash earned at this count. */
export function cumulativeEarnedUsd(qualifiedCount: number): number {
  const reached = milestonesReached(qualifiedCount);
  return reached.length ? reached[reached.length - 1]!.cumulativeUsd : 0;
}

/** What Pip keeps at a rung, worst case. Exported so the test can assert it. */
export function worstCaseMarginUsd(m: Milestone): number {
  return m.refs * CHEAPEST_PLAN_USD - m.refs * COGS_PER_USER_MONTH_USD - m.cumulativeUsd;
}

/** What a self-referrer nets. Must be NEGATIVE at every rung. */
export function selfReferralNetUsd(m: Milestone): number {
  return m.cumulativeUsd - m.refs * CHEAPEST_PLAN_USD;
}
