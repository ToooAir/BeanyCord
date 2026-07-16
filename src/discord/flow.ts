/**
 * Discord interaction flow for the full happy path:
 *   /login -> QR (DM) -> background poll -> game menu -> account menu -> OTP.
 *
 * Everything user-facing happens inside the user's DM channel so secrets
 * (QR, OTP) stay private by construction. The M0 `beanfun/*` protocol layer is
 * reused verbatim.
 */
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  StringSelectMenuBuilder,
  type BaseMessageOptions,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type DMChannel,
  type Message,
  type StringSelectMenuInteraction,
} from 'discord.js';

import { getAccounts } from '../beanfun/account.js';
import type { BeanfunClient } from '../beanfun/client.js';
import { listGames } from '../beanfun/games.js';
import { finalizeQrLogin } from '../beanfun/login/qrFinalize.js';
import { initQrLogin } from '../beanfun/login/qrInit.js';
import { pollQrLogin } from '../beanfun/login/qrPoll.js';
import { getSessionKey } from '../beanfun/login/sessionKey.js';
import { getOtp } from '../beanfun/otp.js';
import type { ServiceAccount } from '../beanfun/types.js';
import { Cooldown } from '../core/guard.js';
import { safeError } from '../core/redact.js';
import type { SessionManager, UserState } from '../core/sessionManager.js';
import { CID, otpRefreshId, parseOtpRefresh } from './ids.js';

const POLL_INTERVAL_MS = 2_000;
const QR_TTL_MS = 150_000;
/** Beanfun OTPs are valid for 3 minutes — after that the message's OTP block is
 *  redacted in place (the nav buttons stay, so 🔄 regenerates). */
const OTP_TTL_MS = 3 * 60_000;
/** Min interval between OTP fetches per user; a fresh OTP is valid for minutes,
 *  so rapid re-fetches are only ever accidental button spam. */
const OTP_COOLDOWN_MS = 10_000;

const otpCooldown = new Cooldown(OTP_COOLDOWN_MS);

const errText = safeError;

/** A one-button row that restarts a fresh QR login (M3 recovery affordance). */
function reloginRow(label = '🔄 重新登入'): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(CID.loginRefresh).setLabel(label).setStyle(ButtonStyle.Primary),
  );
}

/**
 * Sends the login flow's first message and returns its handle. Two impls:
 *  - `dm.send` (guild /login + the refresh button): a plain DM message.
 *  - `makeReplyDeliver` (DM /login): the message becomes the /login reply, so
 *    the QR replaces the command with no "思考中" placeholder.
 */
type Deliver = (payload: BaseMessageOptions) => Promise<Message>;

/** Writes (and re-writes) the OTP/progress message to whichever target the
 *  caller chose — an edited followUp (account menu) or the button's own message
 *  edited in place (refresh). Returns the written message so it can be tracked. */
type OtpWriter = (payload: BaseMessageOptions) => Promise<Message>;

/** Defer ~400ms before Discord's 3s ack deadline only if the first message
 *  isn't ready yet, so a slow QR build can't kill the interaction. The fast
 *  path replies directly — no "思考中". */
function makeReplyDeliver(interaction: ChatInputCommandInteraction): Deliver {
  let deferring: Promise<unknown> | null = null;
  const timer = setTimeout(() => {
    deferring = interaction.deferReply();
  }, 2600);
  return async (payload) => {
    clearTimeout(timer);
    if (deferring) {
      await deferring;
      await interaction.editReply(payload);
    } else {
      await interaction.reply(payload);
    }
    return interaction.fetchReply();
  };
}

// ---- /login ----------------------------------------------------------------

