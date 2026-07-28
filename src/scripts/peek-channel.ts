/*
 * Read-only: print recent messages from a channel (author + content), so an
 * outreach/copy decision can be grounded in what a server's community
 * actually talks about instead of guessing.
 *
 *   npx tsx src/scripts/peek-channel.ts <channelId> [limit]
 */
import { Client, GatewayIntentBits } from 'discord.js';
import { getConfig } from '../config.js';

async function main(): Promise<void> {
  const channelId = process.argv[2];
  const limit = Number(process.argv[3] ?? 30);
  if (!channelId) {
    console.error('usage: peek-channel.ts <channelId> [limit]');
    process.exit(1);
  }
  const cfg = getConfig();
  if (!cfg.DISCORD_TOKEN) throw new Error('DISCORD_TOKEN is not set.');
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  await client.login(cfg.DISCORD_TOKEN);
  await new Promise<void>((r) => client.once('clientReady', () => r()));
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) throw new Error('not a text channel');
    const messages = await channel.messages.fetch({ limit });
    const sorted = [...messages.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    for (const m of sorted) {
      const who = m.author.id === client.user!.id ? 'Pip' : m.author.username;
      const text = m.content || (m.embeds.length ? '[embed]' : m.attachments.size ? '[attachment]' : '[no content — intent-gated?]');
      console.log(`[${m.createdAt.toISOString()}] ${who}: ${text.slice(0, 300)}`);
    }
  } finally {
    await client.destroy();
  }
}

main().catch((e) => {
  console.error(`failed: ${(e as Error).message}`);
  process.exit(1);
});
