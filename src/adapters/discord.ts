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
import { NormalizedMessage, NormalizedReply, PlatformAdapter } from './platform.js';
import { fmtUtcHm } from '../core/util.js';

export const PAUL_COMMAND_NAME = 'paul';
export const PAUL_QUESTION_OPTION = 'question';

const PAUL_BLUE = 0x2b6cb0;
const MAX_QUESTION_LEN = 1000;

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
      } catch {
        return;
      }
    }
    if (message.author?.bot) return; // never respond to bots (or ourselves) → no loops

    const botId = this.client.user.id;
    const isDM = !message.inGuild();
    const mentioned = message.mentions.users.has(botId);
    // In servers: only when @-mentioned. In DMs: always.
    if (!isDM && !mentioned) return;

    const question = message.content
      .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
      .trim()
      .slice(0, MAX_QUESTION_LEN);

    if (!question) {
      await message
        .reply('Ask me something about markets — e.g. `what\'s BTC funding right now?` or `next CPI print?`')
        .catch(() => {});
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
        receivedAt: new Date(),
      };
      const embed = await this.computeEmbed(msg, question);
      await message.reply({ embeds: [embed] }).catch(() => {});
    } finally {
      clearInterval(typingTimer);
    }
  }
}

function toEmbed(reply: NormalizedReply, question: string): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(PAUL_BLUE).setDescription(truncate(reply.body, 4000));
  if (reply.title) embed.setTitle(reply.title);
  if (reply.sources.length > 0) {
    const list = reply.sources
      .map((s) => (s.url ? `[${s.label}](${s.url})` : s.label))
      .join(' · ');
    embed.addFields({ name: 'Sources', value: truncate(list, 1000), inline: false });
  }
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