export async function handleLogin(
  manager: SessionManager,
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const userId = interaction.user.id;
  // Only a 1:1 DM with the bot is private enough to host the QR inline. A guild
  // channel OR a *group* DM (possible with user-install) would expose the QR to
  // others, so for those we deliver everything to the user's 1:1 DM instead.
  const isPrivateDm = !interaction.inGuild() && interaction.channel?.type === ChannelType.DM;

  let dm: DMChannel;
  try {
    dm = await interaction.user.createDM();
  } catch {
    await interaction.reply({
      content: '我無法私訊你 — 請開啟「允許伺服器成員私訊」後再試。',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!isPrivateDm) {
    // Guild or group DM: point the user to their 1:1 DM and deliver there, so
    // the QR / OTP never land in a channel others can read.
    await interaction.reply({
      content: '已在你的私訊開始登入流程,請查看 DM。',
      flags: MessageFlags.Ephemeral,
    });
    await manager.withLock(userId, () => beginLogin(manager, userId, dm, (p) => dm.send(p)));
    return;
  }

  // In a 1:1 DM, deliver the first message AS the /login reply so the QR / menu
  // replaces the command (no "思考中" — see makeReplyDeliver).
  await manager.withLock(userId, () =>
    beginLogin(manager, userId, dm, makeReplyDeliver(interaction)),
  );
}

/** Logged-in → game menu (recovering if the resumed session is dead); else a
 *  fresh QR. The first message goes through `deliver`. Caller holds the lock. */
async function beginLogin(
  manager: SessionManager,
  userId: string,
  dm: DMChannel,
  deliver: Deliver,
): Promise<void> {
  if (manager.isLoggedIn(userId)) {
    try {
      const games = await listGames(manager.get(userId)!.client);
      const m = await deliver(buildGameMenuPayload(games, '你已登入。請選擇遊戲:'));
      await setActive(userId, m, 'menu'); // retires any prior menu/OTP
    } catch (e) {
      const m = await deliver({
        content: `⚠️ 你的登入似乎已失效(${errText(e)})。請重新登入:`,
        components: [reloginRow()],
      });
      await setActive(userId, m, 'menu');
    }
    return;
  }
  await sendFreshQr(manager, userId, dm, deliver);
}

/** Reset the client and drive a fresh QR challenge. The QR message goes through
 *  `deliver`; subsequent poll edits + the game menu use `dm`. Caller holds the
 *  lock. */
async function sendFreshQr(
  manager: SessionManager,
  userId: string,
  dm: DMChannel,
  deliver: Deliver,
): Promise<void> {
  const state = manager.resetClient(userId);
  try {
    const skey = await getSessionKey(state.client);
    const init = await initQrLogin(state.client, skey);
    state.pendingInit = init;

    const msg = await deliver(buildQrPayload(init.bitmapBase64, init.deeplink));
    await setActive(userId, msg, 'menu'); // retires any prior menu/OTP
    startQrPolling(manager, userId, dm, msg);
  } catch (e) {
    const m = await deliver({ content: `❌ 啟動登入失敗:${errText(e)}`, components: [reloginRow()] });
    await setActive(userId, m, 'menu');
    manager.remove(userId);
  }
}

/** "🔄 重新登入" / "重新產生 QR" button — restart the login flow in the DM. */
export async function handleLoginRefresh(
  manager: SessionManager,
  interaction: ButtonInteraction,
): Promise<void> {
  await interaction.deferUpdate();
  const userId = interaction.user.id;
  const dm = await interaction.user.createDM();
  await manager.withLock(userId, async () => {
    // Neutralise the button on the old message so it can't be re-tapped.
    await safeEdit(interaction.message as Message, '🔄 正在重新產生 QR…', []);
    await sendFreshQr(manager, userId, dm, (p) => dm.send(p));
  });
}

function buildQrPayload(bitmapBase64: string, deeplink: string | null): BaseMessageOptions {
  const b64 = bitmapBase64.replace(/^data:image\/png;base64,/, '');
  const file = new AttachmentBuilder(Buffer.from(b64, 'base64'), { name: 'qr.png' });
  const embed = new EmbedBuilder()
    .setTitle('Beanfun QR 登入')
    .setDescription('用 Beanfun App 掃描下方 QR 碼 (約 2 分鐘內有效)。')
    .setImage('attachment://qr.png');
  if (deeplink) embed.addFields({ name: ' 或開啟 deeplink', value: deeplink.slice(0, 1024) });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(CID.loginCancel).setLabel('取消').setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], files: [file], components: [row] };
}

