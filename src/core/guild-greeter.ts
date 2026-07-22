/*
 * Deferred server introduction.
 *
 * Pip stays silent when it is added to a server. Announcing yourself the second
 * you are installed is noise, and members are never DMed on an install at all.
 * Instead Pip waits: if anybody @-mentions it during the grace period, it has
 * been discovered and no introduction is needed. Only when a server has been
 * silent for the whole window does Pip introduce itself once, in the most
 * conversational channel it can post to.
 *
 * This is a poller rather than a setTimeout because the grace period outlives
 * any given process: a Railway redeploy mid-window must not lose (or re-fire)
 * a pending greeting. `guilds.greeted_at` is the durable "handled" mark, and it
 * is stamped in BOTH outcomes — greeted, or retired because they found Pip
 * themselves — so a greeting can never arrive days late.
 */
import { getDb } from '../memory/db.js';

const POLL_INTERVAL_MS = 15 * 60_000; // 15 min — the window is measured in hours
const GRACE_MS = 24 * 60 * 60_000; // silent for a full day before speaking up

type Greeter = (guildId: string) => Promise<boolean>;

let greeter: Greeter | null = null;
let polling = false;

/** The Discord adapter registers its send-into-a-guild capability here. */
export function registerGuildGreeter(fn: Greeter): void {
  greeter = fn;
}

async function markGreeted(guildId: string): Promise<void> {
  const db = getDb();
  if (!db) return;
  await db
    .from('guilds')
    .update({ greeted_at: new Date().toISOString() })
    .eq('id', guildId)
    .throwOnError();
}

export async function pollOnce(): Promise<void> {
  const db = getDb();
  if (!db || !greeter) return;

  const cutoff = new Date(Date.now() - GRACE_MS).toISOString();
  const { data, error } = await db
    .from('guilds')
    .select('id, name, installed_at')
    .is('greeted_at', null)
    .is('removed_at', null)
    .not('installed_at', 'is', null)
    .lt('installed_at', cutoff)
    .limit(25);
  if (error) {
    console.warn(`[greeter] load pending: ${error.message}`);
    return;
  }
  if (!data?.length) return;

  for (const guild of data) {
    const guildId = String(guild.id);
    try {
      // Did anyone actually talk to Pip here? A single logged message means the
      // server found it on its own, so the introduction is retired unsent.
      const { count, error: usageErr } = await db
        .from('usage_log')
        .select('id', { count: 'exact', head: true })
        .eq('guild_id', guildId)
        .limit(1);
      if (usageErr) {
        console.warn(`[greeter] usage check ${guildId}: ${usageErr.message}`);
        continue; // leave it pending; next sweep retries
      }
      if ((count ?? 0) > 0) {
        await markGreeted(guildId);
        console.log(`[greeter] ${guildId} already active, introduction retired`);
        continue;
      }

      // Silent for the whole window: introduce Pip once. Mark it handled even
      // when the send fails (no permission, no channel, kicked) — retrying a
      // post we already know we cannot make just spams the logs forever.
      const sent = await greeter(guildId);
      await markGreeted(guildId);
      if (!sent) console.log(`[greeter] ${guildId} not greetable, marked handled`);
    } catch (e) {
      console.warn(`[greeter] ${guildId} failed: ${(e as Error).message}`);
    }
  }
}

/** Start the sweep. Safe to call with memory off — pollOnce just finds nothing. */
export function startGuildGreeter(): void {
  setInterval(() => {
    if (polling) return;
    polling = true;
    pollOnce()
      .catch((e) => console.warn(`[greeter] poll failed: ${(e as Error).message}`))
      .finally(() => {
        polling = false;
      });
  }, POLL_INTERVAL_MS);
  console.log(
    `[greeter] guild greeter started (every ${POLL_INTERVAL_MS / 60_000}m, ${GRACE_MS / 3_600_000}h grace)`,
  );
}
