import { z } from 'zod';
import { Tool, zValidator } from './registry.js';

/**
 * FOMC context — the calendar, the primary-source URLs for every recent
 * meeting, and the durable profile of the sitting chair.
 *
 * Design note: this file hardcodes only what does NOT rot on a six-week cycle —
 * meeting dates (published years ahead), the Fed's stable document URL patterns,
 * and who chairs. Everything that moves (the target range, the dots, the tone)
 * is reachable through the URLs handed back: Pip pulls the verbatim statement,
 * minutes or press-conference transcript with official_statement_text instead of
 * reciting a figure this file would have to be edited to keep true. The one
 * exception, RECENT_POLICY_STATE, is explicitly date-stamped and carries its own
 * "verify before quoting" caveat.
 *
 * Source: federalreserve.gov/monetarypolicy/fomccalendars.htm
 */

interface Meeting {
  start: string;
  end: string;
  /** Every meeting has had a post-decision press conference since 2019. */
  presser: boolean;
  /** Summary of Economic Projections + dot plot — March, June, September, December only. */
  projections: boolean;
}

// Statement URLs for every date below were verified to resolve (HTTP 200) on 2026-07-28.
const FOMC_MEETINGS: ReadonlyArray<Meeting> = [
  { start: '2025-01-28', end: '2025-01-29', presser: true, projections: false },
  { start: '2025-03-18', end: '2025-03-19', presser: true, projections: true },
  { start: '2025-05-06', end: '2025-05-07', presser: true, projections: false },
  { start: '2025-06-17', end: '2025-06-18', presser: true, projections: true },
  { start: '2025-07-29', end: '2025-07-30', presser: true, projections: false },
  { start: '2025-09-16', end: '2025-09-17', presser: true, projections: true },
  { start: '2025-10-28', end: '2025-10-29', presser: true, projections: false },
  { start: '2025-12-09', end: '2025-12-10', presser: true, projections: true },
  { start: '2026-01-27', end: '2026-01-28', presser: true, projections: false },
  { start: '2026-03-17', end: '2026-03-18', presser: true, projections: true },
  { start: '2026-04-28', end: '2026-04-29', presser: true, projections: false },
  { start: '2026-06-16', end: '2026-06-17', presser: true, projections: true },
  { start: '2026-07-28', end: '2026-07-29', presser: true, projections: false },
  { start: '2026-09-15', end: '2026-09-16', presser: true, projections: true },
  { start: '2026-10-27', end: '2026-10-28', presser: true, projections: false },
  { start: '2026-12-15', end: '2026-12-16', presser: true, projections: true },
] as const;

/**
 * Sitting chair. Durable identity + reaction function — the things that stay
 * true between meetings. Anything time-sensitive he says goes through
 * web_search / news_wire, not this block.
 */
const CHAIR = {
  name: 'Kevin Warsh',
  in_office_since: '2026-05-22',
  predecessor: 'Jerome Powell (chair Feb 2018 - May 2026, no longer in office)',
  background:
    'Fed governor 2006-2011, the crisis-era Board, where he was the Fed\'s main liaison to Wall Street. Ex-Morgan Stanley M&A, later a Hoover Institution fellow and a long-running public critic of QE and of the size of the Fed\'s balance sheet.',
  reaction_function:
    'Inflation hawk by philosophy, data-driven in practice. As a governor he consistently weighted upside inflation risk above labour-market downside, and never once dissented. Publicly argues that prolonged low rates distort asset prices, invite leverage, and erode the Fed\'s credibility, and favours a smaller balance sheet. Read him as biased toward holding or tightening when inflation and easing financial conditions conflict.',
  communication_style:
    'Deliberately gives LESS forward guidance than his predecessor. At his first meeting as chair (17 Jun 2026) he rewrote the FOMC statement down to roughly 130 words from the 300+ of recent years, calling it "a bit shorter, a bit simpler" and saying it "dispenses with some older language", and he did not submit his own dot to the projections. Practical consequence for reading him: the signal has moved OUT of statement boilerplate and INTO word choice, what got deleted since last time, and the press-conference Q&A.',
} as const;

/**
 * Dated snapshot of where policy stood when this file was last touched.
 * A starting point for a preview, never a substitute for the live documents.
 */
const RECENT_POLICY_STATE = {
  as_of: '2026-07-28',
  target_range: '3.50% - 3.75%',
  stance_summary:
    'Range unchanged across the Jan 28, Mar 18, Apr 29 and Jun 17 2026 meetings. The June decision was a unanimous 12-0 hold.',
  projections_signal:
    'June SEP median for end-2026 moved to 3.8%, up from 3.4% in March, which implies at least one HIKE rather than a cut. The June minutes (released 8 Jul 2026) showed the committee split, with roughly half of the 18 projections favouring hold-or-cut and the other half a hike before year-end.',
  inflation_backdrop:
    'Inflation elevated relative to the 2% goal with an energy-led resurgence. The June statement attributed price increases to supply shocks including energy, and named the conflict in the Middle East as a source of elevated uncertainty.',
  chair_latest_public_line:
    'Warsh at the ECB Forum on Central Banking (Sintra), 1 Jul 2026: "prices are too high."',
  caveat:
    'Snapshot captured 2026-07-28, it does NOT auto-update. Confirm the live target range and the current wording from the statement URL below before quoting any of it as current.',
} as const;

const InputSchema = z.object({});
type Input = z.infer<typeof InputSchema>;

interface MeetingDocs {
  statement: string;
  implementation_note: string;
  minutes: string;
  minutes_released_around: string;
  projections: string | null;
  press_conference_transcript: string;
}

