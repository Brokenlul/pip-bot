import { REST, Routes, SlashCommandBuilder } from 'discord.js';
import { getConfig } from '../config.js';
import { PAUL_COMMAND_NAME, PAUL_QUESTION_OPTION } from '../adapters/discord.js';

async function main() {
  const cfg = getConfig();

  const command = new SlashCommandBuilder()
    .setName(PAUL_COMMAND_NAME)
    .setDescription('Ask Paul — grounded crypto/finance/macro answers from live data.')
    .addStringOption((opt) =>
      opt
        .setName(PAUL_QUESTION_OPTION)
        .setDescription('Your question. Example: "what does BTC funding look like right now?"')
        .setRequired(true)
        .setMaxLength(500),
    )
    .toJSON();

  const rest = new REST({ version: '10' }).setToken(cfg.DISCORD_TOKEN);

  if (cfg.DISCORD_DEV_GUILD_ID) {
    console.log(`Registering /paul to dev guild ${cfg.DISCORD_DEV_GUILD_ID}`);
    await rest.put(
      Routes.applicationGuildCommands(cfg.DISCORD_APP_ID, cfg.DISCORD_DEV_GUILD_ID),
      { body: [command] },
    );
    console.log('Done. Slash command should appear instantly in that guild.');
  } else {
    console.log(`Registering /paul globally (can take up to ~1h to propagate)`);
    await rest.put(Routes.applicationCommands(cfg.DISCORD_APP_ID), { body: [command] });
    console.log('Done. Global slash command registered.');
  }
}

main().catch((e) => {
  console.error('register-commands failed:', e);
  process.exit(1);
});