function startQrPolling(
  manager: SessionManager,
  userId: string,
  dm: DMChannel,
  qrMessage: Message,
): void {
  const deadline = Date.now() + QR_TTL_MS;

  const tick = async (): Promise<void> => {
    const state = manager.get(userId);
    if (!state || !state.pendingInit) return; // cancelled / logged out

    if (Date.now() > deadline) {
      manager.clearPoll(userId);
      state.pendingInit = undefined;
      await safeEdit(qrMessage, '⏱️ QR 已逾時。', [reloginRow('🔄 重新產生 QR')]);
      return;
    }

    try {
      const outcome = await pollQrLogin(state.client, state.pendingInit);
      if (outcome === 'TokenExpired') {
        manager.clearPoll(userId);
        state.pendingInit = undefined;
        await safeEdit(qrMessage, '🔄 QR 已過期。', [reloginRow('🔄 重新產生 QR')]);
        return;
      }
      if (outcome === 'Approved') {
        manager.clearPoll(userId);
        const init = state.pendingInit;
        state.pendingInit = undefined;
        const session = await finalizeQrLogin(state.client, init);
        state.session = session;
        await manager.persist(userId); // encrypt + store + start 60s keep-alive
        await safeEdit(qrMessage, '✅ 登入成功!', []);
        await sendGameMenu(userId, state.client, dm, '請選擇遊戲:');
        return;
      }
      // WaitLogin / Failed -> schedule next tick
      state.pollTimer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
    } catch (e) {
      manager.clearPoll(userId);
      state.pendingInit = undefined;
      await safeEdit(qrMessage, `❌ 登入輪詢失敗:${errText(e)}`, [reloginRow('🔄 重新產生 QR')]);
    }
  };

  const state = manager.get(userId);
  if (state) state.pollTimer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
}

// ---- game menu -------------------------------------------------------------

function buildGameMenuPayload(
  games: Awaited<ReturnType<typeof listGames>>,
  prompt: string,
): BaseMessageOptions {
  const options = games.services.slice(0, 25).map((g) => ({
    label: g.name.slice(0, 100),
    description: `${g.serviceCode}_${g.serviceRegion}`.slice(0, 100),
    value: `${g.serviceCode}_${g.serviceRegion}`,
  }));
  const menu = new StringSelectMenuBuilder()
    .setCustomId(CID.gameSelect)
    .setPlaceholder('選擇遊戲')
    .addOptions(options);
  return {
    content: prompt,
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
  };
}

/** Fetch games and post the menu to the DM (used after QR approval). */
async function sendGameMenu(
  userId: string,
  client: BeanfunClient,
  dm: DMChannel,
  prompt: string,
): Promise<void> {
  const games = await listGames(client);
  const m = await dm.send(buildGameMenuPayload(games, prompt));
  await setActive(userId, m, 'menu'); // retires the QR / "登入成功" breadcrumb
}

export async function handleGameSelect(
  manager: SessionManager,
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  const userId = interaction.user.id;
  await interaction.deferUpdate();
  // Post follow-up messages via dm.send (plain) rather than interaction.followUp:
  // a component followUp renders as a *reply* to the interaction's source message,
  // which we delete on the next step -> "original message deleted". A plain send
  // carries no such reference.
  const dm = await interaction.user.createDM();
  await manager.withLock(userId, async () => {
    const state = manager.get(userId);
    if (!state?.session) {
      await dm.send({ content: '你的登入已失效,請重新登入:', components: [reloginRow()] });
      return;
    }
    const value = interaction.values[0] ?? '';
    // Keep the chosen game's display name so the loading + account-pick messages
    // stay self-explanatory when the user scrolls back later.
    const gameName = interaction.component.options.find((o) => o.value === value)?.label ?? value;
    const sep = value.lastIndexOf('_');
    const serviceCode = value.slice(0, sep);
    const serviceRegion = value.slice(sep + 1);
    state.session.serviceCode = serviceCode;
    state.session.serviceRegion = serviceRegion;
    state.session.serviceName = gameName; // persisted so OTP messages can show it
    await manager.persist(userId); // re-save selected game + any rotated cookies

    try {
      await interaction.editReply({ content: `🎮 已選擇 **${gameName}**,載入帳號中…`, components: [] });
      // amountLimitNotice (e.g. "此遊戲最多允許新增帳號數:1") is dropped on purpose:
      // this bot has no add-account feature, so it's just confusing noise.
      const { accounts } = await getAccounts(
        state.client,
        state.session,
        serviceCode,
        serviceRegion,
      );
      state.accounts = accounts;
      if (accounts.length === 0) {
        await dm.send({ content: `**${gameName}** 沒有任何服務帳號。` });
        return;
      }
      const accMsg = await dm.send(
        buildAccountMenuPayload(accounts, `🎮 **${gameName}**\n請選擇帳號:`),
      );
      await setActive(userId, accMsg, 'menu'); // deletes the "載入中" game-menu msg
    } catch (e) {
      await dm.send({
        content: `❌ 載入帳號失敗:${errText(e)}\n若持續失敗,可能是登入已失效,請重新登入:`,
        components: [reloginRow()],
      });
    }
  });
}

