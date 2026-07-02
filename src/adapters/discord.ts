import {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  Events,
  Interaction,
  Message,
  ChatInputCommandInteraction,
  MessageFlags,
} from 'discord.js';
import { getConfig } from '../config.js';
import { NormalizedMessage, NormalizedImage, NormalizedReply, PlatformAdapter } from './platform.js';
import { fmtUtcHm } from '../core/util.js';

export const PAUL_COMMAND_NAME = 'paul';
export const PAUL_QUESTION_OPTION = 'question';

const PAUL_BLUE = 0x2b6cb0;
const MAX_QUESTION_LEN = 1000;

// Vision limits. The Anthropic API caps a single image at ~5MB; keep a few
// per message so a user can drop an HTF + LTF pair. Anything larger/other is
// silently skipped — a flaky attachment must never sink the reply.
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const SUPPORTED_IMAGE_TYPES: Record<string, NormalizedImage['mediaType']> = {
  'image/png': 'image/png',
  'image/jpeg': 'image/jpeg',
  'image/jpg': 'image/jpeg',
  'image/gif': 'image/gif',
  'image/webp': 'image/webp',
};

export class DiscordAdapter implements PlatformAdapter {
  private client: Client | null = null;
  private handler: ((msg: NormalizedMessage) => Promise<NormalizedReply>) | null = null;

  async start(handler: (msg: NormalizedMessage) => Promise<NormalizedReply>): Promise<void> {
    if (this.client) throw new Error('DiscordAdapter already started');
    this.handler = handler;

    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        // Privileged: enable "Message Content Intent" in the Dev Portal too.
        GatewayIntentBits.MessageContent,
      ],
      // Needed so DM channels/messages (not cached) still fire MessageCreate.
      partials: [Partials.Channel, Partials.Message],
    });
    this.client = client;

    client.once(Events.ClientReady, (c) => {
      console.log(`[discord] logged in as ${c.user.tag}, watching ${c.guilds.cache.size} guild(s)`);
    });

    client.on(Events.InteractionCreate, (interaction: Interaction) => {
      this.handleInteraction(interaction).catch((e) => {
        console.error('[discord] interaction handler crashed:', e);
      });
    });

    client.on(Events.MessageCreate, (message: Message) => {
      this.handleMessage(message).catch((e) => {
        console.error('[discord] message handler crashed:', e);
      });
    });

    client.on(Events.Error, (e) => console.error('[discord] client error:', e));
    client.on(Events.Warn, (w) => console.warn('[discord] warn:', w));

    await client.login(getConfig().DISCORD_TOKEN);
  }

  async stop(): Promise<void> {
    await this.client?.destroy();
    this.client = null;
  }

  /** Shared: run the agent for a normalized message, returning a success or error embed. */
  private async computeEmbed(msg: NormalizedMessage, question: string): Promise<EmbedBuilder> {
    try {
      const reply = await this.handler!(msg);
      return toEmbed(reply, question);
    } catch (e) {
      console.error('[discord] answer failed:', e);
      return errorEmbed(e as Error);
    }
  }

  // ---- Slash command path (kept for backward compatibility) --------------

  private async handleInteraction(interaction: Interaction): Promise<void> {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== PAUL_COMMAND_NAME) return;
    if (!this.handler) return;
    await this.handlePaul(interaction);
  }

  private async handlePaul(interaction: ChatInputCommandInteraction): Promise<void> {
    const question = interaction.options.getString(PAUL_QUESTION_OPTION, true);
    try {
      await interaction.deferReply();
    } catch (e) {
      // 10062 = Discord considered the interaction expired (>3s to ACK).
      if ((e as { code?: number }).code === 10062) {
        console.warn(`[discord] interaction expired before defer (10062) — q="${question.slice(0, 60)}"`);
        return;
      }
      throw e;
    }

    const guildId = interaction.guildId ?? `dm:${interaction.user.id}`;
    const msg: NormalizedMessage = {
      platform: 'discord',
      guildId,
      guildName: interaction.guild?.name,
      userId: interaction.user.id,
      userName: interaction.user.username,
      text: question,
      receivedAt: new Date(),
    };
    await interaction.editReply({ embeds: [await this.computeEmbed(msg, question)] }).catch(() => {});
  }

  // ---- Mention + DM path -------------------------------------------------

  private async handleMessage(message: Message): Promise<void> {
    if (!this.handler || !this.client?.user) return;
    // DM channels/messages arrive as partials — hydrate before reading.
    if (message.partial) {
      try {
        await message.fetch();
      } catch (e) {
        console.warn(`[discord] partial fetch failed (DM channel not resolvable?): ${(e as Error).message}`);
        return;
      }
    }
    if (message.author?.bot) return; // never respond to bots (or ourselves) → no loops

    const botId = this.client.user.id;
    const isDM = !message.inGuild();
    const mentioned = message.mentions.users.has(botId);
    // Visibility for the DM path — if this never logs when you DM the bot, the
    // event isn't reaching us (Dev Portal "Message Content Intent" off, or the
    // user shares no guild / has DMs closed), not a bug in the code below.
    if (isDM) {
      console.log(
        `[discord] DM from ${message.author?.tag ?? message.author?.id} · content ${
          message.content ? 'present' : 'EMPTY (Message Content Intent off?)'
        }`,
      );
    }
    // In servers: only when @-mentioned. In DMs: always.
    if (!isDM && !mentioned) return;

    const question = message.content
      .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
      .trim()
      .slice(0, MAX_QUESTION_LEN);

    const images = await collectImages(message);

    // A bare mention with neither text nor an image → nudge. With an image we
    // proceed even if there's no caption ("read this chart" is implicit).
    if (!question && images.length === 0) {
      await this.send(
        message,
        'Ask me something about markets — e.g. `what\'s BTC funding right now?`, `next CPI print?`, or drop a chart screenshot.',
      );
      return;
    }

    // No 3s ACK deadline here, but answers take a while — keep a typing indicator alive.
    const keepTyping = () => {
      if (message.channel.isSendable()) void message.channel.sendTyping().catch(() => {});
    };
    keepTyping();
    const typingTimer = setInterval(keepTyping, 8000);

    try {
      const msg: NormalizedMessage = {
        platform: 'discord',
        guildId: isDM ? `dm:${message.author.id}` : message.guildId!,
        guildName: isDM ? undefined : message.guild?.name,
        userId: message.author.id,
        userName: message.author.username,
        text: question,
        images: images.length ? images : undefined,
        receivedAt: new Date(),
      };
      const label = question || (images.length ? `[${images.length} chart image${images.length > 1 ? 's' : ''}]` : '');
      const embed = await this.computeEmbed(msg, label);
      await this.send(message, { embeds: [embed] });
    } finally {
      clearInterval(typingTimer);
    }
  }

  /**
   * Send a reply, surfacing failures instead of swallowing them. `message.reply`
   * attaches a reply-reference that is flaky in DMs (partial message, deleted
   * ref, or 50007 "Cannot send messages to this user") — on failure we log the
   * real Discord error and fall back to a plain channel send.
   */
  private async send(
    message: Message,
    payload: string | { embeds: EmbedBuilder[] },
  ): Promise<void> {
    try {
      await message.reply(payload);
    } catch (e) {
      const err = e as { code?: number; message?: string };
      console.error(`[discord] reply failed (code ${err.code ?? '?'}): ${err.message ?? e}`);
      if (message.channel.isSendable()) {
        await message.channel
          .send(payload)
          .catch((e2) => console.error(`[discord] channel.send fallback failed: ${(e2 as Error).message}`));
      }
    }
  }
}

