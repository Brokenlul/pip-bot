import { getDb } from '../memory/db.js';
import { fundingRateTool } from '../data/hyperliquid.js';
import { pushMessage } from './push.js';
import { resolveEarningsSchedule } from '../data/earnings-alerts.js';
import type { ToolContext } from '../data/registry.js';

/**
 * Background push for price_alerts (db/migrations/0008_price_alerts.sql) — the
 * honest answer to "can you message me when X happens", which Pip otherwise
 * can't do (inbound-only by design everywhere else). Only fires while THIS
 * process is running — there's no always-on host yet, so an alert set right
 * before the bot goes to sleep won't fire until it's back up and re-polls.
 */
const POLL_INTERVAL_MS = 45_000;
const SYSTEM_CTX: ToolContext = { platform: 'system', guildId: 'alert-poller', userId: 'system' };

interface AlertRow {
  id: number;
  platform: string;
  user_id: string;
  symbol: string;
  direction: 'above' | 'below';
  target_price: number;
  note: string | null;
  last_price: number | null;
}

interface EarningsAlertRow {
  id: number;
  platform: string;
  user_id: string;
  symbol: string;
  note: string | null;
  notify_at: string;
  earnings_date: string;
  earnings_when: string | null;
  lead_minutes: number | null;
}

async function fetchActiveAlerts(): Promise<AlertRow[]> {
  const db = getDb();
  if (!db) return [];
  const { data, error } = await db
    .from('price_alerts')
    .select('id, platform, user_id, symbol, direction, target_price, note, last_price')
    .eq('active', true)
    .eq('kind', 'price');
  if (error) {
    console.warn(`[alerts] fetch active: ${error.message}`);
    return [];
  }
  return (data ?? []) as AlertRow[];
}

/** Earnings alerts whose lead time has elapsed. */
async function fetchDueEarningsAlerts(): Promise<EarningsAlertRow[]> {
  const db = getDb();
  if (!db) return [];
  const { data, error } = await db
    .from('price_alerts')
    .select('id, platform, user_id, symbol, note, notify_at, earnings_date, earnings_when, lead_minutes')
    .eq('active', true)
    .eq('kind', 'earnings')
    .lte('notify_at', new Date().toISOString());
  if (error) {
    console.warn(`[alerts] fetch due earnings: ${error.message}`);
    return [];
  }
  return (data ?? []) as EarningsAlertRow[];
}

async function markTriggered(id: number): Promise<void> {
  const db = getDb();
  if (!db) return;
  const { error } = await db
    .from('price_alerts')
    .update({ active: false, triggered_at: new Date().toISOString() })
    .eq('id', id);
  if (error) console.warn(`[alerts] markTriggered(${id}): ${error.message}`);
}

async function updateLastPrice(id: number, price: number): Promise<void> {
  const db = getDb();
  if (!db) return;
  const { error } = await db.from('price_alerts').update({ last_price: price }).eq('id', id);
  if (error) console.warn(`[alerts] updateLastPrice(${id}): ${error.message}`);
}

/** Edge-triggered: fires only on the poll where price actually crosses the level, not every poll after. */
function crossed(alert: AlertRow, price: number): boolean {
  if (alert.last_price === null) return false; // first observation just seeds a baseline
  if (alert.direction === 'above') return alert.last_price < alert.target_price && price >= alert.target_price;
  return alert.last_price > alert.target_price && price <= alert.target_price;
}

function pushText(alert: AlertRow, price: number): string {
  const verb = alert.direction === 'above' ? 'crossed above' : 'dropped to/below';
  const note = alert.note ? ` — ${alert.note}` : '';
  return `🔔 ${alert.symbol} just ${verb} $${alert.target_price.toLocaleString()} (now $${price.toLocaleString()})${note}\n\nNot financial advice.`;
}

