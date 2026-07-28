/*
 * Read-only: confirm the bot is in a guild, and whether a given user id is a
 * member of it.
 *
 *   npx tsx src/scripts/check-guild-member.ts <guildId> [<userId>]
 */
import { Client, GatewayIntentBits } from 'discord.js';
import { getConfig } from '../config.js';

async function main(): Promise<void> {
  const guildId = process.argv[2];
  const userId = process.argv[3];
  if (!guildId) {
    console.error('usage: check-guild-member.ts <guildId> [<userId>]');
    process.exit(1);
  }
  const cfg = getConfig();
  if (!cfg.DISCORD_TOKEN) throw new Error('DISCORD_TOKEN is not set.');
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  await client.login(cfg.DISCORD_TOKEN);
  await new Promise<void>((r) => client.once('clientReady', () => r()));
  try {
    const guild = await client.guilds.fetch(guildId);
    console.log(`bot is in: ${guild.name} (${guild.id})`);
    if (userId) {
      try {
        const member = await guild.members.fetch(userId);
        console.log(`  member found: ${member.user.username} (${member.id}), joined ${member.joinedAt?.toISOString()}`);
      } catch (e) {
        console.log(`  NOT a member of this guild: ${(e as Error).message}`);
      }
    }
  } catch (e) {
    console.log(`bot is NOT in guild ${guildId}: ${(e as Error).message}`);
  } finally {
    await client.destroy();
  }
}

main().catch((e) => {
  console.error(`failed: ${(e as Error).message}`);
  process.exit(1);
});
