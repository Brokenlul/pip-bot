import { DiscordAdapter } from './adapters/discord.js';
import { answer } from './core/agent.js';
import { getConfig, memoryEnabled, embeddingsEnabled, companionApiEnabled } from './config.js';
import { renderReplyText } from './core/formatter.js';

async function main(): Promise<void> {
  // Validate config at boot
  getConfig();
  console.log(
    `[paul] memory=${memoryEnabled() ? 'on' : 'off'} cache=${embeddingsEnabled() ? 'on' : 'off'} ` +
      `companion=${companionApiEnabled() ? 'on' : 'off'} ` +
      `(memory needs Supabase, cache also needs Voyage, companion needs PAUL_API_KEY)`,
  );

  const adapter = new DiscordAdapter();
  await adapter.start(async (msg) => {
    const start = Date.now();
    const reply = await answer(msg);
    console.log(
      `[paul] guild=${msg.guildId} user=${msg.userId} q="${truncate(msg.text, 60)}" t=${Date.now() - start}ms src=${reply.sources.length}`,
    );
    return reply;
  });

  const shutdown = async (sig: NodeJS.Signals) => {
    console.log(`[paul] received ${sig}, shutting down`);
    await adapter.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Surface unhandled errors so the host restarts cleanly
  process.on('unhandledRejection', (e) => console.error('[paul] unhandledRejection:', e));
  process.on('uncaughtException', (e) => {
    console.error('[paul] uncaughtException:', e);
    process.exit(1);
  });
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

// Allow `renderReplyText` to stay used (e.g. in future CLI rig)
void renderReplyText;

main().catch((e) => {
  console.error('[paul] fatal:', e);
  process.exit(1);
});
