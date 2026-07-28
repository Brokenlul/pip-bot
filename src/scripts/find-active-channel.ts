/*
 * Read-only investigation: for a given guild, list text channels the bot can
 * see and rank them by how many of the bot's own messages appear in recent
 * history — a proxy for "where Pip actually gets used" in that server.
 *
 *   npx tsx src/scripts/find-active-channel.ts <guildId> [<guildId> ...]
 */
import { Client, GatewayIntentBits, ChannelType } from 'discord.js';
import { getConfig } from '../config.js';

async function main(): Promise<void> {
  const guildIds = process.argv.slice(2);
  if (guildIds.length === 0) {
    console.error('usage: find-active-channel.ts <guildId> [<guildId> ...]');
    process.exit(1);
  }
  const cfg = getConfig();
  if (!cfg.DISCORD_TOKEN) throw new Error('DISCORD_TOKEN is not set.');

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  await client.login(cfg.DISCORD_TOKEN);
  await new Promise<void>((r) => client.once('clientReady', () => r()));

  try {
    for (const guildId of guildIds) {
      const guild = await client.guilds.fetch(guildId);
      console.log(`\n=== ${guild.name} (${guild.id}) ===`);
      const channels = await guild.channels.fetch();
      const textChannels = [...channels.values()].filter(
        (c) => c && c.type === ChannelType.GuildText,
      );

      const ranked: { name: string; id: string; botMsgs: number; lastBotMsgAt: Date | null }[] = [];
      for (const ch of textChannels) {
        if (!ch || ch.type !== ChannelType.GuildText) continue;
        try {
          const perms = ch.permissionsFor(client.user!);
          if (!perms?.has('ViewChannel') || !perms.has('ReadMessageHistory')) continue;
          const messages = await ch.messages.fetch({ limit: 50 });
          const botMsgs = messages.filter((m) => m.author.id === client.user!.id);
          ranked.push({
            name: ch.name,
            id: ch.id,
            botMsgs: botMsgs.size,
            lastBotMsgAt: botMsgs.size > 0 ? botMsgs.first()!.createdAt : null,
          });
        } catch (e) {
          console.log(`  (skipped #${ch.name}: ${(e as Error).message})`);
        }
      }

      ranked.sort((a, b) => b.botMsgs - a.botMsgs);
      for (const r of ranked) {
        console.log(
          `  #${r.name.padEnd(20)} ${r.id}  bot msgs in last 50: ${r.botMsgs}  last: ${r.lastBotMsgAt?.toISOString() ?? 'n/a'}`,
        );
      }
    }
  } finally {
    await client.destroy();
  }
}

main().catch((e) => {
  console.error(`failed: ${(e as Error).message}`);
  process.exit(1);
});
