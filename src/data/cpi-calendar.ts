import { z } from 'zod';
import { Tool, zValidator } from './registry.js';

/**
 * Hardcoded BLS CPI release calendar for 2026, mirroring fed-calendar.ts.
 * CPI is released ~8:30 AM ET; times below are pre-converted to UTC
 * (EST = UTC-5 in Jan/Feb/Dec, EDT = UTC-4 from Mar 8–Nov 1, 2026).
 * Source: https://www.bls.gov/schedule/news_release/cpi.htm
 * NOTE: BLS blocks scraping; verify these against the schedule if a date looks off.
 * POST-MVP: scrape the BLS schedule daily into the Supabase `events` table.
 */
const CPI_RELEASES_UTC: readonly string[] = [
  '2026-01-13T13:30:00Z', // Dec 2025 CPI
  '2026-02-11T13:30:00Z', // Jan 2026
  '2026-03-11T12:30:00Z', // Feb 2026
  '2026-04-10T12:30:00Z', // Mar 2026
  '2026-05-13T12:30:00Z', // Apr 2026
  '2026-06-10T12:30:00Z', // May 2026
  '2026-07-15T12:30:00Z', // Jun 2026
  '2026-08-12T12:30:00Z', // Jul 2026
  '2026-09-11T12:30:00Z', // Aug 2026
  '2026-10-13T12:30:00Z', // Sep 2026
  '2026-11-18T13:30:00Z', // Oct 2026
  '2026-12-10T13:30:00Z', // Nov 2026
] as const;

const InputSchema = z.object({});
type Input = z.infer<typeof InputSchema>;

interface Output {
  next_release_utc: string;
  days_until_release: number;
  upcoming_count: number;
  source_url: string;
}

export const cpiCalendarTool: Tool<Input, Output> = {
  name: 'next_cpi_release',
  description:
    'Get the date/time of the next US CPI (Consumer Price Index / inflation) data release from the BLS and how many days away it is. Use for questions about "next CPI", "when is inflation data out", "CPI print". For the actual inflation *number*, use the macro_indicator (FRED) tool instead.',
  inputSchema: { type: 'object', properties: {}, required: [] },
  validate: zValidator(InputSchema),
  execute: async () => {
    const now = new Date();
    const upcoming = CPI_RELEASES_UTC.map((s) => new Date(s)).filter((d) => d > now);
    if (upcoming.length === 0) {
      throw new Error('No upcoming CPI releases in the embedded calendar — update cpi-calendar.ts');
    }
    const next = upcoming[0]!;
    const days = Math.ceil((next.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
    return {
      next_release_utc: next.toISOString(),
      days_until_release: days,
      upcoming_count: upcoming.length,
      source_url: 'https://www.bls.gov/schedule/news_release/cpi.htm',
    };
  },
  citation: () => ({
    label: 'BLS CPI schedule',
    url: 'https://www.bls.gov/schedule/news_release/cpi.htm',
  }),
};