function buildAccountMenuPayload(accounts: ServiceAccount[], prompt: string): BaseMessageOptions {
  const options = accounts.slice(0, 25).map((a) => ({
    label: a.sname.slice(0, 100),
    description: `ssn=${a.ssn}`.slice(0, 100),
    value: a.sid,
  }));
  const menu = new StringSelectMenuBuilder()
    .setCustomId(CID.accountSelect)
    .setPlaceholder('選擇帳號')
    .addOptions(options);
  return {
    content: prompt,
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
  };
}

// ---- account select -> OTP -------------------------------------------------

export async function handleAccountSelect(
  manager: SessionManager,
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  await interaction.deferUpdate();
  const sid = interaction.values[0] ?? '';
  // One-shot: turn THIS account-menu message into the OTP (drop the menu so it
  // can't linger and go stale). Re-navigation is via the OTP message's buttons.
  await interaction.editReply({ content: '⏳ 正在產生 OTP…', components: [] });
  await deliverOtp(manager, interaction.user.id, sid, (p) => interaction.editReply(p));
}

export async function handleOtpRefresh(
  manager: SessionManager,
  interaction: ButtonInteraction,
): Promise<void> {
  const sid = parseOtpRefresh(interaction.customId) ?? '';
  // Immediate in-place feedback (also acks): replace the OTP message with a
  // spinner and drop the button so it can't be double-tapped; then edit the
  // same message into the fresh OTP.
  await interaction.update({ content: '⏳ 正在產生新的 OTP…', components: [] });
  await deliverOtp(manager, interaction.user.id, sid, (p) => interaction.editReply(p));
}

/** "🎮 換遊戲" on the OTP message — re-open the game menu, no /login needed.
 *  Consumes the OTP message's buttons so only one control surface stays live. */
export async function handleChangeGame(
  manager: SessionManager,
  interaction: ButtonInteraction,
): Promise<void> {
  await interaction.deferUpdate();
  const userId = interaction.user.id;
  const dm = await interaction.user.createDM(); // plain send — no reply reference
  await manager.withLock(userId, async () => {
    const state = manager.get(userId);
    if (!state?.session) {
      await dm.send({ content: '你的登入已失效,請重新登入:', components: [reloginRow()] });
      return;
    }
    await safeStripButtons(interaction.message as Message);
    try {
      const games = await listGames(state.client);
      const m = await dm.send(buildGameMenuPayload(games, '請選擇遊戲:'));
      await setActive(userId, m, 'menu');
    } catch (e) {
      await dm.send({
        content: `⚠️ 載入遊戲清單失敗(${errText(e)})。請重新登入:`,
        components: [reloginRow()],
      });
    }
  });
}

/** "👤 換帳號" on the OTP message — re-open the account menu for the current
 *  game, no /login needed. Consumes the OTP message's buttons. */
export async function handleChangeAccount(
  manager: SessionManager,
  interaction: ButtonInteraction,
): Promise<void> {
  await interaction.deferUpdate();
  const userId = interaction.user.id;
  const dm = await interaction.user.createDM(); // plain send — no reply reference
  await manager.withLock(userId, async () => {
    const state = manager.get(userId);
    if (!state?.session?.serviceCode) {
      await dm.send({
        content: '你的登入已失效或尚未選擇遊戲,請重新登入:',
        components: [reloginRow()],
      });
      return;
    }
    await safeStripButtons(interaction.message as Message);
    const game = state.session.serviceName ?? '此遊戲';
    try {
      const { accounts } = await getAccounts(
        state.client,
        state.session,
        state.session.serviceCode,
        state.session.serviceRegion,
      );
      state.accounts = accounts;
      if (accounts.length === 0) {
        await dm.send({ content: `**${game}** 沒有任何服務帳號。` });
        return;
      }
      const m = await dm.send(buildAccountMenuPayload(accounts, `🎮 **${game}**\n請選擇帳號:`));
      await setActive(userId, m, 'menu');
    } catch (e) {
      await dm.send({
        content: `❌ 載入帳號失敗:${errText(e)}\n請重新登入:`,
        components: [reloginRow()],
      });
    }
  });
}

