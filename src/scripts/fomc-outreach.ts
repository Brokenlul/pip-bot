/*
 * One-off FOMC outreach DM to a fixed list of active Pip users, across
 * Discord and Telegram.
 *
 * DRY RUN BY DEFAULT. It resolves every recipient and prints exactly what
 * would be sent, plus the randomized send schedule; nothing leaves the
 * process until you pass --send. A DM cannot be unsent, so the safe path is
 * the default one. A failure on one recipient must never block the rest —
 * each send is independent and reports its own result.
 *
 * Sends go out one at a time, in a random order, with a random delay
 * between each (default 45s-5min) — a flat burst of 17 DMs in the same
 * second is the kind of pattern that gets a bot account flagged.
 *
 *   npx tsx src/scripts/fomc-outreach.ts
 *   npx tsx src/scripts/fomc-outreach.ts --send
 *   npx tsx src/scripts/fomc-outreach.ts --send --min-sec=60 --max-sec=600
 *
 * Recipients live in fomc-outreach-recipients.json next to this file
 * (gitignored — it's a list of real user ids, not something to commit).
 * Requires DISCORD_TOKEN for the discord recipients and TELEGRAM_BOT_TOKEN
 * for the telegram ones.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Client, GatewayIntentBits } from 'discord.js';
import { Bot } from 'grammy';
import { getConfig } from '../config.js';

const DEFAULT_MIN_DELAY_SEC = 45;
const DEFAULT_MAX_DELAY_SEC = 300;

const MESSAGE = [
  'Hey, thanks for using Pip.',
  '',
  "FOMC drops tomorrow afternoon (Wed Jul 29, 2pm ET). I'll have the statement read live as it lands: what changed in the language, Warsh's tone in the presser, and how the market's actually reacting, funding, OI, spot, all pulled live and cited.",
  '',
  "We've been building toward exactly this moment. Come put me to the test.",
  '',
  'https://x.com/Pipinvestbot/status/2082092593530478817?s=20',
].join('\n');

interface Recipient {
  name: string;
  platform: 'discord' | 'telegram';
  id: string;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const send = args.includes('--send');

function flagNum(name: string, fallback: number): number {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.slice(name.length + 3)) : fallback;
}
const minDelaySec = flagNum('min-sec', DEFAULT_MIN_DELAY_SEC);
const maxDelaySec = flagNum('max-sec', DEFAULT_MAX_DELAY_SEC);

function loadRecipients(): Recipient[] {
  const file = path.join(__dirname, 'fomc-outreach-recipients.json');
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    throw new Error(
      `missing ${file} — create it with [{ "name": "...", "platform": "discord"|"telegram", "id": "..." }, ...]`,
    );
  }
  return JSON.parse(raw) as Recipient[];
}

/** Fisher-Yates — random send order, not the order recipients happen to be listed in. */
function shuffle<T>(arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

function randomDelayMs(): number {
  const sec = minDelaySec + Math.random() * (maxDelaySec - minDelaySec);
  return Math.round(sec * 1000);
}

function fmtSec(ms: number): string {
  return `${(ms / 1000).toFixed(0)}s`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const recipients = shuffle(loadRecipients());

  console.log(`--- message (identical to all ${recipients.length}) ---\n${MESSAGE}\n----------------------\n`);
  console.log(`send order (randomized), delay ${minDelaySec}-${maxDelaySec}s between each:\n`);

  let etaMs = 0;
  const plan = recipients.map((r, i) => {
    const delay = i === 0 ? 0 : randomDelayMs();
    etaMs += delay;
    return { r, delay, etaMs };
  });
  for (const { r, delay, etaMs: eta } of plan) {
    console.log(`  +${fmtSec(eta).padStart(5)}  (wait ${fmtSec(delay).padStart(4)})  ${r.platform.padEnd(8)} ${r.name.padEnd(16)} ${r.id}`);
  }
  console.log(`\ntotal span: ~${Math.round(etaMs / 60000)} min\n`);

  if (!send) {
    console.log('DRY RUN — nothing sent. Re-run with --send to deliver it.');
    return;
  }

  const cfg = getConfig();
  const needsDiscord = recipients.some((r) => r.platform === 'discord');
  const needsTelegram = recipients.some((r) => r.platform === 'telegram');

  let discordClient: Client | null = null;
  let telegramBot: Bot | null = null;

  if (needsDiscord) {
    if (!cfg.DISCORD_TOKEN) throw new Error('DISCORD_TOKEN is not set — cannot DM the discord recipients.');
    discordClient = new Client({ intents: [GatewayIntentBits.Guilds] });
    await discordClient.login(cfg.DISCORD_TOKEN);
    await new Promise<void>((r) => discordClient!.once('clientReady', () => r()));
  }
  if (needsTelegram) {
    if (!cfg.TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is not set — cannot DM the telegram recipients.');
    telegramBot = new Bot(cfg.TELEGRAM_BOT_TOKEN);
    await telegramBot.init();
  }

  const results: { name: string; platform: string; ok: boolean; error?: string }[] = [];
  try {
    for (let i = 0; i < recipients.length; i++) {
      const r = recipients[i]!;
      const delay = plan[i]!.delay;
      if (delay > 0) {
        console.log(`waiting ${fmtSec(delay)} before ${r.name}...`);
        await sleep(delay);
      }
      try {
        if (r.platform === 'discord') {
          const user = await discordClient!.users.fetch(r.id);
          await user.send(MESSAGE);
        } else {
          await telegramBot!.api.sendMessage(Number(r.id), MESSAGE);
        }
        console.log(`  ✅ ${r.platform} ${r.name}`);
        results.push({ name: r.name, platform: r.platform, ok: true });
      } catch (e) {
        console.log(`  ❌ ${r.platform} ${r.name}: ${(e as Error).message}`);
        results.push({ name: r.name, platform: r.platform, ok: false, error: (e as Error).message });
      }
    }
  } finally {
    await discordClient?.destroy();
  }

  console.log('\n--- results ---');
  for (const res of results) {
    console.log(res.ok ? `  ✅ ${res.platform} ${res.name}` : `  ❌ ${res.platform} ${res.name}: ${res.error}`);
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} sent.`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(`failed: ${(e as Error).message}`);
  process.exit(1);
});
