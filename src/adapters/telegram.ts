import { Bot, Context, GrammyError, InputFile } from 'grammy';
import type { Message, PhotoSize } from 'grammy/types';
import { getConfig } from '../config.js';
import {
  NormalizedMessage,
  NormalizedImage,
  NormalizedReply,
  PlatformAdapter,
  MessageHandler,
} from './platform.js';
import { betaGate, recordFeedback } from '../beta/guardrails.js';
import { renderReplyText } from '../core/formatter.js';

// Telegram feedback reactions → rating (mirrors the Discord map).
const TG_RATING: Record<string, 'up' | 'down'> = {
  '👍': 'up', '❤': 'up', '🔥': 'up', '👎': 'down',
};

const MAX_QUESTION_LEN = 1000;

// Static first-touch welcome for /start — sent before the beta gate (zero LLM
// cost, so it's safe to greet anyone) so it never consumes the cooldown slot.
const WELCOME = [
  "Hey — I'm Pip 🌱 an AI markets analyst.",
  '',
  'I read markets the way a trader does: live funding and open interest, spot prices, macro (FOMC/CPI), token security scans, equities fundamentals — fused into one honest, two-sided read.',
  '',
  'Try me:',
  "• what's BTC funding right now?",
  '• next CPI print?',
  '• scan <contract address>',
  '• show me SOL on the 4h with RSI',
  "• drop a chart screenshot and I'll read it",
  '',
  "Got a trade thesis? Tell me your entry, timeframe, and invalidation — I'll stress-test it against live data. I never give buy/sell calls; the trade is always yours. Not financial advice.",
].join('\n');

// Telegram caps a single message at 4096 chars; leave headroom for safety.
const TG_MAX_MESSAGE = 4000;

// Replied-to context is bounded — it rides inside the prompt on every turn.
const MAX_REPLY_CONTEXT = 1500;

// Vision limits mirror the Discord adapter — a user can drop an HTF + LTF pair.
// Telegram compresses photos to JPEG; documents keep their type.
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const SUPPORTED_IMAGE_TYPES: Record<string, NormalizedImage['mediaType']> = {
  'image/png': 'image/png',
  'image/jpeg': 'image/jpeg',
  'image/jpg': 'image/jpeg',
  'image/gif': 'image/gif',
  'image/webp': 'image/webp',
};

export class TelegramAdapter implements PlatformAdapter {
  private bot: Bot | null = null;
  private handler: MessageHandler | null = null;

  async start(handler: MessageHandler): Promise<void> {
    if (this.bot) throw new Error('TelegramAdapter already started');
    const token = getConfig().TELEGRAM_BOT_TOKEN;
    if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set — cannot start the Telegram adapter.');
    this.handler = handler;

    const bot = new Bot(token);
    this.bot = bot;

    bot.on('message', (ctx) => {
      this.handleMessage(ctx).catch((e) => {
        console.error('[telegram] message handler crashed:', e);
      });
    });

    // 👍/👎 on Pip's answers — DM-only, where the reacted message is reliably
    // Pip's (Telegram doesn't tell us the reacted message's author).
    bot.on('message_reaction', (ctx) => {
      const mr = ctx.messageReaction;
      if (!mr || mr.chat.type !== 'private' || !mr.user) return;
      const emoji = mr.new_reaction.find((r) => r.type === 'emoji');
      const rating = emoji && 'emoji' in emoji ? TG_RATING[emoji.emoji] : undefined;
      if (!rating) return;
      void recordFeedback({
        platform: 'telegram',
        guildId: `dm:tg:${mr.user.id}`,
        messageId: String(mr.message_id),
        raterId: String(mr.user.id),
        rating,
      }).catch((e) => console.warn(`[telegram] recordFeedback: ${(e as Error).message}`));
    });

    bot.catch((err) => console.error('[telegram] bot error:', err.error));

    // init() populates bot.botInfo so we can log identity and detect @-mentions.
    await bot.init();
    console.log(`[telegram] logged in as @${bot.botInfo.username} (id ${bot.botInfo.id})`);

    // start() runs the long-polling loop; it never resolves while running, so we
    // do NOT await it here (mirrors DiscordAdapter.start returning after login).
    void bot.start({
      onStart: () => console.log('[telegram] long-polling started'),
      drop_pending_updates: true,
      // message_reaction updates are off by default — opt in for feedback.
      allowed_updates: ['message', 'message_reaction'],
    });
  }

  async stop(): Promise<void> {
    await this.bot?.stop();
    this.bot = null;
  }

