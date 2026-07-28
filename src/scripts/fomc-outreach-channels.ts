/*
 * One-off FOMC outreach posted into specific channels of servers where a DM
 * target turned out to actually be a guild id, not a user id (see
 * fomc-outreach.ts run 2026-07-28: Cyzer/Veritas/Oligarch/Haveli all failed
 * with "Unknown User" because the ids given were their servers).
 *
 * A channel post is visible to the whole server, not a private DM, so the
 * copy here is broadcast-toned rather than the 1:1 phrasing used in
 * fomc-outreach.ts.
 *
 * DRY RUN BY DEFAULT.
 *
 *   npx tsx src/scripts/fomc-outreach-channels.ts
 *   npx tsx src/scripts/fomc-outreach-channels.ts --send
 */
import { Client, GatewayIntentBits } from 'discord.js';
import { getConfig } from '../config.js';

const MESSAGE = [
  'Hey, thanks for having me around here.',
  '',
  "FOMC drops tomorrow afternoon (Wed Jul 29, 2pm ET). I'll have the statement read live as it lands: what changed in the language, Warsh's tone in the presser, and how the market's actually reacting, funding, OI, spot, all pulled live and cited.",
  '',
  "I've been built for exactly this moment. Come put me to the test.",
  '',
  'https://x.com/Pipinvestbot/status/2082092593530478817?s=20',
].join('\n');

interface Target {
  serverName: string;
  channelName: string;
  channelId: string;
}

const TARGETS: Target[] = [
  { serverName: "cyzer's server", channelName: '#general', channelId: '918656384734756917' },
  { serverName: 'veritas', channelName: '#given-channel', channelId: '1204201743022293103' },
  { serverName: 'HAVELI', channelName: '#given-channel', channelId: '1063550139094028379' },
  { serverName: 'Oligarch', channelName: '#bot-command', channelId: '1142035211962560552' },
];

const send = process.argv.includes('--send');

async function main(): Promise<void> {
  console.log(`--- message (identical, posted to ${TARGETS.length} channels) ---\n${MESSAGE}\n----------------------\n`);
  for (const t of TARGETS) console.log(`  ${t.serverName.padEnd(16)} ${t.channelName.padEnd(16)} ${t.channelId}`);
  console.log('');

  if (!send) {
    console.log('DRY RUN — nothing posted. Re-run with --send to deliver it.');
    return;
  }

  const cfg = getConfig();
  if (!cfg.DISCORD_TOKEN) throw new Error('DISCORD_TOKEN is not set.');
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  await client.login(cfg.DISCORD_TOKEN);
  await new Promise<void>((r) => client.once('clientReady', () => r()));

  const results: { target: Target; ok: boolean; error?: string }[] = [];
  try {
    for (const t of TARGETS) {
      try {
        const channel = await client.channels.fetch(t.channelId);
        if (!channel || !channel.isTextBased() || !('send' in channel)) {
          throw new Error('not a postable text channel');
        }
        await (channel as { send: (opts: { content: string; allowedMentions: { parse: [] } }) => Promise<unknown> }).send({
          content: MESSAGE,
          allowedMentions: { parse: [] }, // silent — no @everyone/@here/@user pings, ever
        });
        console.log(`  ✅ ${t.serverName} ${t.channelName}`);
        results.push({ target: t, ok: true });
      } catch (e) {
        console.log(`  ❌ ${t.serverName} ${t.channelName}: ${(e as Error).message}`);
        results.push({ target: t, ok: false, error: (e as Error).message });
      }
    }
  } finally {
    await client.destroy();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} posted.`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(`failed: ${(e as Error).message}`);
  process.exit(1);
});
