/*
 * One-off trial-ending-soon DM to testers whose beta_testers.access_until is
 * imminent (checked live against Supabase, not guessed):
 *   tomess1482   (discord  825498961368186900) — access_until 2026-07-30 20:20:01 UTC
 *   tomass_xyz   (telegram 7078725597)         — access_until 2026-07-31 15:57:06 UTC
 *   _cyzer       (discord  390653249495236608) — access_until 2026-07-31 17:55:27 UTC
 *
 * The "ends in ~X" wording is computed from accessUntil at RUN time, not baked
 * in, so it stays accurate no matter when --send actually fires.
 *
 * DRY RUN BY DEFAULT.
 *
 *   npx tsx src/scripts/trial-ending-dm.ts
 *   npx tsx src/scripts/trial-ending-dm.ts --send
 */
import { Client, GatewayIntentBits } from 'discord.js';
import { Bot } from 'grammy';
import { getConfig } from '../config.js';

interface Recipient {
  platform: 'discord' | 'telegram';
  id: string;
  name: string;
  accessUntil: string; // ISO, from beta_testers.access_until
}

const RECIPIENTS: Recipient[] = [
  { platform: 'discord', id: '825498961368186900', name: 'tomess1482', accessUntil: '2026-07-30T20:20:01.571Z' },
  { platform: 'telegram', id: '7078725597', name: 'tomass_xyz', accessUntil: '2026-07-31T15:57:06.831Z' },
  { platform: 'discord', id: '390653249495236608', name: '_cyzer', accessUntil: '2026-07-31T17:55:27.641Z' },
];

function timeLeft(accessUntil: string): string {
  const ms = new Date(accessUntil).getTime() - Date.now();
  if (ms <= 0) return 'has already ended';
  const totalMin = Math.round(ms / 60_000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (!days && mins) parts.push(`${mins}m`);
  return `in ~${parts.join(' ')}`;
}

function messageFor(r: Recipient): string {
  const until = new Date(r.accessUntil);
  const hhmm = `${String(until.getUTCHours()).padStart(2, '0')}:${String(until.getUTCMinutes()).padStart(2, '0')}`;
  return [
    `Hey, heads up: your Pip trial ends ${timeLeft(r.accessUntil)} (${hhmm} UTC).`,
    '',
    "If you've found it useful, pick a plan here to keep access: https://pipinvest.xyz/#pricing",
  ].join('\n');
}

async function main(): Promise<void> {
  const send = process.argv.includes('--send');
  const cfg = getConfig();

  const withMessage = RECIPIENTS.map((r) => ({ ...r, message: messageFor(r) }));
  for (const r of withMessage) {
    console.log(`--- ${r.platform} ${r.id} (${r.name}) ---\n${r.message}\n`);
  }

  if (!send) {
    console.log('DRY RUN — nothing sent. Re-run with --send to deliver.');
    return;
  }

  const discordRecipients = withMessage.filter((r) => r.platform === 'discord');
  if (discordRecipients.length) {
    if (!cfg.DISCORD_TOKEN) throw new Error('DISCORD_TOKEN is not set.');
    const client = new Client({ intents: [GatewayIntentBits.Guilds] });
    await client.login(cfg.DISCORD_TOKEN);
    await new Promise<void>((r) => client.once('clientReady', () => r()));
    try {
      for (const r of discordRecipients) {
        const user = await client.users.fetch(r.id);
        await user.send(r.message);
        console.log(`✅ sent to ${user.username} (discord)`);
      }
    } finally {
      await client.destroy();
    }
  }

  const telegramRecipients = withMessage.filter((r) => r.platform === 'telegram');
  if (telegramRecipients.length) {
    if (!cfg.TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is not set.');
    const bot = new Bot(cfg.TELEGRAM_BOT_TOKEN);
    await bot.init();
    for (const r of telegramRecipients) {
      await bot.api.sendMessage(Number(r.id), r.message);
      console.log(`✅ sent to ${r.name} (telegram)`);
    }
  }
}

main().catch((e) => {
  console.error(`failed: ${(e as Error).message}`);
  process.exit(1);
});
