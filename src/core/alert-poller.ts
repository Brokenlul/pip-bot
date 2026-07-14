import { getDb } from '../memory/db.js';
import { fundingRateTool } from '../data/hyperliquid.js';
import { pushMessage } from './push.js';
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

async function fetchActiveAlerts(): Promise<AlertRow[]> {
  const db = getDb();
  if (!db) return [];
  const { data, error } = await db
    .from('price_alerts')
    .select('id, platform, user_id, symbol, direction, target_price, note, last_price')
    .eq('active', true);
  if (error) {
    console.warn(`[alerts] fetch active: ${error.message}`);
    return [];
  }
  return (data ?? []) as AlertRow[];
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

async function pollOnce(): Promise<void> {
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
          // On a failed send (adapter down, user blocked the bot) keep the
          // alert active and just refresh last_price — retry on the next poll
          // rather than silently losing the alert.
          if (sent) await markTriggered(alert.id);
          else await updateLastPrice(alert.id, price);
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