  private async handleMessage(ctx: Context): Promise<void> {
    if (!this.handler || !this.bot) return;
    const message = ctx.message;
    if (!message || !ctx.from) return;
    if (ctx.from.is_bot) return; // never respond to bots (or ourselves) → no loops

    const chatType = ctx.chat?.type ?? 'private';
    const isDM = chatType === 'private';
    const botUsername = this.bot.botInfo.username;
    const botId = this.bot.botInfo.id;

    const rawText = message.text ?? message.caption ?? '';
    const mentioned =
      mentionsBot(message, botUsername) ||
      // A reply to one of the bot's own messages counts as addressing it.
      message.reply_to_message?.from?.id === botId;

    // In groups: only when @-mentioned or replied to. In DMs: always.
    if (!isDM && !mentioned) return;

    // /start = Telegram's universal opener (also fired by deep links with a
    // payload). Greet with who Pip is and how to use it — no model call.
    if (isDM && /^\/start(\s|$)/.test(rawText)) {
      await this.send(ctx, WELCOME);
      return;
    }

    const question = stripMention(rawText, botUsername).slice(0, MAX_QUESTION_LEN);
    const images = await this.collectImages(ctx);

    // Carry the replied-to message's text — it's the context "these"/"that"
    // refers to, including answers the bot gave a DIFFERENT user (which the
    // per-user thread memory deliberately can't see).
    const rtm = message.reply_to_message;
    const replyToText = (rtm?.text ?? rtm?.caption)?.trim().slice(0, MAX_REPLY_CONTEXT) || undefined;

    const msg: NormalizedMessage = {
      platform: 'telegram',
      // Namespace memory per chat, prefixed so a Telegram id can never collide
      // with a Discord snowflake in the shared guild_id column.
      guildId: isDM ? `dm:tg:${ctx.from.id}` : `tg:${ctx.chat!.id}`,
      guildName: isDM ? undefined : chatTitle(ctx),
      channelId: String(ctx.chat!.id),
      userId: String(ctx.from.id),
      userName: ctx.from.username ?? ctx.from.first_name,
      text: question,
      images: images.length ? images : undefined,
      replyToText,
      replyToBot: replyToText ? rtm?.from?.id === botId : undefined,
      receivedAt: new Date(),
    };

    // Beta gate — allowlist / caps / kill-switch — BEFORE any typing or LLM call.
    const gate = await betaGate(msg);
    if (!gate.allow) {
      if (!gate.silent && gate.replyText) await this.send(ctx, gate.replyText);
      return;
    }

    // A bare mention with neither text nor an image → nudge. With an image we
    // proceed even without a caption ("read this chart" is implicit).
    if (!question && images.length === 0) {
      await this.send(
        ctx,
        "Ask me something about markets — e.g. what's BTC funding right now?, next CPI print?, or drop a chart screenshot.",
      );
      return;
    }

    // Keep a "typing" action alive — answers take a while. Telegram's typing
    // status auto-expires after ~5s, so refresh it on an interval.
    const keepTyping = () => void ctx.replyWithChatAction('typing').catch(() => {});
    keepTyping();
    const typingTimer = setInterval(keepTyping, 4500);

    try {
      let reply: NormalizedReply | null;
      try {
        reply = await this.handler(msg, {
          allowWeb: gate.features.web,
          allowVision: gate.features.vision,
          allowScan: gate.features.scan,
          degraded: gate.degraded,
        });
      } catch (e) {
        // Log the real error server-side; never echo raw exception text to the
        // user (can leak internal detail — provider errors, URLs, stack).
        console.error('[telegram] answer failed:', e);
        await this.send(ctx, 'Pip hit a snag pulling that together. Try again in a moment.');
        return;
      }
      if (!reply) return; // draining for restart — replacement instance answers
      await this.send(ctx, toHtml(reply), { html: true });
      // Rendered charts follow the text as photos. Best-effort — a failed
      // photo upload must never eat the answer that already went out.
      for (const att of reply.attachments ?? []) {
        await ctx
          .replyWithPhoto(new InputFile(att.data, att.filename))
          .catch((e) => console.warn(`[telegram] chart send failed: ${(e as Error).message}`));
      }
    } finally {
      clearInterval(typingTimer);
    }
  }

