import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  Events,
  Interaction,
  ChatInputCommandInteraction,
  MessageFlags,
} from 'discord.js';
import { getConfig } from '../config.js';
import { NormalizedMessage, NormalizedReply, PlatformAdapter } from './platform.js';
import { fmtUtcHm } from '../core/util.js';

export const PAUL_COMMAND_NAME = 'paul';
export const PAUL_QUESTION_OPTION = 'question';

const PAUL_BLUE = 0x2b6cb0;

export class DiscordAdapter implements PlatformAdapter {
  private client: Client | null = null;
  private handler: ((msg: NormalizedMessage) => Promise<NormalizedReply>) | null = null;

  async start(handler: (msg: NormalizedMessage) => Promise<NormalizedReply>): Promise<void> {
    if (this.client) throw new Error('DiscordAdapter already started');
    this.handler = handler;

    const client = new Client({ intents: [GatewayIntentBits.Guilds] });
    this.client = client;

    client.once(Events.ClientReady, (c) => {
      console.log(`[discord] logged in as ${c.user.tag}, watching ${c.guilds.cache.size} guild(s)`);
    });

    client.on(Events.InteractionCreate, (interaction: Interaction) => {
      this.handleInteraction(interaction).catch((e) => {
        console.error('[discord] interaction handler crashed:', e);
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

  private async handleInteraction(interaction: Interaction): Promise<void> {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== PAUL_COMMAND_NAME) return;
    if (!this.handler) return;
    await this.handlePaul(interaction);
  }

  private async handlePaul(interaction: ChatInputCommandInteraction): Promise<void> {
    const question = interaction.options.getString(PAUL_QUESTION_OPTION, true);
    // Public response — community can see Paul's answer. (Use ephemeral on errors only.)
    try {
      await interaction.deferReply();
    } catch (e) {
      // 10062 = Discord considered the interaction expired (>3s to ACK).
      // Usually caused by a process restart between gateway event and HTTP ack.
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

    try {
      const reply = await this.handler!(msg);
      await interaction.editReply({ embeds: [toEmbed(reply, question)] });
    } catch (e) {
      console.error('[discord] /paul failed:', e);
      await interaction
        .editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xc53030)
              .setTitle('Paul hit a snag')
              .setDescription(`\`${(e as Error).message}\``)
              .setFooter({ text: 'Try again in a moment.' }),
          ],
        })
        .catch(() => {});
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

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

// `MessageFlags.Ephemeral` re-export silences an unused-import warning if discord.js changes
export { MessageFlags };
