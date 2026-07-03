import { REST, Routes } from 'discord.js';
import { getConfig } from '../config.js';

// Pip has NO slash command — it answers on @-mention (in allowed channels) and
// in DMs. This script CLEARS any previously-registered command (e.g. the old
// /paul) by pushing an empty command set. Run it once after the rebrand.
async function main() {
  const cfg = getConfig();
  if (!cfg.DISCORD_TOKEN || !cfg.DISCORD_APP_ID) {
    throw new Error('Discord is not configured — set DISCORD_TOKEN and DISCORD_APP_ID.');
  }
  const rest = new REST({ version: '10' }).setToken(cfg.DISCORD_TOKEN);

  if (cfg.DISCORD_DEV_GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(cfg.DISCORD_APP_ID, cfg.DISCORD_DEV_GUILD_ID), {
      body: [],
    });
    console.log(`Cleared guild commands in ${cfg.DISCORD_DEV_GUILD_ID}.`);
  }
  await rest.put(Routes.applicationCommands(cfg.DISCORD_APP_ID), { body: [] });
  console.log('Cleared global commands. Pip is @-mention / DM only now.');
}

main().catch((e) => {
  console.error('clear-commands failed:', e);
  process.exit(1);
});