  /**
   * Pull photo/image-document attachments off a message, download the bytes via
   * the Telegram file API, and base64-encode for the vision API. Best-effort:
   * unsupported types, oversized files, and failed fetches are skipped rather
   * than thrown — a bad attachment must never sink the reply.
   */
  private async collectImages(ctx: Context): Promise<NormalizedImage[]> {
    if (!this.bot) return [];
    const message = ctx.message!;
    const out: NormalizedImage[] = [];

    // Telegram sends a photo as multiple sizes; take the largest under the cap.
    const fileIds: string[] = [];
    if (message.photo?.length) {
      const best = largestPhotoUnderCap(message.photo);
      if (best) fileIds.push(best.file_id);
    }
    // An image sent as an uncompressed "file" arrives as a document.
    const doc = message.document;
    if (doc && doc.mime_type && SUPPORTED_IMAGE_TYPES[doc.mime_type.toLowerCase()]) {
      if (!doc.file_size || doc.file_size <= MAX_IMAGE_BYTES) fileIds.push(doc.file_id);
    }

    const token = getConfig().TELEGRAM_BOT_TOKEN!;
    for (const fileId of fileIds) {
      if (out.length >= MAX_IMAGES) break;
      try {
        const file = await this.bot.api.getFile(fileId);
        if (!file.file_path) continue;
        if (file.file_size && file.file_size > MAX_IMAGE_BYTES) continue;
        const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.byteLength > MAX_IMAGE_BYTES) continue;
        // Trust the magic bytes — Anthropic rejects a media_type that doesn't
        // match the actual image bytes. Photos are JPEG but documents vary.
        const mediaType = sniffImageType(buf);
        if (!mediaType) continue;
        out.push({ mediaType, dataBase64: buf.toString('base64') });
      } catch (e) {
        console.warn(`[telegram] failed to fetch image ${fileId}: ${(e as Error).message}`);
      }
    }
    return out;
  }

  /**
   * Send a reply, splitting on Telegram's 4096-char limit. On an HTML parse
   * error (400 "can't parse entities"), retry the same text as plain text so a
   * formatting slip never drops the answer.
   */
  private async send(
    ctx: Context,
    text: string,
    opts: { html?: boolean } = {},
  ): Promise<void> {
    const chunks = splitForTelegram(text);
    for (const chunk of chunks) {
      try {
        await ctx.reply(chunk, opts.html ? { parse_mode: 'HTML' } : {});
      } catch (e) {
        if (opts.html && e instanceof GrammyError && e.error_code === 400) {
          // Formatting slipped — resend as plain text (tags stripped).
          console.warn(`[telegram] HTML parse failed, retrying as plain text: ${e.description}`);
          await ctx.reply(stripHtml(chunk)).catch((e2) =>
            console.error(`[telegram] plain-text fallback failed: ${(e2 as Error).message}`),
          );
        } else {
          console.error(`[telegram] reply failed: ${(e as Error).message}`);
        }
      }
    }
  }
}

// ---- helpers --------------------------------------------------------------

/** True if the message text @-mentions the bot by username. */
function mentionsBot(message: Message, username: string): boolean {
  const text = message.text ?? message.caption ?? '';
  const entities = message.entities ?? message.caption_entities ?? [];
  const target = `@${username}`.toLowerCase();
  return entities.some(
    (ent) =>
      ent.type === 'mention' &&
      text.slice(ent.offset, ent.offset + ent.length).toLowerCase() === target,
  );
}

/** Remove a leading/anywhere @botusername token from the question text. */
function stripMention(text: string, username: string): string {
  return text.replace(new RegExp(`@${username}\\b`, 'gi'), '').trim();
}

function largestPhotoUnderCap(photos: PhotoSize[]): PhotoSize | undefined {
  // Sizes are ordered small→large; walk down to the biggest within the cap.
  for (let i = photos.length - 1; i >= 0; i--) {
    const p = photos[i]!;
    if (!p.file_size || p.file_size <= MAX_IMAGE_BYTES) return p;
  }
  return undefined;
}

function chatTitle(ctx: Context): string | undefined {
  const chat = ctx.chat;
  if (!chat) return undefined;
  if ('title' in chat && chat.title) return chat.title;
  return undefined;
}

/** Detect the true image type from file magic bytes (not any declared MIME). */
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

/**
 * Render a reply as Telegram HTML. We escape HTML first, THEN convert a small,
 * safe subset of the markdown Pip emits (`**bold**`, `` `code` ``, and the
 * trailing `_italic_` disclaimer). Escaping first guarantees no user content
 * can inject stray tags — only our own conversions produce markup.
 */
function toHtml(reply: NormalizedReply): string {
  const text = renderReplyText(reply);
  let html = escapeHtml(text);
  html = html.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  // renderReplyText wraps the disclaimer line as _..._
  html = html.replace(/_([^_\n]+)_/g, '<i>$1</i>');
  return html;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * Split text into Telegram-sized chunks, preferring to break on paragraph then
 * line boundaries so we never cut mid-word. A chunk is never larger than the
 * limit even if a single line exceeds it (hard-split as a last resort).
 */
function splitForTelegram(text: string, limit = TG_MAX_MESSAGE): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    if (line.length > limit) {
      // Flush what we have, then hard-split the oversized line.
      if (current) {
        chunks.push(current);
        current = '';
      }
      for (let i = 0; i < line.length; i += limit) chunks.push(line.slice(i, i + limit));
      continue;
    }
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > limit) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
