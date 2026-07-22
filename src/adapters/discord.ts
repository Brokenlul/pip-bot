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
  Guild,
  GuildMember,
  ChannelType,
  PermissionsBitField,
  type TextChannel,
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
import { registerPusher } from '../core/push.js';
import { markGuildInstalled, markGuildRemoved } from '../memory/store.js';
import { recordCommunityJoin } from '../memory/attribution.js';
import { registerGuildGreeter } from '../core/guild-greeter.js';

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

// Outbound welcome-DM rate cap. A raid on the community server must not turn
// Pip into a mass-DM bot; leads are still recorded when this trips.
const JOIN_DM_MAX = 20;
const JOIN_DM_WINDOW_MS = 60_000;
let joinDmTimes: number[] = [];

// Posted once when Pip is added to a server. Static text, no model call, so
// greeting every install costs nothing. Leads with the @-mention rule because
// that is the single thing that makes an installed Pip actually usable.
// Posted ONCE into a server, and only after nobody has pinged Pip during the
// grace period (see core/guild-greeter.ts). Deliberately short: this is an
// unprompted message in someone else's server, so it introduces Pip and gets
// out of the way rather than dumping a feature list nobody asked for.
const GUILD_WELCOME = [
  "Hi, I'm **Pip** 🌱 an AI markets analyst.",
  '',
  "**@mention me** in any channel and ask away. Live funding and open interest, spot prices, macro, token scans, equities. Drop a chart screenshot and I'll read that too.",
  '',
  "Try `@Pip what's BTC funding right now?` Not financial advice.",
].join('\n');

// One-time DM to anyone joining the main Pip community server. Every joiner is
// a lead, and this is the only moment we can reach them directly.
export const COMMUNITY_WELCOME = [
  "Hi, I'm **Pip** 🌱 welcome to my server.",
  '',
  "I'm an AI markets analyst. Whatever you're trading, I'll give you the sharpest read I can on it.",
  '',
  '**How to use me:**',
  '• **DM me right here.** Just message me, no @mention needed. Easiest way to work.',
  '• **In the server.** @mention me in any channel, like <#1522871958268809288>',
  '• **On Telegram:** https://t.me/pipinvestbot',
  '• **Add me to your own server:** https://pipinvest.xyz',
  '',
  'Ask me anything and get your work done:',
  "• `what's BTC funding right now?` for live funding, open interest, positioning",
  '• `scan <contract address>` to check if a shitcoin is safe to touch: holders, LP, insiders, honeypot',
  '• `next CPI print?` for macro, FOMC, and what it means for risk',
  '• drop a chart screenshot and I\'ll read the structure off it',
  '• tell me a trade thesis with your entry, timeframe and invalidation, and I\'ll pick holes in it',
  '',
  "You're on a **free 7-day trial** from your first question. Not financial advice, and I never give buy/sell calls, the trade is always yours.",
].join('\n');

