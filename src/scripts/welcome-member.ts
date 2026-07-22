/*
 * One-off welcome DM to a member of the Pip community server.
 *
 * GuildMemberAdd only fires for joins that happen while the bot is running, so
 * anyone who joined before the listener shipped is invisible to it. This is the
 * manual backfill for those people.
 *
 * DRY RUN BY DEFAULT. It resolves the member and prints exactly what would be
 * sent; nothing leaves the process until you pass --send. A DM cannot be
 * unsent, so the safe path is the default one.
 *
 *   npx tsx src/scripts/welcome-member.ts tomess1482
 *   npx tsx src/scripts/welcome-member.ts tomess1482 --send
 *
 * Accepts a username or a raw numeric id. Requires DISCORD_TOKEN and
 * PIP_COMMUNITY_GUILD_ID.
 */
import { Client, GatewayIntentBits } from 'discord.js';
import { getConfig } from '../config.js';
import { COMMUNITY_WELCOME } from '../adapters/discord.js';
import { recordCommunityJoin } from '../memory/attribution.js';

const args = process.argv.slice(2);
const send = args.includes('--send');
const query = args.find((a) => !a.startsWith('--'));

async function main(): Promise<void> {
  if (!query) {
    console.error('usage: welcome-member.ts <username|userId> [--send]');
    process.exit(1);
  }

  const cfg = getConfig();
  const guildId = cfg.PIP_COMMUNITY_GUILD_ID;
  if (!guildId) throw new Error('PIP_COMMUNITY_GUILD_ID is not set — cannot resolve the member.');
  if (!cfg.DISCORD_TOKEN) throw new Error('DISCORD_TOKEN is not set.');

  // Guilds only: members.search hits the REST API, so this needs no privileged
  // intent and works before Server Members is toggled in the dev portal.
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  await client.login(cfg.DISCORD_TOKEN);
  await new Promise<void>((r) => client.once('clientReady', () => r()));

  try {
    const guild = await client.guilds.fetch(guildId);
    const member = /^\d{5,}$/.test(query)
      ? await guild.members.fetch(query)
      : (await guild.members.search({ query, limit: 5 })).find(
          (m) => m.user.username.toLowerCase() === query.toLowerCase(),
        );

    if (!member) throw new Error(`no member matching "${query}" in ${guild.name}`);

    console.log(`\nguild:  ${guild.name} (${guild.id})`);
    console.log(`member: ${member.user.username} (${member.id})`);
    console.log(`joined: ${member.joinedAt?.toISOString() ?? 'unknown'}`);
    console.log(`\n--- message ---\n${COMMUNITY_WELCOME}\n---------------\n`);

    if (!send) {
      console.log('DRY RUN — nothing sent. Re-run with --send to deliver it.');
      return;
    }

    await member.send(COMMUNITY_WELCOME);
    console.log(`✅ sent to ${member.user.username}`);

    // Record the lead so this person shows up in the funnel like an automatic
    // join would. Idempotent on the synthetic join token.
    await recordCommunityJoin(guild.id, member.id, member.user.username);
    console.log('✅ recorded as a lead');
  } finally {
    await client.destroy();
  }
}

main().catch((e) => {
  console.error(`failed: ${(e as Error).message}`);
  process.exit(1);
});
