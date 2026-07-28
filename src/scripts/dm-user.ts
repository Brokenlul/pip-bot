/*
 * One-off single-recipient FOMC DM (same copy as fomc-outreach.ts), for
 * reaching one more person after the main batch already went out.
 *
 * DRY RUN BY DEFAULT.
 *
 *   npx tsx src/scripts/dm-user.ts discord 492999192793448449
 *   npx tsx src/scripts/dm-user.ts discord 492999192793448449 --send
 */
import { Client, GatewayIntentBits } from 'discord.js';
import { Bot } from 'grammy';
import { getConfig } from '../config.js';

const MESSAGE = [
  'Hey, thanks for using Pip.',
  '',
  "FOMC drops tomorrow afternoon (Wed Jul 29, 2pm ET). I'll have the statement read live as it lands: what changed in the language, Warsh's tone in the presser, and how the market's actually reacting, funding, OI, spot, all pulled live and cited.",
  '',
  "We've been building toward exactly this moment. Come put me to the test.",
  '',
  'https://x.com/Pipinvestbot/status/2082092593530478817?s=20',
].join('\n');

async function main(): Promise<void> {
  const [platform, id] = process.argv.slice(2);
  const send = process.argv.includes('--send');
  if ((platform !== 'discord' && platform !== 'telegram') || !id) {
    console.error('usage: dm-user.ts <discord|telegram> <userId> [--send]');
    process.exit(1);
  }

  console.log(`--- message ---\n${MESSAGE}\n---------------\n`);
  console.log(`target: ${platform} ${id}\n`);
  if (!send) {
    console.log('DRY RUN — nothing sent. Re-run with --send to deliver it.');
    return;
  }

  const cfg = getConfig();
  if (platform === 'discord') {
    if (!cfg.DISCORD_TOKEN) throw new Error('DISCORD_TOKEN is not set.');
    const client = new Client({ intents: [GatewayIntentBits.Guilds] });
    await client.login(cfg.DISCORD_TOKEN);
    await new Promise<void>((r) => client.once('clientReady', () => r()));
    try {
      const user = await client.users.fetch(id);
      await user.send(MESSAGE);
      console.log(`✅ sent to ${user.username}`);
    } finally {
      await client.destroy();
    }
  } else {
    if (!cfg.TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is not set.');
    const bot = new Bot(cfg.TELEGRAM_BOT_TOKEN);
    await bot.init();
    await bot.api.sendMessage(Number(id), MESSAGE);
    console.log(`✅ sent`);
  }
}

main().catch((e) => {
  console.error(`failed: ${(e as Error).message}`);
  process.exit(1);
});
