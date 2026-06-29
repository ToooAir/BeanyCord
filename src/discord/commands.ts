import { ApplicationIntegrationType, InteractionContextType, SlashCommandBuilder } from 'discord.js';

/**
 * Slash command definitions.
 *
 * For the commands to be usable **in DMs**, two things must be true:
 *   1. They are registered GLOBALLY (guild-scoped commands never appear in DMs).
 *      See registerCommands.ts — leave DISCORD_GUILD_ID blank.
 *   2. Their `contexts` include `BotDM` (DM with this bot). We also allow
 *      `Guild` so they still work inside the shared server.
 *
 * Optional `DISCORD_USER_INSTALL=1` additionally marks them user-installable
 * (`UserInstall` integration + `PrivateChannel` context) so a user can install
 * the app to their own account and use `/login` in any DM without sharing a
 * server. That REQUIRES enabling "User Install" in the Developer Portal →
 * Installation first, or registration will fail.
 */
const userInstall = process.env.DISCORD_USER_INSTALL === '1';

const integrationTypes = userInstall
  ? [ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall]
  : [ApplicationIntegrationType.GuildInstall];

const contexts = userInstall
  ? [InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel]
  : [InteractionContextType.Guild, InteractionContextType.BotDM];

export const commands = [
  new SlashCommandBuilder()
    .setName('login')
    .setDescription('用 Beanfun QR 碼登入,並在私訊取得遊戲 OTP')
    .addStringOption((o) =>
      o
        .setName('code')
        .setDescription('首次使用的存取碼(已授權者免填)')
        .setRequired(false),
    ),
  new SlashCommandBuilder().setName('logout').setDescription('登出並清除你的 Beanfun session'),
  new SlashCommandBuilder().setName('status').setDescription('查看你目前的登入狀態'),
  new SlashCommandBuilder()
    .setName('clear')
    .setDescription('刪除我在這個 DM 發過的所有訊息 (OTP/選單等)'),
].map((c) => c.setContexts(contexts).setIntegrationTypes(integrationTypes).toJSON());