/**
 * Pull image attachments off a message, fetch their bytes, and base64-encode
 * for the vision API. Best-effort: unsupported types, oversized files, and
 * failed fetches are skipped rather than thrown — a bad attachment must never
 * sink the reply. Discord CDN URLs are signed/public, so no auth header needed.
 */
async function collectImages(message: Message): Promise<NormalizedImage[]> {
  const out: NormalizedImage[] = [];
  for (const att of message.attachments.values()) {
    if (out.length >= MAX_IMAGES) break;
    const ct = att.contentType?.split(';')[0]?.trim().toLowerCase();
    const declared = ct ? SUPPORTED_IMAGE_TYPES[ct] : undefined;
    // Only bother with things Discord labels as an image; the true type is
    // sniffed from the bytes below (Discord's contentType is often wrong —
    // e.g. it labels TradingView PNG screenshots as image/webp).
    if (!declared) continue;
    if (att.size > MAX_IMAGE_BYTES) {
      console.warn(`[discord] skipping oversized image (${att.size} bytes): ${att.name}`);
      continue;
    }
    try {
      const res = await fetch(att.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.byteLength > MAX_IMAGE_BYTES) continue;
      // Trust the magic bytes over Discord's label — Anthropic rejects a
      // media_type that doesn't match the actual image bytes.
      const mediaType = sniffImageType(buf) ?? declared;
      out.push({ mediaType, dataBase64: buf.toString('base64') });
    } catch (e) {
      console.warn(`[discord] failed to fetch image ${att.name}: ${(e as Error).message}`);
    }
  }
  return out;
}

/** Detect the true image type from file magic bytes (not the declared MIME). */
function sniffImageType(buf: Buffer): NormalizedImage['mediaType'] | undefined {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)
    return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 4 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38)
    return 'image/gif';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP')
    return 'image/webp';
  return undefined;
}

function toEmbed(reply: NormalizedReply, question: string): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(PAUL_BLUE).setDescription(truncate(reply.body, 4000));
  if (reply.title) embed.setTitle(reply.title);
  // Sources are intentionally NOT shown — Paul answers as its own brain. They're
  // still collected and persisted (conversations.sources) for internal debugging.
  embed.setFooter({
    text: `${reply.disclaimer ?? 'Not financial advice.'} · Asked: ${truncate(question, 80)} · As of ${fmtUtcHm(reply.asOf)}`,
  });
  return embed;
}

function errorEmbed(e: Error): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0xc53030)
    .setTitle('Paul hit a snag')
    .setDescription(`\`${e.message}\``)
    .setFooter({ text: 'Try again in a moment.' });
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

// `MessageFlags.Ephemeral` re-export silences an unused-import warning if discord.js changes
export { MessageFlags };
