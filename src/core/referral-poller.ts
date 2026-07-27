import { settleReferrals } from '../memory/referral.js';

/**
 * Advances referrals on a timer.
 *
 * This exists because qualification is TIME-driven, not event-driven: a
 * referral qualifies REFERRAL_HOLDBACK_DAYS after the payment, a moment when
 * nobody is sending a message and no webhook is firing. Hanging settlement off
 * user activity alone would mean a referrer only gets paid if someone happens
 * to talk to Pip after the window closes.
 *
 * Deliberately slow. The holdback is measured in days, so there is nothing to
 * gain from polling hard, and settleReferrals reads the whole open-referral set
 * each pass.
 *
 * Same caveat as alert-poller.ts: this only runs while THIS process is up. A
 * missed window is not lost, though — settlement is idempotent and catches up
 * on the next pass, because it works from stored timestamps rather than from
 * "what changed since last time".
 */
const POLL_INTERVAL_MS = 30 * 60_000;

let timer: NodeJS.Timeout | null = null;

async function tick(): Promise<void> {
  try {
    await settleReferrals();
  } catch (e) {
    // Never let a settlement error kill the interval — the next pass retries.
    console.warn(`[referral-poller] ${(e as Error).message}`);
  }
}

export function startReferralPoller(): void {
  if (timer) return;
  void tick(); // catch up on anything that ripened while the process was down
  timer = setInterval(() => void tick(), POLL_INTERVAL_MS);
  timer.unref?.();
  console.log(`[referral-poller] started (every ${POLL_INTERVAL_MS / 60_000}m)`);
}

export function stopReferralPoller(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
