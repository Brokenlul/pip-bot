import type { NormalizedMessage } from '../adapters/platform.js';
import { recordReferral, isReferralCode } from '../memory/referral.js';

/**
 * "ref abc123" — the manual half of refer & earn.
 *
 * Telegram gets referral attribution for free: the site's CTA is a deep link
 * and the code rides in the click's site_events meta. Discord has no such
 * handoff for a PERSONAL referral — a discord.gg invite accepts no per-visitor
 * parameter — so without this, Discord referrals would be impossible, which is
 * most of the audience.
 *
 * Handled before any model call: it's a fixed string match with a canned reply,
 * so it costs nothing and can't be talked out of by the model.
 *
 * Deliberately DM-only. A referral claim in a public channel would leak who
 * referred whom to the whole server, and invites people to spam codes at each
 * other in someone else's community.
 */
const CLAIM_RE = /^\s*ref\s+([a-z0-9]{6})\s*$/i;

/**
 * Returns the reply to send when this message was a referral claim, or null to
 * let it fall through to the normal answer path.
 */
export async function maybeClaimReferral(msg: NormalizedMessage): Promise<string | null> {
  if (!msg.guildId.startsWith('dm:')) return null;
  const m = CLAIM_RE.exec(msg.text ?? '');
  if (!m) return null;
  const code = m[1]!.toLowerCase();
  if (!isReferralCode(code)) return null;

  const outcome = await recordReferral({
    code,
    referredPlatform: msg.platform,
    referredPlatformId: msg.userId,
    referredHandle: msg.userName,
  });

  switch (outcome) {
    case 'recorded':
      return (
        "You're in 🌱 That referral is linked. Nothing changes for you — your friend earns " +
        'a reward if you end up subscribing. Ask me anything to get started.'
      );
    case 'self_referral':
      // Say it plainly rather than pretending it worked. Someone testing their
      // own link deserves to know why it didn't take.
      return "That's your own referral code, so it won't link to you. Share it with someone else and it'll work.";
    case 'already_referred':
      return "You're already linked to a referrer, and that only happens once. Nothing more to do 🌱";
    case 'unknown_code':
      return "I don't recognise that referral code. Double-check it with whoever sent it?";
    default:
      return "Couldn't record that just now, try again in a minute.";
  }
}
