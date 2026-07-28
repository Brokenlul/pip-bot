/*
 * Read-only: list every channel (any type) in a guild, with id.
 *
 *   npx tsx src/scripts/list-channels.ts <guildId>
 */
import { Client, GatewayIntentBits, ChannelType } from 'discord.js';
import { getConfig } from '../config.js';

async function main(): Promise<void> {
  const guildId = process.argv[2];
  if (!guildId) {
    console.error('usage: list-channels.ts <guildId>');
    process.exit(1);
  }
  const cfg = getConfig();
  if (!cfg.DISCORD_TOKEN) throw new Error('DISCORD_TOKEN is not set.');
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  await client.login(cfg.DISCORD_TOKEN);
  await new Promise<void>((r) => client.once('clientReady', () => r()));
  try {
    const guild = await client.guilds.fetch(guildId);
    const channels = await guild.channels.fetch();
    console.log(`${guild.name} (${guild.id}) — ${channels.size} channels\n`);
    const sorted = [...channels.values()].sort((a, b) => (a?.rawPosition ?? 0) - (b?.rawPosition ?? 0));
    for (const ch of sorted) {
      if (!ch) continue;
      console.log(`  [${ChannelType[ch.type]}] #${ch.name}  ${ch.id}`);
    }
  } finally {
    await client.destroy();
  }
}

main().catch((e) => {
  console.error(`failed: ${(e as Error).message}`);
  process.exit(1);
});