function earningsPushText(row: EarningsAlertRow): string {
  const mins = row.lead_minutes ?? 60;
  const lead =
    mins >= 1440
      ? `${Math.round(mins / 1440)}d`
      : mins >= 60
        ? `${Math.round(mins / 60)}h`
        : `${mins}m`;
  const when = row.earnings_when ? ` (${row.earnings_when})` : '';
  const note = row.note ? `\n\nYou wanted to watch: ${row.note}` : '';
  return (
    `🔔 ${row.symbol} reports earnings in about ${lead} — ${row.earnings_date}${when}.` +
    `${note}\n\nAsk me for the setup and I'll pull the consensus and the recent beat/miss record.\n\nNot financial advice.`
  );
}

/**
 * Fire earnings alerts whose lead time has elapsed.
 *
 * Companies reschedule prints, so we re-verify the date before pushing: if it
 * moved out, we reschedule the row rather than firing a wrong alert. That check
 * needs the equity provider, so on any lookup failure we fall back to pushing
 * the alert we already have — a slightly stale heads-up beats silence for
 * someone who explicitly asked to be told.
 */
async function pollEarningsOnce(): Promise<void> {
  const due = await fetchDueEarningsAlerts();
  if (due.length === 0) return;
  const db = getDb();
  if (!db) return;

  for (const row of due) {
    try {
      const sched = await resolveEarningsSchedule(row.symbol, row.lead_minutes ?? 60, SYSTEM_CTX);
      if (sched.earnings_date !== row.earnings_date && sched.notify_at.getTime() > Date.now()) {
        const { error } = await db
          .from('price_alerts')
          .update({
            notify_at: sched.notify_at.toISOString(),
            earnings_date: sched.earnings_date,
            earnings_when: sched.earnings_when,
          })
          .eq('id', row.id);
        if (error) console.warn(`[alerts] earnings reschedule(${row.id}): ${error.message}`);
        else console.log(`[alerts] ${row.symbol} moved ${row.earnings_date} -> ${sched.earnings_date}, rescheduled`);
        continue;
      }
    } catch (e) {
      console.warn(`[alerts] earnings re-verify failed for ${row.symbol}: ${(e as Error).message}`);
    }
    const sent = await pushMessage(row.platform, row.user_id, earningsPushText(row));
    if (sent) await markTriggered(row.id);
  }
}

async function pollOnce(): Promise<void> {
  await pollEarningsOnce();

  const alerts = await fetchActiveAlerts();
  if (alerts.length === 0) return;

  const bySymbol = new Map<string, AlertRow[]>();
  for (const a of alerts) {
    const list = bySymbol.get(a.symbol) ?? [];
    list.push(a);
    bySymbol.set(a.symbol, list);
  }

  await Promise.all(
    [...bySymbol.entries()].map(async ([symbol, rows]) => {
      let price: number;
      try {
        price = (await fundingRateTool.execute({ coin: symbol }, SYSTEM_CTX)).mark_price;
      } catch (e) {
        console.warn(`[alerts] price fetch failed for ${symbol}: ${(e as Error).message}`);
        return;
      }
      for (const alert of rows) {
        if (crossed(alert, price)) {
          const sent = await pushMessage(alert.platform, alert.user_id, pushText(alert, price));
          // On a failed send (adapter down, user blocked the bot) leave both
          // active and last_price alone: last_price stays on the un-crossed side
          // of the level, so the next poll still reads as a cross and retries.
          // Refreshing it here would move it past the target and the alert could
          // never fire again.
          if (sent) await markTriggered(alert.id);
        } else {
          await updateLastPrice(alert.id, price);
        }
      }
    }),
  );
}

let polling = false;

/** Start the interval poller. No-op safe to call even if memory (Supabase) is off — pollOnce just finds nothing. */
export function startAlertPoller(): void {
  setInterval(() => {
    if (polling) return; // guard against overlap if a poll ever runs long
    polling = true;
    pollOnce()
      .catch((e) => console.warn(`[alerts] poll failed: ${(e as Error).message}`))
      .finally(() => {
        polling = false;
      });
  }, POLL_INTERVAL_MS);
  console.log(`[alerts] price alert poller started (every ${POLL_INTERVAL_MS / 1000}s)`);
}