/** "🗑 刪除" on the OTP message — users can't delete a bot's DM message, so the
 *  bot deletes its own. ack first to avoid a "interaction failed" flash. */
export async function handleOtpDelete(interaction: ButtonInteraction): Promise<void> {
  try {
    await interaction.deferUpdate();
  } catch {
    /* ignore */
  }
  try {
    await interaction.message.delete();
  } catch {
    /* already gone; nothing to do */
  }
}

async function deliverOtp(
  manager: SessionManager,
  userId: string,
  sid: string,
  write: OtpWriter,
): Promise<void> {
  await manager.withLock(userId, async () => {
    const state = manager.get(userId);
    if (!state?.session) {
      await write({ content: '你的登入已失效,請重新登入:', components: [reloginRow()] });
      return;
    }
    // Fetch cooldown: a fresh OTP is valid for minutes, so a re-fetch within
    // seconds is button spam — bounce it before touching the network.
    const wait = otpCooldown.remaining(userId);
    if (wait > 0) {
      const m = await write({
        content: `⏳ 才剛產生過 OTP,請 ${Math.ceil(wait / 1000)} 秒後再按 🔄。`,
        components: [otpNavRow(sid)],
      });
      // Keep the single-control-surface invariant: this bounce message carries
      // live buttons, so it must retire any previous OTP message's buttons.
      await setActive(userId, m, 'otp');
      return;
    }
    try {
      const account = await resolveAccount(state, sid);
      if (!account) {
        await write({
          content: '找不到該帳號(遊戲帳號可能已變更)。請重新登入後重新選擇遊戲:',
          components: [reloginRow()],
        });
        return;
      }
      const otp = await getOtp(
        state.client,
        state.session,
        account,
        state.session.serviceCode,
        state.session.serviceRegion,
      );
      otpCooldown.touch(userId);
      // Remember the account so `/otp` can skip the menus next time.
      state.session.lastSid = account.sid;
      const gameLabel = state.session.serviceName ? `🎮 ${state.session.serviceName}\n` : '';
      const header =
        gameLabel +
        `🔑 **${account.sname}** 的登入資訊\n` +
        `帳號:\n\`\`\`\n${account.sid}\n\`\`\`\n`;
      // Discord renders <t:…:T> as local time and <t:…:R> as a live-updating
      // relative time, so the message always shows when this OTP was generated.
      const issuedAt = Math.floor(Date.now() / 1000);
      const issuedLine = `-# 🕐 產生於 <t:${issuedAt}:T>(<t:${issuedAt}:R>)\n`;
      const otpMsg = await write({
        content:
          header +
          `OTP:\n\`\`\`\n${otp}\n\`\`\`\n` +
          issuedLine +
          `-# ⚠️ OTP 有效 3 分鐘,到期會自動遮蔽;請勿外流,用完可按 🗑 刪除本訊息。`,
        components: [otpNavRow(account.sid)],
      });
      await setActive(userId, otpMsg, 'otp'); // same message id -> just flips kind
      scheduleOtpExpiry(
        userId,
        otpMsg,
        header +
          `OTP:\n~~已失效(有效期 3 分鐘)~~\n` +
          issuedLine +
          `-# 需要新的 OTP 請按 🔄。`,
      );
      // Active use refreshes the stored session: persist the cookies rotated
      // during getOtp and bump updated_at so SESSION_MAX_AGE_DAYS behaves as an
      // idle timeout (only abandoned sessions expire). Best-effort — a persist
      // failure must not turn an already-delivered OTP into an error.
      await manager.persist(userId).catch(() => undefined);
    } catch (e) {
      await write({
        content: `❌ 取得 OTP 失敗:${errText(e)}\n若持續失敗,可能是登入已失效,請重新登入:`,
        components: [reloginRow()],
      });
    }
  });
}

/** The OTP message's nav row: refresh / switch account / switch game / delete. */
function otpNavRow(sid: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(otpRefreshId(sid))
      .setLabel('🔄 重新產生 OTP')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(CID.accountAgain)
      .setLabel('👤 換帳號')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(CID.gameAgain)
      .setLabel('🎮 換遊戲')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(CID.otpDelete)
      .setLabel('🗑 刪除')
      .setStyle(ButtonStyle.Danger),
  );
}

