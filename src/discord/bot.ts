/**
 * Discord client wiring + interaction dispatch. The actual flow logic lives
 * in `flow.ts`; this file just routes interactions to it.
 */
import {
  Client,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  type ChatInputCommandInteraction,
  type Interaction,
} from 'discord.js';

import { ggmSeverity, ggmVerdict } from '../beanfun/ggmCheck.js';
import { redactText } from '../core/redact.js';
import { SessionManager } from '../core/sessionManager.js';
import { createStore } from '../core/store.js';
import {
  createAccess,
  gateLogin,
  isAuthorized,
  isGated,
  NO_ACCESS,
  type AccessControl,
} from './access.js';
import { isBotDm } from './context.js';
import {
  handleAccountSelect,
  handleChangeAccount,
  handleChangeGame,
  handleClear,
  handleClearConfirm,
  handleGameSelect,
  handleLogin,
  handleLoginCancel,
  handleLoginRefresh,
  handleLogout,
  handleOtpDelete,
  handleOtpRefresh,
  handleQuickOtp,
  notifySessionExpired,
} from './flow.js';
import { CID, parseOtpRefresh } from './ids.js';
import { formatUptime, startPresenceRotation } from './presence.js';

/** Process start, for uptime in the presence rotation and /status. */
const STARTED_AT = Date.now();

/**
 * How often to ask beanfun whether the launcher identity we compile in is still
 * accepted. It changes a few times a year, so daily is generous — the interval
 * exists so the answer is never older than a day, not to catch a fast-moving
 * value.
 */
const IDENTITY_WATCH_MS = 24 * 60 * 60 * 1_000;

/**
 * Watch the one failure that breaks every user at once.
 *
 * `ggmCanary.ts` explains why this is schedulable at all: the check measures
 * whether beanfun still accepts our `CV`/`Hash`, rather than whether some
 * version string somewhere has moved. A version difference is not an outage and
 * a daily report of one is a check nobody reads; a refusal IS the outage.
 *
 * Nothing about it needs a user: no session, no ticket, no OTP produced. Which
 * is the point — a deployment whose users all sit on legacy games sends no v2
 * requests at all, possibly for months, since the game someone picked is
 * persisted and survives restarts. Without this, the first sign would be a
 * confused user with no way to describe what broke.
 *
 * Announced ONCE per outage, not once per tick: a refusal stays true until
 * someone ships a new pair, and re-sending that daily is how a real alert
 * becomes background noise. It re-arms if the status ever leaves `rejected`.
 */
function startIdentityWatch(client: Client): void {
  const ownerId = (process.env.OWNER_DISCORD_ID ?? '').trim();
  let announced = false;

  const tick = async (): Promise<void> => {
    const v = await ggmVerdict();
    const say = { error: console.error, warn: console.warn, info: console.log }[ggmSeverity(v.status)];
    say(`[ggm] ${v.line}`);

    if (v.status !== 'rejected') {
      announced = false;
      return;
    }
    if (announced) return;
    announced = true;

    if (!ownerId) {
      console.error(
        '[ggm] nobody was told: set OWNER_DISCORD_ID to receive this as a DM instead of ' +
          'only in the log, where an unattended host will not surface it.',
      );
      return;
    }
    try {
      const dm = await (await client.users.fetch(ownerId)).createDM();
      await dm.send(
        '🚨 **Beanfun 不再接受這個部署送出的啟動器識別(CV/Hash)**\n' +
          '走 v2 路線的遊戲(例如新楓之谷)現在對**所有使用者**都取不到密碼。\n\n' +
          `\`\`\`\n${v.line}\n\`\`\`\n` +
          '請更新 `src/beanfun/clientIntegrity.ts` 的 `GGM_CV` / `GGM_HASH` 後重新部署。\n' +
          '-# 用 `npm run check:ggm` 確認新的一組是否被接受。',
      );
    } catch (e) {
      // The DM failing must not silence the finding — the log line above already
      // carries it, so just say the delivery failed.
      console.error(`[ggm] could not DM ${ownerId}:`, redactText(e instanceof Error ? e.message : String(e)));
    }
  };

  // Nothing in `tick` is expected to reject — `ggmVerdict` swallows its own
  // failures and the DM is wrapped — but an unhandled rejection from a
  // background timer takes the whole bot down, which is a steep price for a
  // check that exists to be non-critical.
  const safeTick = (): void => void tick().catch((e: unknown) => {
    console.error('[ggm] watch tick failed:', redactText(e instanceof Error ? e.message : String(e)));
  });
  safeTick();
  setInterval(safeTick, IDENTITY_WATCH_MS).unref();
}