interface PastMeeting {
  meeting_dates: string;
  decision_utc: string;
  released_projections: boolean;
  docs: MeetingDocs;
}

interface Output {
  now_utc: string;
  next_meeting: {
    meeting_dates: string;
    starts_utc: string;
    decision_utc: string;
    press_conference_utc: string | null;
    days_until_decision: number;
    hours_until_decision: number;
    is_decision_day: boolean;
    is_in_progress: boolean;
    has_press_conference: boolean;
    releases_projections: boolean;
  };
  last_meeting: PastMeeting | null;
  meeting_before_last: PastMeeting | null;
  chair: typeof CHAIR;
  recent_policy_state: typeof RECENT_POLICY_STATE;
  source_url: string;
  upcoming_count: number;
}

const ymd = (date: string) => date.replace(/-/g, '');

/**
 * The decision lands at 14:00 America/New_York, which is 18:00 UTC under EDT but
 * 19:00 UTC under EST — so the winter meetings (Jan, Dec) are an hour later in
 * UTC than the summer ones. Resolve the real offset rather than assuming 18:00,
 * which would have put the January and December countdowns an hour out.
 */
function etOffsetHours(date: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'shortOffset',
  }).formatToParts(new Date(`${date}T18:00:00Z`));
  const match = parts.find((p) => p.type === 'timeZoneName')?.value.match(/GMT([+-]\d{1,2})/);
  return match ? Number(match[1]) : -4;
}

function decisionUtcFor(meeting: { end: string }): Date {
  const hourUtc = 14 - etOffsetHours(meeting.end);
  return new Date(`${meeting.end}T${String(hourUtc).padStart(2, '0')}:00:00Z`);
}

/** Press conference starts 30 minutes after the statement drops. */
function presserUtcFor(meeting: Meeting): Date {
  return new Date(decisionUtcFor(meeting).getTime() + 30 * 60_000);
}

/** Minutes are published three weeks after the decision. */
function minutesDateFor(meeting: Meeting): string {
  const d = new Date(`${meeting.end}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 21);
  return d.toISOString().slice(0, 10);
}

function docsFor(meeting: Meeting): MeetingDocs {
  const d = ymd(meeting.end);
  return {
    statement: `https://www.federalreserve.gov/newsevents/pressreleases/monetary${d}a.htm`,
    implementation_note: `https://www.federalreserve.gov/newsevents/pressreleases/monetary${d}a1.htm`,
    minutes: `https://www.federalreserve.gov/monetarypolicy/fomcminutes${d}.htm`,
    minutes_released_around: minutesDateFor(meeting),
    projections: meeting.projections
      ? `https://www.federalreserve.gov/monetarypolicy/files/fomcprojtabl${d}.pdf`
      : null,
    press_conference_transcript: `https://www.federalreserve.gov/mediacenter/files/FOMCpresconf${d}.pdf`,
  };
}

function toPastMeeting(meeting: Meeting): PastMeeting {
  return {
    meeting_dates: `${meeting.start} to ${meeting.end}`,
    decision_utc: decisionUtcFor(meeting).toISOString(),
    released_projections: meeting.projections,
    docs: docsFor(meeting),
  };
}

export const fedCalendarTool: Tool<Input, Output> = {
  name: 'next_fomc_meeting',
  description:
    'FOMC / Fed meeting context. Returns the countdown to the next rate decision and press conference, the primary-source document URLs (statement, implementation note, minutes, dot-plot projections, press-conference transcript) for the last two meetings, the sitting Fed chair\'s background, reaction function and communication style, and a date-stamped snapshot of the current policy stance. Use for "next Fed meeting", "FOMC", "rate decision", and for any question about what the Fed or its chair will do or say. This is the FIRST step of an FOMC preview or post-mortem, not the whole answer: pull the actual wording with official_statement_text from the URLs it returns. It carries no live macro figures, use macro_indicator for those.',
  inputSchema: { type: 'object', properties: {}, required: [] },
  validate: zValidator(InputSchema),
  execute: async () => {
    const now = new Date();
    const upcoming = FOMC_MEETINGS.filter((m) => decisionUtcFor(m) > now);
    if (upcoming.length === 0) {
      throw new Error('No upcoming FOMC meetings in the embedded calendar — update fed-calendar.ts');
    }
    const next = upcoming[0]!;
    const past = FOMC_MEETINGS.filter((m) => decisionUtcFor(m) <= now);
    const decisionAt = decisionUtcFor(next);
    const msOut = decisionAt.getTime() - now.getTime();
    const today = now.toISOString().slice(0, 10);

    return {
      now_utc: now.toISOString(),
      next_meeting: {
        meeting_dates: `${next.start} to ${next.end}`,
        starts_utc: new Date(`${next.start}T00:00:00Z`).toISOString(),
        decision_utc: decisionAt.toISOString(),
        press_conference_utc: next.presser ? presserUtcFor(next).toISOString() : null,
        days_until_decision: Math.ceil(msOut / (24 * 60 * 60 * 1000)),
        hours_until_decision: Math.round((msOut / (60 * 60 * 1000)) * 10) / 10,
        is_decision_day: today === next.end,
        is_in_progress: today >= next.start && today <= next.end,
        has_press_conference: next.presser,
        releases_projections: next.projections,
      },
      last_meeting: past.length > 0 ? toPastMeeting(past[past.length - 1]!) : null,
      meeting_before_last: past.length > 1 ? toPastMeeting(past[past.length - 2]!) : null,
      chair: CHAIR,
      recent_policy_state: RECENT_POLICY_STATE,
      source_url: 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm',
      upcoming_count: upcoming.length,
    };
  },
  citation: () => ({
    label: 'FOMC calendar',
    url: 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm',
  }),
};