// The OTP itself expires server-side after 3 minutes, but the DM message would
// otherwise keep the (dead) code in history forever. Redact it in place when it
// expires; keep the buttons so 🔄 still regenerates. One timer per user — a
// refresh reuses the same message, so the previous timer is superseded.
const otpExpireTimers = new Map<string, NodeJS.Timeout>();

function scheduleOtpExpiry(userId: string, msg: Message, redactedContent: string): void {
  const prev = otpExpireTimers.get(userId);
  if (prev) clearTimeout(prev);
  const t = setTimeout(() => {
    otpExpireTimers.delete(userId);
    // Message may have been deleted (🗑 / /clear) — best effort.
    void msg.edit({ content: redactedContent }).catch(() => undefined);
  }, OTP_TTL_MS);
  otpExpireTimers.set(userId, t);
}

/**
 * Find the account for `sid`. After a restart the in-memory account list is
 * gone (it isn't persisted — only the session + cookies are), so the OTP-refresh
 * button would otherwise fail. Re-fetch the list for the session's last-selected
 * game and cache it. Throws if the re-fetch fails (e.g. expired session) so the
 * caller can route to re-login.
 */
async function resolveAccount(state: UserState, sid: string): Promise<ServiceAccount | undefined> {
  const cached = state.accounts?.find((a) => a.sid === sid);
  if (cached) return cached;

  const session = state.session;
  if (!session?.serviceCode || !session.serviceRegion) return undefined;

  const { accounts } = await getAccounts(
    state.client,
    session,
    session.serviceCode,
    session.serviceRegion,
  );
  state.accounts = accounts;
  return accounts.find((a) => a.sid === sid);
}

// ---- /otp (quick re-fetch) ---------------------------------------------------

/**
 * `/otp` — one-shot OTP for the last game + account this user picked, skipping
 * the menus. Falls back to guidance when there's no session or no remembered
 * pick. Secrets still only land in the 1:1 DM (same rule as /login).
 */