export async function createBot(token: string): Promise<Client> {
  const store = createStore();
  const manager = new SessionManager(store);

  const access = createAccess(store);

  if (!isGated(access)) {
    console.warn(
      '[auth] no ACCESS_CODE / ALLOWED_DISCORD_IDS / REQUIRED_GUILD_ID — ANYONE who can ' +
        'reach this bot may use this host to run their own Beanfun login. Set ACCESS_CODE ' +
        'and share it with friends to lock the bot down without forcing a shared server.',
    );
  } else {
    const parts = [
      access.accessCode ? `access code (${access.enrolled.size} enrolled)` : null,
      access.requiredGuildId ? `guild ${access.requiredGuildId}` : null,
      access.allowIds.size ? `${access.allowIds.size} explicit id(s)` : null,
    ].filter(Boolean);
    console.log(`[auth] access gated by ${parts.join(' + ')}`);
    if (access.accessCode && !store) {
      console.warn(
        '[auth] ACCESS_CODE is set but SESSION_ENCRYPTION_KEY is not — enrollment is ' +
          'in-memory only and friends must re-enter the code after a restart.',
      );
    }
  }

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
    partials: [Partials.Channel],
  });

  client.once('clientReady', (c) => {
    console.log(`🤖 logged in as ${c.user.tag}`);
    startPresenceRotation(c, STARTED_AT);
    startIdentityWatch(c);
    if (access.requiredGuildId && !c.guilds.cache.has(access.requiredGuildId)) {
      console.warn(
        `[auth] REQUIRED_GUILD_ID ${access.requiredGuildId} is not a server this bot is in — ` +
          'the guild gate will reject everyone. Invite the bot to that server.',
      );
    }
  });

  client.on('interactionCreate', (interaction: Interaction) => {
    void dispatch(access, manager, interaction).catch((e: unknown) => {
      console.error('interaction error:', redactText(e instanceof Error ? e.message : String(e)));
      // Never leave the user staring at a "⏳ …" placeholder that will never be
      // filled in: a failed flow must surface as a visible (ephemeral) message.
      void notifyFailure(interaction);
    });
  });

  // Tell the user when the keep-alive loop declares their session dead, so
  // they relog on their own schedule instead of hitting a dead session later.
  manager.onSessionExpired = (userId) => notifySessionExpired(client, userId);

  // Restore before login: pings resume immediately, and any expiry notices fire
  // only after the gateway is up (the ping interval is 60s, login takes ms).
  const restored = await manager.restore();
  if (restored > 0) console.log(`♻️  restored ${restored} session(s) from disk`);

  void client.login(token);
  return client;
}

/** Reply with an ephemeral refusal (best-effort). */
async function refuse(interaction: Interaction, content: string): Promise<void> {
  if (!interaction.isRepliable()) return;
  try {
    await interaction.reply({ content, flags: MessageFlags.Ephemeral });
  } catch {
    /* nothing more we can do */
  }
}

/**
 * Last-resort user-facing error for a flow that threw. Uses followUp when the
 * interaction was already answered — that goes through the webhook route, so it
 * lands even in a channel the bot has no access to. Best-effort by design.
 */
async function notifyFailure(interaction: Interaction): Promise<void> {
  if (!interaction.isRepliable()) return;
  const content = '⚠️ 這個操作沒有完成(內部錯誤)。請稍後再試一次,或用 `/login` 重新開始。';
  try {
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }
  } catch {
    /* the interaction token may already be dead; nothing more we can do */
  }
}

async function dispatch(
  access: AccessControl,
  manager: SessionManager,
  interaction: Interaction,
): Promise<void> {
  if (interaction.isChatInputCommand()) {
    switch (interaction.commandName) {
      case 'login': {
        // /login is the enrollment entry point — it handles the access code.
        // The gate decides; saying so is this layer's job (see access.ts).
        const gate = await gateLogin(access, interaction, interaction.options.getString('code'));
        if (!gate.ok) return refuse(interaction, gate.reason);
        return handleLogin(manager, interaction);
      }
      case 'otp':
        if (!(await isAuthorized(access, interaction))) return refuse(interaction, NO_ACCESS);
        return handleQuickOtp(manager, interaction);
      case 'logout':
        if (!(await isAuthorized(access, interaction))) return refuse(interaction, NO_ACCESS);
        return void interaction.reply({
          content: handleLogout(manager, interaction.user.id),
          flags: isBotDm(interaction) ? undefined : MessageFlags.Ephemeral,
        });
      case 'status': {
        if (!(await isAuthorized(access, interaction))) return refuse(interaction, NO_ACCESS);
        const mine = manager.isLoggedIn(interaction.user.id)
          ? '✅ 已登入 (session 持續保活中)。可直接 /login 進入選單。'
          : '尚未登入。執行 /login 開始。';
        // Authorized-only stats (not broadcast in the public presence).
        const stats = `🤖 目前維持 ${manager.activeSessionCount()} 個帳號 session,已運行 ${formatUptime(
          Date.now() - STARTED_AT,
        )}。`;
        return void interaction.reply({
          content: `${mine}\n${stats}`,
          flags: isBotDm(interaction) ? undefined : MessageFlags.Ephemeral,
        });
      }
      case 'clear':
        if (!(await isAuthorized(access, interaction))) return refuse(interaction, NO_ACCESS);
        return handleClear(interaction);
      default:
        return;
    }
  }

  // Components (menus/buttons) only ever follow a successful /login, but gate
  // them too as defense-in-depth.
  if (!(await isAuthorized(access, interaction))) return refuse(interaction, NO_ACCESS);

  if (interaction.isStringSelectMenu()) {
    if (interaction.customId === CID.gameSelect) return handleGameSelect(manager, interaction);
    if (interaction.customId === CID.accountSelect) return handleAccountSelect(manager, interaction);
    return;
  }

  if (interaction.isButton()) {
    if (interaction.customId === CID.loginCancel) return handleLoginCancel(manager, interaction);
    if (interaction.customId === CID.loginRefresh) return handleLoginRefresh(manager, interaction);
    if (interaction.customId === CID.gameAgain) return handleChangeGame(manager, interaction);
    if (interaction.customId === CID.accountAgain) return handleChangeAccount(manager, interaction);
    if (interaction.customId === CID.otpDelete) return handleOtpDelete(interaction);
    if (interaction.customId === CID.clearConfirm) return handleClearConfirm(interaction);
    if (parseOtpRefresh(interaction.customId)) return handleOtpRefresh(manager, interaction);
    return;
  }
}
