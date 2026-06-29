/**
 * Discord client wiring + interaction dispatch. The actual flow logic lives
 * in `flow.ts`; this file just routes interactions to it.
 */
import { timingSafeEqual } from 'node:crypto';

import {
  Client,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  type ChatInputCommandInteraction,
  type Guild,
  type Interaction,
} from 'discord.js';

import { redactText } from '../core/redact.js';
import { SessionManager } from '../core/sessionManager.js';
import { createStore, type SessionStore } from '../core/store.js';
import {
  handleAccountSelect,
  handleChangeAccount,
  handleChangeGame,
  handleGameSelect,
  handleLogin,
  handleLoginCancel,
  handleLoginRefresh,
  handleLogout,
  handleOtpRefresh,
} from './flow.js';
import { CID, parseOtpRefresh } from './ids.js';
import { formatUptime, startPresenceRotation } from './presence.js';

/** Process start, for uptime in the presence rotation and /status. */
const STARTED_AT = Date.now();

/**
 * Access control. The gate exists only to stop strangers using *this host* to
 * run their own Beanfun logins (cross-user OTP theft is already impossible — see
 * README). It is DM-first: it must NOT force everyone into a shared server,
 * because the whole point of user-install / DM usage is to skip that.
 *
 * A user is authorized if ANY of these holds:
 *  - `ACCESS_CODE` (primary for DM): they redeemed the shared invite code once
 *    via `/login code:<碼>`. We then persist their Discord ID (enrollment), so
 *    they never re-enter it. Adding a friend = handing them the code once.
 *  - `ALLOWED_DISCORD_IDS` (optional): a static allow set.
 *  - `REQUIRED_GUILD_ID` (optional): members of that guild auto-pass (for users
 *    who DO share a server). Checked live with a short positive cache.
 *  - If NONE of the three is configured → open to anyone (logged at startup).
 *
 * Enrollment persists in the SessionStore when present; otherwise it lives only
 * in memory (lost on restart — warned at startup).
 */
interface AccessControl {
  allowIds: Set<string>;
  requiredGuildId: string;
  accessCode: string;
  /** Authorized-once user IDs (loaded from the store + grown via /login code). */
  enrolled: Set<string>;
  store: SessionStore | null;
  /** userId → expiry(ms) positive-membership cache, to avoid a fetch per click. */
  memberCache: Map<string, number>;
}

const MEMBER_CACHE_MS = 5 * 60_000;

function parseAllowlist(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? '')
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter((s) => /^\d+$/.test(s)),
  );
}

/** Constant-time string compare (avoids leaking the code length/prefix by timing). */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export async function createBot(token: string): Promise<Client> {
  const store = createStore();
  const manager = new SessionManager(store);
  const restored = await manager.restore();
  if (restored > 0) console.log(`♻️  restored ${restored} session(s) from disk`);

  const access: AccessControl = {
    allowIds: parseAllowlist(process.env.ALLOWED_DISCORD_IDS),
    requiredGuildId: (process.env.REQUIRED_GUILD_ID ?? '').trim(),
    accessCode: (process.env.ACCESS_CODE ?? '').trim(),
    enrolled: new Set(store?.loadEnrolledIds() ?? []),
    store,
    memberCache: new Map(),
  };

  const gated = access.accessCode || access.allowIds.size > 0 || access.requiredGuildId;
  if (!gated) {
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
    });
  });

  void client.login(token);
  return client;
}

/** Already-authorized? (No code redemption here — that's /login-only.) */
async function isAuthorized(access: AccessControl, interaction: Interaction): Promise<boolean> {
  const gated = access.accessCode || access.allowIds.size > 0 || access.requiredGuildId;
  if (!gated) return true; // open
  const userId = interaction.user.id;
  if (access.enrolled.has(userId)) return true;
  if (access.allowIds.has(userId)) return true;
  if (access.requiredGuildId && (await isGuildMember(interaction, access))) return true;
  return false;
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
 * Gate `/login`: if already authorized, proceed. Otherwise, if an ACCESS_CODE is
 * configured, accept a correct `code` option (and enroll the user) — else point
 * them at how to get in. Returns true if the caller should run the login flow.
 */
async function gateLogin(
  access: AccessControl,
  interaction: ChatInputCommandInteraction,
): Promise<boolean> {
  if (await isAuthorized(access, interaction)) return true;

  if (access.accessCode) {
    const supplied = interaction.options.getString('code')?.trim() ?? '';
    if (supplied && safeEqual(supplied, access.accessCode)) {
      access.enrolled.add(interaction.user.id);
      access.store?.enroll(interaction.user.id);
      return true;
    }
    await refuse(
      interaction,
      supplied
        ? '存取碼錯誤。請向管理者確認後再試:`/login code:<存取碼>`。'
        : '這個 bot 需要存取碼。請用 `/login code:<存取碼>` 提供(只需第一次)。',
    );
    return false;
  }

  await refuse(interaction, '你沒有權限使用這個 bot。請聯絡管理者取得存取權。');
  return false;
}

/** Is the interacting user a member of `requiredGuildId`? A single member fetch
 *  by ID needs the bot to be in the guild but NOT the privileged Members intent.
 *  Positive results are cached briefly so button spam doesn't fetch every time. */
async function isGuildMember(interaction: Interaction, access: AccessControl): Promise<boolean> {
  const userId = interaction.user.id;
  const hit = access.memberCache.get(userId);
  if (hit && hit > Date.now()) return true;

  try {
    const guild: Guild =
      interaction.client.guilds.cache.get(access.requiredGuildId) ??
      (await interaction.client.guilds.fetch(access.requiredGuildId));
    await guild.members.fetch(userId); // throws if the user isn't a member
    access.memberCache.set(userId, Date.now() + MEMBER_CACHE_MS);
    return true;
  } catch {
    access.memberCache.delete(userId);
    return false;
  }
}

async function dispatch(
  access: AccessControl,
  manager: SessionManager,
  interaction: Interaction,
): Promise<void> {
  if (interaction.isChatInputCommand()) {
    switch (interaction.commandName) {
      case 'login':
        // /login is the enrollment entry point — it handles the access code.
        if (!(await gateLogin(access, interaction))) return;
        return handleLogin(manager, interaction);
      case 'logout':
        if (!(await isAuthorized(access, interaction))) return refuse(interaction, NO_ACCESS);
        return void interaction.reply({
          content: handleLogout(manager, interaction.user.id),
          flags: interaction.inGuild() ? MessageFlags.Ephemeral : undefined,
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
          flags: interaction.inGuild() ? MessageFlags.Ephemeral : undefined,
        });
      }
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
    if (parseOtpRefresh(interaction.customId)) return handleOtpRefresh(manager, interaction);
    return;
  }
}

const NO_ACCESS = '你沒有權限使用這個 bot。請先用 `/login code:<存取碼>` 取得存取權。';
