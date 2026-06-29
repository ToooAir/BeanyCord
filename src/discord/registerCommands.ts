/**
 * Register slash commands. Run once after changing `commands.ts`:
 *   npm run register
 *
 * If DISCORD_GUILD_ID is set -> registers to that guild (instant, for dev).
 * Otherwise -> global (can take up to ~1h to propagate).
 */
import 'dotenv/config';
import { REST, Routes } from 'discord.js';

import { commands } from './commands.js';

async function main(): Promise<void> {
  const token = process.env.DISCORD_TOKEN;
  const clientId = process.env.DISCORD_CLIENT_ID;
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!token || !clientId) {
    throw new Error('DISCORD_TOKEN and DISCORD_CLIENT_ID must be set in .env');
  }

  const rest = new REST({ version: '10' }).setToken(token);
  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
    console.log(`✅ Registered ${commands.length} guild commands to ${guildId} (instant).`);
    console.warn(
      '⚠️  Guild-scoped commands do NOT appear in DMs — they only work inside that server.\n' +
        '    To use /login in the bot DM, unset DISCORD_GUILD_ID and re-run to register GLOBALLY.',
    );
  } else {
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log(`✅ Registered ${commands.length} global commands (may take ~1h to appear, then usable in DMs).`);
    if (process.env.DISCORD_USER_INSTALL === '1') {
      console.log('   User Install enabled — install the app to your account via the portal Install Link.');
    }
  }
}

main().catch((e: unknown) => {
  console.error('register failed:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
