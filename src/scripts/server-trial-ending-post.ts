/*
 * One-off server-trial-ending broadcast, posted into the server's own channel
 * (not a DM) — this is a SERVER trial (guilds.server_access_until / the
 * created_at+7d fallback), not a personal per-user trial.
 *
 *   cyzer's server (guild 918656384734756914) — trial = created_at (2026-07-23
 *   17:51:31 UTC) + 7d = ends 2026-07-30 17:51:31 UTC. Checked live against
 *   Supabase (guilds row: server_tier/server_access_until both null, so still
 *   on the trial-derived window), not guessed. #general channel id confirmed
 *   working in fomc-outreach-channels.ts (2026-07-28 run).
 *
 * The "ends in ~X" wording is computed from TRIAL_END at RUN time, so it stays
 * accurate no matter when --send actually fires.
 *
 * DRY RUN BY DEFAULT.
 *
 *   npx tsx src/scripts/server-trial-ending-post.ts
 *   npx tsx src/scripts/server-trial-ending-post.ts --send
 */
import { Client, GatewayIntentBits } from 'discord.js';
import { getConfig } from '../config.js';

const CHANNEL_ID = '918656384734756917'; // cyzer's server · #general
const TRIAL_END = '2026-07-30T17:51:31.121Z';

function timeLeft(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'has already ended';
  const totalMin = Math.round(ms / 60_000);
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  const parts: string[] = [];
  if (hours) parts.push(`${hours}h`);
  if (mins) parts.push(`${mins}m`);
  return `in ~${parts.join(' ')}`;
}

function buildMessage(): string {
  const until = new Date(TRIAL_END);
  const hhmm = `${String(until.getUTCHours()).padStart(2, '0')}:${String(until.getUTCMinutes()).padStart(2, '0')}`;
  return [
    `Hey all, heads up: this server's free trial of Pip ends ${timeLeft(TRIAL_END)} today (${hhmm} UTC).`,
    '',
    "If the crew's found it useful, keep access with a Server plan here: https://pipinvest.xyz/#pricing",
  ].join('\n');
}

async function main(): Promise<void> {
  const send = process.argv.includes('--send');
  const message = buildMessage();
  console.log(`--- cyzer's server · #general (${CHANNEL_ID}) ---\n${message}\n`);

  if (!send) {
    console.log('DRY RUN — nothing posted. Re-run with --send to deliver.');
    return;
  }

  const cfg = getConfig();
  if (!cfg.DISCORD_TOKEN) throw new Error('DISCORD_TOKEN is not set.');
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  await client.login(cfg.DISCORD_TOKEN);
  await new Promise<void>((r) => client.once('clientReady', () => r()));
  try {
    const channel = await client.channels.fetch(CHANNEL_ID);
    if (!channel || !channel.isTextBased() || !('send' in channel)) {
      throw new Error('not a postable text channel');
    }
    await (channel as { send: (opts: { content: string; allowedMentions: { parse: [] } }) => Promise<unknown> }).send({
      content: message,
      allowedMentions: { parse: [] }, // silent — no @everyone/@here/@user pings
    });
    console.log('✅ posted');
  } finally {
    await client.destroy();
  }
}

main().catch((e) => {
  console.error(`failed: ${(e as Error).message}`);
  process.exit(1);
});
