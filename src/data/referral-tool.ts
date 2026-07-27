import { z } from 'zod';
import { Tool, zValidator } from './registry.js';
import { referralStats } from '../memory/referral.js';
import { getConfig } from '../config.js';
import { REFERRAL_MILESTONES } from '../beta/referral-ladder.js';

/**
 * The user's own refer-&-earn link and progress.
 *
 * Deliberately NARROW. The description names only explicit referral asks and
 * gives no reason to fire on anything adjacent — a tool that volunteers itself
 * into "how do I get more people in my server" would hijack a real question and
 * turn Pip into a salesman. Referrals are something the user asks for, never
 * something Pip brings up.
 */
const InputSchema = z.object({});
type Input = z.infer<typeof InputSchema>;

interface Output {
  link: string | null;
  code: string | null;
  claim_phrase: string | null;
  referred_pending: number;
  referred_paying: number;
  qualified: number;
  earned_usd: number;
  paid_usd: number;
  next_milestone: { referrals_needed: number; total_earned_at_that_point_usd: number } | null;
  ladder: Array<{ referrals: number; total_usd: number }>;
  holdback_note: string;
}

export const referralLinkTool: Tool<Input, Output> = {
  name: 'referral_link',
  description:
    "The user's OWN refer-and-earn link, referral code, and how much they've earned so far. Use ONLY when the user explicitly asks about referring, their referral link or code, or their referral earnings — for example \"what's my referral link\", \"how do I refer someone\", \"how much have I earned from referrals\". Do NOT use it for general growth, marketing or how-to-promote questions, and never bring referrals up unprompted.",
  inputSchema: { type: 'object', properties: {} },
  validate: zValidator(InputSchema),
  execute: async (_input, ctx) => {
    const stats = await referralStats(ctx.platform, ctx.userId);
    const base = (getConfig().PIP_SITE_BASE_URL || 'https://pipinvest.xyz').replace(/\/+$/, '');
    return {
      link: stats.code ? `${base}/r/${stats.code}` : null,
      code: stats.code,
      // Discord invites carry no per-visitor parameter, so a Discord friend
      // claims the code by pasting this to Pip instead.
      claim_phrase: stats.code ? `ref ${stats.code}` : null,
      referred_pending: stats.pending,
      referred_paying: stats.converted,
      qualified: stats.qualified,
      earned_usd: stats.earnedUsd,
      paid_usd: stats.paidUsd,
      next_milestone: stats.next
        ? {
            referrals_needed: stats.next.refs - stats.qualified,
            total_earned_at_that_point_usd: stats.next.cumulativeUsd,
          }
        : null,
      ladder: REFERRAL_MILESTONES.map((m) => ({ referrals: m.refs, total_usd: m.cumulativeUsd })),
      holdback_note:
        'A referral counts once the person they referred has been a paying subscriber for 7 days. Amounts are cumulative totals, not per referral.',
    };
  },
  citation: () => ({ label: 'Your referral link' }),
};
