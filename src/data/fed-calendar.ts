import { z } from 'zod';
import { Tool, zValidator } from './registry.js';

/**
 * Hardcoded FOMC calendar through 2026. Per BUILD_GOAL.md M3: do not over-engineer macro.
 * Source: federalreserve.gov/monetarypolicy/fomccalendars.htm
 * POST-MVP: scrape this daily into Supabase `events` table.
 */
const FOMC_MEETINGS_UTC: ReadonlyArray<{ start: string; end: string; presser: boolean }> = [
  // 2026 meetings — two-day FOMC meetings; rate decision lands at 18:00 UTC on the second day
  { start: '2026-01-27', end: '2026-01-28', presser: true },
  { start: '2026-03-17', end: '2026-03-18', presser: true },
  { start: '2026-04-28', end: '2026-04-29', presser: true },
  { start: '2026-06-16', end: '2026-06-17', presser: true },
  { start: '2026-07-28', end: '2026-07-29', presser: true },
  { start: '2026-09-15', end: '2026-09-16', presser: true },
  { start: '2026-10-27', end: '2026-10-28', presser: true },
  { start: '2026-12-15', end: '2026-12-16', presser: true },
] as const;

const InputSchema = z.object({});
type Input = z.infer<typeof InputSchema>;

interface Output {
  next_meeting_starts_utc: string;
  next_decision_utc: string;
  days_until_decision: number;
  has_press_conference: boolean;
  source_url: string;
  upcoming_count: number;
}

function decisionUtcFor(meeting: { end: string }): Date {
  // Rate decision statement is typically 18:00 UTC (14:00 ET) on the meeting's final day.
  return new Date(`${meeting.end}T18:00:00Z`);
}

export const fedCalendarTool: Tool<Input, Output> = {
  name: 'next_fomc_meeting',
  description:
    'Get the date of the next upcoming FOMC (Fed) rate decision and how many days away it is. Use for questions about "next Fed meeting", "FOMC", "rate decision", "when does the Fed meet".',
  inputSchema: { type: 'object', properties: {}, required: [] },
  validate: zValidator(InputSchema),
  execute: async () => {
    const now = new Date();
    const upcoming = FOMC_MEETINGS_UTC.filter((m) => decisionUtcFor(m) > now);
    if (upcoming.length === 0) {
      throw new Error('No upcoming FOMC meetings in the embedded calendar — update fed-calendar.ts');
    }
    const next = upcoming[0]!;
    const decisionAt = decisionUtcFor(next);
    const days = Math.ceil((decisionAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
    return {
      next_meeting_starts_utc: new Date(`${next.start}T00:00:00Z`).toISOString(),
      next_decision_utc: decisionAt.toISOString(),
      days_until_decision: days,
      has_press_conference: next.presser,
      source_url: 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm',
      upcoming_count: upcoming.length,
    };
  },
  citation: () => ({
    label: 'FOMC calendar',
    url: 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm',
  }),
};
