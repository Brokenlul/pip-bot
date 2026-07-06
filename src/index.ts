import { DiscordAdapter } from './adapters/discord.js';
import { TelegramAdapter } from './adapters/telegram.js';
import { PlatformAdapter, NormalizedMessage, NormalizedReply } from './adapters/platform.js';
import { answer } from './core/agent.js';
import {
  getConfig,
  memoryEnabled,
  embeddingsEnabled,
  companionApiEnabled,
  discordEnabled,
  telegramEnabled,
} from './config.js';
import { renderReplyText } from './core/formatter.js';

async function main(): Promise<void> {
  // Validate config at boot
  getConfig();
  console.log(
    `[pip] memory=${memoryEnabled() ? 'on' : 'off'} cache=${embeddingsEnabled() ? 'on' : 'off'} ` +
      `companion=${companionApiEnabled() ? 'on' : 'off'} ` +
      `discord=${discordEnabled() ? 'on' : 'off'} telegram=${telegramEnabled() ? 'on' : 'off'} ` +
      `(memory needs Supabase, cache also needs Voyage, companion needs PAUL_API_KEY)`,
  );

  // The same agent handler serves every surface — core is platform-agnostic.
  // The beta gate runs in each adapter (it must decide before typing/replying);
  // here we just thread its feature budget through to the agent.
  // In-flight answers are tracked so a deploy swap / restart (SIGTERM) can
  // DRAIN instead of killing them mid-reply — that silently eats questions.
  const inFlight = new Set<Promise<unknown>>();
  let draining = false;
  const handle = async (
    msg: NormalizedMessage,
    opts?: import('./adapters/platform.js').AnswerOptions,
  ): Promise<NormalizedReply | null> => {
    if (draining) return null; // replacement instance takes it
    const work = (async () => {
      const start = Date.now();
      const reply = await answer(msg, opts);
      console.log(
        `[pip] platform=${msg.platform} guild=${msg.guildId} user=${msg.userId} q="${truncate(msg.text, 60)}" t=${Date.now() - start}ms src=${reply.sources.length}`,
      );
      return reply;
    })();
    inFlight.add(work);
    void work.catch(() => {}).finally(() => inFlight.delete(work));
    return work;
  };

  const adapters: PlatformAdapter[] = [];
  if (discordEnabled()) adapters.push(new DiscordAdapter());
  if (telegramEnabled()) adapters.push(new TelegramAdapter());
  if (adapters.length === 0) {
    throw new Error('No chat platform enabled — set Discord or Telegram credentials in .env.');
  }
  await Promise.all(adapters.map((a) => a.start(handle)));

  const shutdown = async (sig: NodeJS.Signals) => {
    console.log(`[pip] received ${sig}, draining ${inFlight.size} in-flight answer(s)`);
    draining = true; // new messages → null → dropped for the replacement instance
    // Answer budget is 70s — give in-flight work up to 80s, then a beat for the
    // adapters to actually SEND the replies that just resolved.
    await Promise.race([Promise.allSettled([...inFlight]), sleep(80_000)]);
    await sleep(1_500);
    await Promise.all(adapters.map((a) => a.stop()));
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Surface unhandled errors so the host restarts cleanly
  process.on('unhandledRejection', (e) => console.error('[pip] unhandledRejection:', e));
  process.on('uncaughtException', (e) => {
    console.error('[pip] uncaughtException:', e);
    process.exit(1);
  });
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Allow `renderReplyText` to stay used (e.g. in future CLI rig)
void renderReplyText;

main().catch((e) => {
  console.error('[pip] fatal:', e);
  process.exit(1);
});