export async function handleQuickOtp(
  manager: SessionManager,
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const userId = interaction.user.id;
  const isPrivateDm = !interaction.inGuild() && interaction.channel?.type === ChannelType.DM;

  let dm: DMChannel;
  try {
    dm = await interaction.user.createDM();
  } catch {
    await interaction.reply({
      content: '我無法私訊你 — 請開啟「允許伺服器成員私訊」後再試。',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  let deliver: Deliver;
  if (!isPrivateDm) {
    await interaction.reply({ content: '已在你的私訊處理,請查看 DM。', flags: MessageFlags.Ephemeral });
    deliver = (p) => dm.send(p);
  } else {
    deliver = makeReplyDeliver(interaction);
  }

  const state = manager.get(userId);
  if (!state?.session) {
    const m = await deliver({ content: '你尚未登入。請先登入:', components: [reloginRow()] });
    await setActive(userId, m, 'menu');
    return;
  }
  const sid = state.session.lastSid;
  if (!sid || !state.session.serviceCode) {
    const m = await deliver({
      content: 'ℹ️ 還不知道要拿哪個帳號的 OTP — 先用 `/login` 選一次遊戲和帳號,之後 `/otp` 就能一鍵取得。',
    });
    await setActive(userId, m, 'menu');
    return;
  }
  const msg = await deliver({ content: '⏳ 正在產生 OTP…' });
  await deliverOtp(manager, userId, sid, async (p) => msg.edit(p));
}

// ---- session-expired notice --------------------------------------------------

/**
 * Proactive DM when the keep-alive loop declares a session dead (wired to
 * `SessionManager.onSessionExpired`), so the user relogs on their own schedule
 * instead of discovering the dead session at the next OTP attempt.
 */
export async function notifySessionExpired(client: Client, userId: string): Promise<void> {
  const user = await client.users.fetch(userId);
  const dm = await user.createDM();
  const m = await dm.send({
    content: '⚠️ 你的 Beanfun 登入已失效(保活偵測到連線中斷)。需要時請重新登入:',
    components: [reloginRow()],
  });
  await setActive(userId, m, 'menu');
}

// ---- /logout, login cancel -------------------------------------------------

export function handleLogout(manager: SessionManager, userId: string): string {
  if (!manager.get(userId)) return '你目前沒有登入。';
  manager.remove(userId);
  clearActive(userId); // drop the tracked handle; old buttons fail closed anyway
  return '已登出並清除本機 session。';
}

export async function handleLoginCancel(
  manager: SessionManager,
  interaction: ButtonInteraction,
): Promise<void> {
  await interaction.deferUpdate();
  manager.remove(interaction.user.id);
  clearActive(interaction.user.id);
  await safeEdit(interaction.message as Message, '已取消登入。', []);
}

// ---- /clear ----------------------------------------------------------------

/** `/clear` — ask to confirm before wiping the bot's DM messages. */
export async function handleClear(interaction: ChatInputCommandInteraction): Promise<void> {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(CID.clearConfirm).setLabel('🗑 確認刪除').setStyle(ButtonStyle.Danger),
  );
  await interaction.reply({
    content:
      '這會刪除我在你私訊裡發過的**所有**訊息(OTP、選單、QR 等)。\n' +
      '你自己打的訊息我無法刪除,且此操作**無法復原**。要繼續嗎?',
    components: [row],
    flags: MessageFlags.Ephemeral,
  });
}

/** Confirm button — page through the DM and delete every bot-authored message. */
export async function handleClearConfirm(interaction: ButtonInteraction): Promise<void> {
  await interaction.update({ content: '🧹 清除中…', components: [] });
  const userId = interaction.user.id;
  const botId = interaction.client.user.id;

  let dm: DMChannel;
  try {
    dm = await interaction.user.createDM();
  } catch {
    await interaction.editReply({ content: '❌ 無法存取你的私訊。' }).catch(() => undefined);
    return;
  }

  clearActive(userId); // the tracked message is about to be deleted anyway

  // DMs can't bulkDelete, so delete one-by-one (no age limit; discord.js queues
  // around the rate limit). Skip this interaction's own (ephemeral) message.
  let deleted = 0;
  let before: string | undefined;
  for (;;) {
    const batch = await dm.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    if (batch.size === 0) break;
    before = batch.last()?.id;
    for (const m of batch.values()) {
      if (m.author.id !== botId || m.id === interaction.message.id) continue;
      try {
        await m.delete();
        deleted += 1;
        if (deleted % 20 === 0) {
          await interaction.editReply({ content: `🧹 清除中… 已刪除 ${deleted} 則` }).catch(() => undefined);
        }
      } catch {
        /* individual failure (already gone / too old): skip */
      }
    }
    if (batch.size < 100) break;
  }

  await interaction
    .editReply({ content: `✅ 已刪除 ${deleted} 則我發過的訊息。` })
    .catch(() => undefined);
}

// ---- helpers ---------------------------------------------------------------

async function safeEdit(
  msg: Message,
  content: string,
  components: ActionRowBuilder<ButtonBuilder>[] = [],
): Promise<void> {
  try {
    await msg.edit({ content, embeds: [], files: [], components });
  } catch {
    /* message may be gone; ignore */
  }
}

/** Drop a message's buttons (best-effort), keeping its content — used to retire
 *  the OTP message's nav buttons when the user navigates away. */
async function safeStripButtons(msg: Message): Promise<void> {
  try {
    await msg.edit({ components: [] });
  } catch {
    /* message may be gone; ignore */
  }
}

/** Delete a message (best-effort). */
async function safeDelete(msg: Message): Promise<void> {
  try {
    await msg.delete();
  } catch {
    /* already gone; ignore */
  }
}

// ---- single active control surface per user --------------------------------
// Each user has at most one live menu/OTP message. Posting a new one retires the
// previous: menus (and transient "載入中"/"登入成功" breadcrumbs) are deleted; an
// OTP message just has its buttons stripped so its value is kept. The message-id
// guard means an in-place edit (account menu -> OTP, same message) doesn't retire
// itself. In-memory only (handles can't survive a restart).
type ActiveKind = 'menu' | 'otp';
const activeByUser = new Map<string, { message: Message; kind: ActiveKind }>();

async function setActive(userId: string, message: Message, kind: ActiveKind): Promise<void> {
  const prev = activeByUser.get(userId);
  if (prev && prev.message.id !== message.id) {
    if (prev.kind === 'menu') await safeDelete(prev.message);
    else await safeStripButtons(prev.message);
  }
  activeByUser.set(userId, { message, kind });
}

function clearActive(userId: string): void {
  activeByUser.delete(userId);
}
