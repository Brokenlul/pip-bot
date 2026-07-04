import {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  AttachmentBuilder,
  Events,
  Message,
  MessageReaction,
  PartialMessageReaction,
  User,
  PartialUser,
} from 'discord.js';
import { getConfig } from '../config.js';
import {
  NormalizedMessage,
  NormalizedImage,
  NormalizedReply,
  PlatformAdapter,
  MessageHandler,
  AnswerOptions,
} from './platform.js';
import { betaGate, setFounderNotifier, recordFeedback, type GateDecision } from '../beta/guardrails.js';
import { fmtUtcHm } from '../core/util.js';

// Pip is @-mention / DM only — no slash command. Servers: @-mention in an
// allowed channel; DMs: just message it.

// Feedback reactions → rating. 👍/✅/🔥 = positive, 👎/❌ = negative.
const RATING_EMOJI: Record<string, 'up' | 'down'> = {
  '👍': 'up', '✅': 'up', '🔥': 'up',
  '👎': 'down', '❌': 'down',
};

// Brand accent — Pip Green (#12A15A). The 4px embed side-bar per the PIP brand book.
const PIP_GREEN = 0x12a15a;
// Negative/error state — Clay (#C25B37), the brand's only non-accent data color.
const PIP_CLAY = 0xc25b37;
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
  private handler: MessageHandler | null = null;

  async start(handler: MessageHandler): Promise<void> {
    if (this.client) throw new Error('DiscordAdapter already started');
    this.handler = handler;
    // Founder spend-alert DMs (50/80/100% of daily budget) route through Discord.
    setFounderNotifier((userId, text) => this.dmUser(userId, text));

    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        // Privileged: enable "Message Content Intent" in the Dev Portal too.
        GatewayIntentBits.MessageContent,
        // 👍/👎 feedback on Pip's answers (the pilot Quality metric).
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.DirectMessageReactions,
      ],
      // Partials so DM messages AND reactions on uncached messages still fire.
      partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User],
    });
    this.client = client;

    client.once(Events.ClientReady, (c) => {
      console.log(`[discord] logged in as ${c.user.tag}, watching ${c.guilds.cache.size} guild(s)`);
    });

    client.on(Events.MessageCreate, (message: Message) => {
      this.handleMessage(message).catch((e) => {
        console.error('[discord] message handler crashed:', e);
      });
    });

    client.on(Events.MessageReactionAdd, (reaction, user) => {
      this.handleReaction(reaction, user).catch((e) => {
        console.error('[discord] reaction handler crashed:', e);
      });
    });

    client.on(Events.Error, (e) => console.error('[discord] client error:', e));
    client.on(Events.Warn, (w) => console.warn('[discord] warn:', w));

    const token = getConfig().DISCORD_TOKEN;
    if (!token) throw new Error('DISCORD_TOKEN is not set — cannot start the Discord adapter.');
    await client.login(token);
  }

  async stop(): Promise<void> {
    await this.client?.destroy();
    this.client = null;
  }

  /** Record a 👍/👎 on one of Pip's answers → pilot Quality metric. */
  private async handleReaction(
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser,
  ): Promise<void> {
    if (user.bot || !this.client?.user) return;
    const rating = RATING_EMOJI[reaction.emoji.name ?? ''];
    if (!rating) return; // only count thumbs up/down
    try {
      if (reaction.partial) await reaction.fetch();
      if (reaction.message.partial) await reaction.message.fetch();
    } catch {
      return; // couldn't hydrate — skip
    }
    // Only reactions on PIP's own answers count.
    if (reaction.message.author?.id !== this.client.user.id) return;
    const guildId = reaction.message.guildId ?? `dm:${user.id}`;
    await recordFeedback({
      platform: 'discord',
      guildId,
      messageId: reaction.message.id,
      raterId: user.id,
      rating,
    }).catch((e) => console.warn(`[discord] recordFeedback: ${(e as Error).message}`));
  }

  /** DM a user (founder spend alerts). Best-effort. */
  private async dmUser(userId: string, text: string): Promise<void> {
    try {
      const user = await this.client?.users.fetch(userId);
      await user?.send(text);
    } catch (e) {
      console.warn(`[discord] founder DM failed: ${(e as Error).message}`);
    }
  }

  /** Map a gate decision to the agent's per-request feature budget. */
  private optsFrom(d: GateDecision): AnswerOptions {
    return {
      allowWeb: d.features.web,
      allowVision: d.features.vision,
      allowScan: d.features.scan,
      degraded: d.degraded,
    };
  }

  /** Shared: run the agent for a normalized message, returning a success or error payload. */
  private async computePayload(
    msg: NormalizedMessage,
    question: string,
    opts: AnswerOptions,
  ): Promise<{ embeds: EmbedBuilder[]; files?: AttachmentBuilder[] }> {
    try {
      const reply = await this.handler!(msg, opts);
      const embed = toEmbed(reply, question);
      // Rendered charts ride as attachments; the first one displays inside the
      // branded embed (attachment:// reference), extras appear below it.
      const files = (reply.attachments ?? []).map(
        (a) => new AttachmentBuilder(a.data, { name: a.filename }),
      );
      if (files.length) embed.setImage(`attachment://${reply.attachments![0]!.filename}`);
      return { embeds: [embed], files: files.length ? files : undefined };
    } catch (e) {
      console.error('[discord] answer failed:', e);
      return { embeds: [errorEmbed(e as Error)] };
    }
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
    // Ignore bots/self, webhooks, system messages, and @everyone/@here — these
    // are the classic bot-loop / mass-mention runaway-cost vectors.
    if (message.author?.bot) return;
    if (message.webhookId) return;
    if (message.system) return;
    if (message.mentions.everyone) return;

    const botId = this.client.user.id;
    const isDM = !message.inGuild();
    const mentioned = message.mentions.users.has(botId);

    // Resolve the replied-to message (cache first, one REST fetch as fallback).
    // Carrying its text is what lets "chart these levels" work when "these"
    // lives in an earlier message — including one Pip gave a DIFFERENT user,
    // which the per-user thread memory deliberately can't see.
    const referenced = await this.resolveReference(message);
    const replyToBot = referenced?.author?.id === botId;
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
    // In servers: when @-mentioned OR replying to one of Pip's answers
    // (mirrors the Telegram adapter). In DMs: always.
    if (!isDM && !mentioned && !replyToBot) return;

    const question = message.content
      .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
      .trim()
      .slice(0, MAX_QUESTION_LEN);

    const images = await collectImages(message);
    const replyToText = referenced ? extractMessageText(referenced, botId) : undefined;

    const msg: NormalizedMessage = {
      platform: 'discord',
      guildId: isDM ? `dm:${message.author.id}` : message.guildId!,
      guildName: isDM ? undefined : message.guild?.name,
      channelId: message.channelId,
      userId: message.author.id,
      userName: message.author.username,
      text: question,
      images: images.length ? images : undefined,
      replyToText,
      replyToBot: replyToText ? replyToBot : undefined,
      receivedAt: new Date(),
    };

    // Beta gate — allowlist / caps / kill-switch — BEFORE any typing or LLM call.
    const gate = await betaGate(msg);
    if (!gate.allow) {
      if (!gate.silent && gate.replyText) await this.send(message, gate.replyText);
      return;
    }

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
      const label = question || (images.length ? `[${images.length} chart image${images.length > 1 ? 's' : ''}]` : '');
      const payload = await this.computePayload(msg, label, this.optsFrom(gate));
      await this.send(message, payload);
    } finally {
      clearInterval(typingTimer);
    }
  }

  /** Fetch the message this one replies to — cache first, then one REST call. */
  private async resolveReference(message: Message): Promise<Message | undefined> {
    const refId = message.reference?.messageId;
    if (!refId) return undefined;
    const cached = message.channel.messages.cache.get(refId);
    if (cached) return cached;
    try {
      return await message.fetchReference();
    } catch {
      return undefined; // deleted / not resolvable — proceed without it
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
    payload: string | { embeds: EmbedBuilder[]; files?: AttachmentBuilder[] },
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
      // Hard timeout — a stalled CDN fetch here would hang the whole reply
      // (no typing, no answer) since this runs before the agent loop.
      const res = await fetch(att.url, { signal: AbortSignal.timeout(10_000) });
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

// Replied-to context is bounded — it rides inside the prompt on every turn.
const MAX_REPLY_CONTEXT = 1500;

/**
 * Readable text of a message: Pip's own answers live in the embed description
 * (content is empty on embed messages); user messages live in content.
 */
function extractMessageText(m: Message, botId: string): string | undefined {
  const raw = (m.author?.id === botId ? m.embeds[0]?.description : undefined) ?? m.content ?? '';
  const text = raw.trim();
  return text ? text.slice(0, MAX_REPLY_CONTEXT) : undefined;
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
  const embed = new EmbedBuilder().setColor(PIP_GREEN).setDescription(truncate(reply.body, 4000));
  if (reply.title) embed.setTitle(reply.title);
  // Sources are intentionally NOT shown — Pip answers as its own brain. They're
  // still collected and persisted (conversations.sources) for internal debugging.
  embed.setFooter({
    text: `${reply.disclaimer ?? 'Not financial advice.'} · Asked: ${truncate(question, 80)} · As of ${fmtUtcHm(reply.asOf)}`,
  });
  return embed;
}

// The real error is already logged server-side (computeEmbed). Never surface raw
// exception text to users — it can leak internal details (stack, URLs, provider
// errors) and is noise to a trader. Show a fixed, friendly line instead.
function errorEmbed(_e: Error): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(PIP_CLAY)
    .setTitle('Pip hit a snag')
    .setDescription("Something went wrong pulling that together. Try again in a moment.")
    .setFooter({ text: 'Try again in a moment.' });
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