// Discord has no /start, so a first-ever DM used to get straight into an answer
// with no introduction. Sent once, on the message that enrolls them.
const DM_WELCOME = [
  "Hey 🌱 I'm **Pip**, an AI markets analyst. Whatever you're trading, I'll give you the sharpest read I can on it.",
  '',
  'Live funding and open interest, spot prices, macro (FOMC/CPI), token security scans, equities fundamentals, fused into one honest, two-sided read. Drop a chart screenshot and I\'ll read that too.',
  '',
  "You're on a **free 7-day trial** starting now. Let me take a look at your question 👇",
].join('\n');

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
    // Best-effort: a missed spend alert is worth logging, not retrying.
    setFounderNotifier((userId, text) =>
      this.dmUser(userId, text).catch((e) => {
        console.warn(`[discord] founder DM failed: ${(e as Error).message}`);
      }),
    );
    // Price-alert pushes (src/core/alert-poller.ts) route through the same DM path.
    registerPusher('discord', (userId, text) => this.dmUser(userId, text));
    // Deferred server introductions (src/core/guild-greeter.ts) post through us.
    registerGuildGreeter((guildId) => this.greetGuild(guildId));

    const token = getConfig().DISCORD_TOKEN;
    if (!token) throw new Error('DISCORD_TOKEN is not set — cannot start the Discord adapter.');

    // GuildMembers is PRIVILEGED. If "Server Members Intent" is off in the dev
    // portal, Discord does not merely withhold the events — it refuses the
    // gateway connection outright with "Used disallowed intents", which takes
    // the entire bot down. That is far too much to lose for one optional
    // feature, so try with it and fall back to a client without it.
    // Self-healing: flipping the portal toggle makes the next boot keep it.
    try {
      await this.connect(token, true);
    } catch (e) {
      if (!/disallowed intents/i.test(String((e as Error).message))) throw e;
      console.warn(
        '[discord] "Server Members Intent" is OFF in the dev portal, so community join ' +
          'welcomes and lead capture are DISABLED. Everything else runs normally. ' +
          'Enable it under Bot → Privileged Gateway Intents and redeploy to turn them on.',
      );
      await this.connect(token, false);
    }
  }

  /** Build, wire, and log in a client. `withMembers` adds the privileged intent. */
  private async connect(token: string, withMembers: boolean): Promise<void> {
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
        // Privileged, and optional — see the fallback in start().
        ...(withMembers ? [GatewayIntentBits.GuildMembers] : []),
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

    // Pip landing in a server is a funnel step we were completely blind to:
    // guilds rows are written by ensureGuild on the FIRST MESSAGE, so a server
    // that installed Pip and never mentioned it left no trace anywhere.
    client.on(Events.GuildCreate, (guild) => {
      this.handleGuildJoin(guild).catch((e) => {
        console.error('[discord] guild join handler crashed:', e);
      });
    });

    client.on(Events.GuildDelete, (guild) => {
      console.log(`[discord] removed from guild ${guild.id} (${guild.name ?? 'unknown'})`);
      void markGuildRemoved(guild.id).catch((e) =>
        console.warn(`[discord] markGuildRemoved: ${(e as Error).message}`),
      );
    });

    // Someone joined the main Pip community server. Every joiner is a lead, so
    // record it and send the one-time welcome DM.
    client.on(Events.GuildMemberAdd, (member) => {
      this.handleCommunityJoin(member).catch((e) => {
        console.error('[discord] member join handler crashed:', e);
      });
    });

    client.on(Events.Error, (e) => console.error('[discord] client error:', e));
    client.on(Events.Warn, (w) => console.warn('[discord] warn:', w));

    try {
      await client.login(token);
    } catch (e) {
      // Leave no half-connected client behind for the fallback attempt to trip on.
      this.client = null;
      await client.destroy().catch(() => {});
      throw e;
    }
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
  /**
   * DM a user. Throws if the send fails — callers decide what that means, so a
   * dropped push can't look like a delivered one.
   */
  /**
   * Pip was added to a server. Record the install (the funnel step we used to
   * miss entirely) and greet the room so the person who added it knows how to
   * actually use it — an installed bot nobody @-mentions is a silent churn.
   */
  private async handleGuildJoin(guild: Guild): Promise<void> {
    console.log(`[discord] added to guild ${guild.id} (${guild.name})`);
    // Record the install and nothing else. Pip stays quiet and waits to be
    // pinged; the deferred greeter (core/guild-greeter.ts) only speaks up if
    // the server never does. Members are never DMed on an install.
    await markGuildInstalled(guild.id, guild.name).catch((e) =>
      console.warn(`[discord] markGuildInstalled: ${(e as Error).message}`),
    );
  }

  /**
   * Post the one-time introduction into a server that never pinged Pip.
   * Returns false when there's nowhere it can post, so the caller can retire
   * the attempt instead of retrying forever.
   */
  async greetGuild(guildId: string): Promise<boolean> {
    const guild = this.client?.guilds.cache.get(guildId);
    if (!guild) return false;
    const channel = this.greetableChannel(guild);
    if (!channel) {
      console.log(`[discord] no greetable channel in ${guildId}`);
      return false;
    }
    try {
      await channel.send(GUILD_WELCOME);
      console.log(`[discord] introduced Pip in ${guildId} #${channel.name}`);
      return true;
    } catch (e) {
      console.warn(`[discord] guild greeting failed in ${guildId}: ${(e as Error).message}`);
      return false;
    }
  }

  /**
   * A join on the main community server. Records the lead, then DMs the joiner
   * once.
   *
   * Scoped to PIP_COMMUNITY_GUILD_ID on purpose: welcome-DM-ing everyone who
   * joins any server Pip happens to sit in is the textbook Discord spam
   * pattern. Unset means this does nothing at all.
   */
  private async handleCommunityJoin(member: GuildMember): Promise<void> {
    const communityId = getConfig().PIP_COMMUNITY_GUILD_ID;
    if (!communityId || member.guild.id !== communityId) return;
    if (member.user.bot) return;

    void recordCommunityJoin(member.guild.id, member.id, member.user.username).catch((e) =>
      console.warn(`[discord] recordCommunityJoin: ${(e as Error).message}`),
    );

    // Raid guard. A join flood must never turn into a DM flood — that is what
    // gets a bot reported and banned. The lead is still recorded above; only
    // the outbound DM is dropped.
    const now = Date.now();
    joinDmTimes = joinDmTimes.filter((t) => now - t < JOIN_DM_WINDOW_MS);
    if (joinDmTimes.length >= JOIN_DM_MAX) {
      console.warn(`[discord] join-DM rate cap hit (${JOIN_DM_MAX}/${JOIN_DM_WINDOW_MS}ms), skipping DM for ${member.id}`);
      return;
    }
    joinDmTimes.push(now);

    try {
      await member.send(COMMUNITY_WELCOME);
      console.log(`[discord] welcomed community joiner ${member.id}`);
    } catch (e) {
      // Most commonly "Cannot send messages to this user": DMs closed, which is
      // normal and not an error worth surfacing.
      console.log(`[discord] join DM not delivered for ${member.id}: ${(e as Error).message}`);
    }
  }

  /**
   * The channel a server would most plausibly want to talk to Pip in.
   *
   * Ranked by name, because the system channel is often a join-spam/audit
   * channel nobody reads, and channel position is a poor proxy for "where
   * conversation happens". Trading rooms beat general chat, general chat beats
   * the system channel, and anything sendable beats staying silent. Permissions
   * are checked up front so we never fire a send we know will 403.
   */
  private greetableChannel(guild: Guild): TextChannel | null {
    const me = guild.members.me;
    if (!me) return null;
    const canSend = (c: TextChannel) =>
      c.permissionsFor(me)?.has([
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
      ]) ?? false;

    const score = (name: string): number => {
      const n = name.toLowerCase();
      // A channel named for the bot itself is the most explicit invitation
      // there is (#ask-pip, #pip-chat), so it outranks even a trading room.
      if (/(ask-?pip|pip-?(chat|bot|talk))/.test(n)) return 5;
      if (/(trading|trades|markets?|ta|charts?|alpha|degen)/.test(n)) return 4;
      if (/(general|chat|lounge|main|talk)/.test(n)) return 3;
      if (/(bot|commands?|spam)/.test(n)) return 2; // where bots are tolerated
      // Places an unprompted bot post is unwelcome or will be missed.
      if (/(announce|rules|welcome|log|audit|mod|admin|ticket)/.test(n)) return 0;
      return 1;
    };

    const candidates = [...guild.channels.cache.values()]
      .filter((c): c is TextChannel => c.type === ChannelType.GuildText && canSend(c as TextChannel))
      .map((c) => ({ c, s: score(c.name) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || a.c.rawPosition - b.c.rawPosition);

    const best = candidates[0];
    if (best) return best.c;

    // Everything scored zero (a rules/announcements-only server). The system
    // channel is a better last resort than silence, if we can post there.
    const system = guild.systemChannel;
    return system && canSend(system) ? system : null;
  }

  private async dmUser(userId: string, text: string): Promise<void> {
    const client = this.client;
    if (!client) throw new Error('Discord client not started');
    const user = await client.users.fetch(userId);
    await user.send(text);
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
  ): Promise<{ embeds: EmbedBuilder[]; files?: AttachmentBuilder[] } | null> {
    try {
      const reply = await this.handler!(msg, opts);
      if (!reply) return null; // draining for restart — replacement instance answers
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

    // Show life immediately — image downloads + the beta gate cost up to ~1s of
    // CDN/DB round trips before the answer work even starts. (A user the gate
    // then blocks sees a brief "typing" before the notice — fine trade.)
    const keepTyping = () => {
      if (message.channel.isSendable()) void message.channel.sendTyping().catch(() => {});
    };
    keepTyping();
    const typingTimer = setInterval(keepTyping, 8000);

    try {
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

      // Cost + access gate — caps / kill-switch — BEFORE any LLM call.
      const gate = await betaGate(msg);
      if (!gate.allow) {
        if (!gate.silent && gate.replyText) await this.send(message, gate.replyText);
        return;
      }

      // First message ever from this person in a DM: introduce Pip before
      // answering, since Discord has no /start to carry an introduction. Server
      // arrivals are greeted by GUILD_WELCOME on install instead, so greeting
      // them again here would be the second welcome in the same channel.
      // Best-effort: a failed greeting must not cost them their answer.
      if (gate.enrolled && isDM) {
        await this.send(message, DM_WELCOME).catch((e) =>
          console.warn(`[discord] DM welcome failed: ${(e as Error).message}`),
        );
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

      const label = question || (images.length ? `[${images.length} chart image${images.length > 1 ? 's' : ''}]` : '');
      const payload = await this.computePayload(msg, label, this.optsFrom(gate));
      if (payload) await this.send(message, payload);
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
  const embed = new EmbedBuilder().setColor(PIP_GREEN);
  if (reply.title) embed.setTitle(reply.title);
  // The body is one sectioned text block (📊 Snapshot / 🧠 Read / …) — same
  // layout Telegram renders, so both platforms read identically.
  const body = truncate(reply.body, 4000).trim();
  if (body) embed.setDescription(body);
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
