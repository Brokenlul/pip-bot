/**
 * Converts a Finnhub earnings reporting DAY + before-open/after-close label into
 * a real UTC instant. Shared by equity_earnings (so the model gets an exact
 * timestamp to compare against instead of reasoning about "after close" itself)
 * and set_earnings_alert (so the push fires at the right time).
 */

/** Minutes that the given instant is offset from UTC in `tz` (EDT = -240). */
function tzOffsetMinutes(at: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return (asUtc - at.getTime()) / 60_000;
}

/**
 * Build the UTC instant for a wall-clock time in New York. Doing this by hand
 * (assuming UTC-4) silently breaks every alert set across a DST boundary, and a
 * push that fires an hour off is the same credibility problem as a wrong price.
 */
export function newYorkToUtc(day: string, hour: number, minute: number): Date {
  const [y, m, d] = day.split('-').map(Number);
  const guess = Date.UTC(y!, m! - 1, d!, hour, minute);
  const offset = tzOffsetMinutes(new Date(guess), 'America/New_York');
  return new Date(guess - offset * 60_000);
}

/**
 * When results actually land, in New York wall-clock:
 *  - after close  → ~16:05, just after the 16:00 bell
 *  - before open  → ~07:00, typical pre-market release, well before the 09:30 open
 *  - unknown      → assume after close, much the more common slot for large caps
 */
export function reportInstant(day: string, when: string | null): Date {
  const beforeOpen = (when ?? '').toLowerCase().includes('before');
  return beforeOpen ? newYorkToUtc(day, 7, 0) : newYorkToUtc(day, 16, 5);
}
