import { z } from 'zod';
import { Tool, ToolContext, zValidator } from './registry.js';
import { getDb } from '../memory/db.js';
import { equityEarningsTool } from './finnhub.js';
import { reportInstant } from '../core/market-time.js';

/**
 * Earnings alerts — "ping me right before GOOGL reports".
 *
 * A user asked for exactly this and Pip told them to go set a manual calendar
 * reminder, because the alert system only understood Hyperliquid price levels.
 * This closes that: same push pipeline, same table (so list/cancel cover both
 * kinds over one id space), but TIME-triggered instead of level-triggered.
 *
 * Finnhub gives a reporting DAY plus before-open / after-close. That is not a
 * timestamp, so we anchor it (via core/market-time.ts) to when results
 * actually hit the wire in New York and subtract the user's lead time.
 */

export interface EarningsSchedule {
  earnings_date: string;
  earnings_when: string | null;
  report_at: Date;
  notify_at: Date;
}

/** Shared by the tool and the poller's re-verify step. */
export async function resolveEarningsSchedule(
  symbol: string,
  leadMinutes: number,
  ctx: ToolContext,
): Promise<EarningsSchedule> {
  const out = await equityEarningsTool.execute({ symbol }, ctx);
  if (!out.next_earnings_date) {
    throw new Error(`No scheduled earnings date published for "${symbol}" yet.`);
  }
  const reportAt = reportInstant(out.next_earnings_date, out.next_earnings_when);
  return {
    earnings_date: out.next_earnings_date,
    earnings_when: out.next_earnings_when,
    report_at: reportAt,
    notify_at: new Date(reportAt.getTime() - leadMinutes * 60_000),
  };
}

const SetSchema = z.object({
  symbol: z.string().min(1).describe('Stock ticker that is reporting, e.g. "GOOGL", "NVDA".'),
  lead_minutes: z
    .number()
    .int()
    .min(5)
    .max(10_080)
    .optional()
    .describe('How long BEFORE results hit to push the alert. Defaults to 60 minutes. Max 7 days.'),
  note: z.string().max(200).optional().describe('Short reminder of what to watch, e.g. "cloud margins + capex guide".'),
});
type SetInput = z.infer<typeof SetSchema>;

/**
 * 'scheduled'        — normal case, alert is queued for later.
 * 'imminent'         — the print is still AHEAD but closer than the requested
 *                      lead, so the alert fires on the next poll (~45s).
 * 'already_reported' — the published date is in the past. Nothing is set,
 *                      because an alert for it could only ever be wrong.
 *
 * Keeping 'imminent' and 'already_reported' distinct is the whole point: an
 * earlier version collapsed them by testing the NOTIFY time instead of the
 * REPORT time, so a 60-minute alert set 49 minutes before the bell reported
 * the print as already over. Never infer "it happened" from "the lead elapsed".
 */
type AlertStatus = 'scheduled' | 'imminent' | 'already_reported';

interface SetOutput {
  id: number | null;
  symbol: string;
  status: AlertStatus;
  earnings_date: string;
  earnings_when: string | null;
  report_at_utc: string;
  notify_at_utc: string | null;
  lead_minutes: number;
  minutes_until_report: number;
}

export const setEarningsAlertTool: Tool<SetInput, SetOutput> = {
  name: 'set_earnings_alert',
  description:
    "Set a push alert that fires shortly BEFORE a company reports earnings — Pip DMs the user ahead of the print without them asking again. Use whenever someone asks to be pinged/notified/reminded about an upcoming earnings report (\"alert me before GOOGL reports\", \"remind me when NVDA earnings are up\", \"ping me an hour before\"). This is a REAL outbound push; never tell a user to set a manual calendar reminder instead. Looks the reporting date up itself — do not ask the user for it. Default lead is 60 minutes before results hit the wire.",
  inputSchema: {
    type: 'object',
    properties: {
      symbol: { type: 'string', description: 'Stock ticker that is reporting, e.g. "GOOGL".' },
      lead_minutes: { type: 'number', description: 'Minutes before the print to fire. Default 60, max 10080 (7 days).' },
      note: { type: 'string', description: 'Optional short context for the push message.' },
    },
    required: ['symbol'],
  },
  validate: zValidator(SetSchema),
  execute: async (input, ctx) => {
    const db = getDb();
    if (!db) throw new Error('Earnings alerts need memory (Supabase) to be configured.');
    const symbol = input.symbol.trim().toUpperCase().replace(/^\$/, '');
    const lead = input.lead_minutes ?? 60;
    const sched = await resolveEarningsSchedule(symbol, lead, ctx);
    const now = Date.now();
    const minutesUntilReport = Math.round((sched.report_at.getTime() - now) / 60_000);

    // The provider keeps serving the date that just passed for a day or two
    // after a print, before rolling to next quarter. Setting an alert on that
    // stale date would push a "reports soon" for something already out, so
    // hand the state back and let Pip say so instead.
    if (sched.report_at.getTime() <= now) {
      return {
        id: null,
        symbol,
        status: 'already_reported',
        earnings_date: sched.earnings_date,
        earnings_when: sched.earnings_when,
        report_at_utc: sched.report_at.toISOString(),
        notify_at_utc: null,
        lead_minutes: lead,
        minutes_until_report: minutesUntilReport,
      };
    }

    // Re-asking about the same symbol should MOVE the existing alert, not stack
    // a second push for one print. The uniqueness rule is partial (active
    // earnings rows only), and Postgres won't accept a partial index as an
    // ON CONFLICT target, so resolve it explicitly. The index still stands as a
    // backstop against a genuine race.
    const fields = {
      kind: 'earnings' as const,
      channel_id: ctx.channelId ?? null,
      notify_at: sched.notify_at.toISOString(),
      earnings_date: sched.earnings_date,
      earnings_when: sched.earnings_when,
      lead_minutes: lead,
      note: input.note ?? null,
      active: true,
    };

    const { data: existing, error: findErr } = await db
      .from('price_alerts')
      .select('id')
      .eq('platform', ctx.platform)
      .eq('user_id', ctx.userId)
      .eq('symbol', symbol)
      .eq('kind', 'earnings')
      .eq('active', true)
      .maybeSingle();
    if (findErr) throw new Error(`set_earnings_alert lookup: ${findErr.message}`);

    let id: number;
    if (existing) {
      const { error } = await db.from('price_alerts').update(fields).eq('id', (existing as { id: number }).id);
      if (error) throw new Error(`set_earnings_alert update: ${error.message}`);
      id = (existing as { id: number }).id;
    } else {
      const { data, error } = await db
        .from('price_alerts')
        .insert({ platform: ctx.platform, guild_id: ctx.guildId, user_id: ctx.userId, symbol, ...fields })
        .select('id')
        .single();
      if (error) throw new Error(`set_earnings_alert insert: ${error.message}`);
      id = (data as { id: number }).id;
    }

    return {
      id,
      symbol,
      // The report is still ahead of us here — the only question is whether
      // there's enough runway left for the lead the user asked for.
      status: sched.notify_at.getTime() <= now ? 'imminent' : 'scheduled',
      earnings_date: sched.earnings_date,
      earnings_when: sched.earnings_when,
      report_at_utc: sched.report_at.toISOString(),
      notify_at_utc: sched.notify_at.toISOString(),
      lead_minutes: lead,
      minutes_until_report: minutesUntilReport,
    };
  },
  citation: () => ({ label: 'Pip earnings alert' }),
};
