/**
 * Who may use this host.
 *
 * The gate exists only to stop strangers using *this machine* to run their own
 * Beanfun logins — cross-user OTP theft is already impossible (see README), so
 * what is being protected is the host's IP budget and its bandwidth, not other
 * users' accounts. It is DM-first: it must NOT force everyone into a shared
 * server, because skipping that is the whole point of user-install / DM usage.
 *
 * A user is authorized if ANY of these holds:
 *  - `ACCESS_CODE` (primary for DM): they redeemed the shared invite code once
 *    via `/login code:<碼>`. Their Discord ID is then persisted (enrollment), so
 *    they never re-enter it. Adding a friend = handing them the code once.
 *  - `ALLOWED_DISCORD_IDS` (optional): a static allow set.
 *  - `REQUIRED_GUILD_ID` (optional): members of that guild auto-pass (for users
 *    who DO share a server). Checked live with a short positive cache.
 *  - If NONE of the three is configured → open to anyone (logged at startup).
 *
 * Split out of `bot.ts` because it is the one security boundary in this repo and
 * it was completely untestable in there: everything was module-private behind
 * `createBot`, so the only way to reach it was to construct a Discord client.
 * Two things follow from that split, and both are deliberate:
 *
 *  - **The decision does not reply.** `gateLogin` returns a reason; the caller
 *    turns it into an ephemeral message. Refusing and explaining are different
 *    jobs, and welding them together is what made the decision unreachable.
 *  - **The lockout belongs to the AccessControl, not to the module.** It used to
 *    be a file-level singleton, i.e. invisible shared state — one process has
 *    exactly one of these, so nothing changes at runtime, but a caller can now
 *    see what it owns.
 */
import { timingSafeEqual } from 'node:crypto';

import type { BaseInteraction, Guild } from 'discord.js';

import { FailureLockout } from '../core/guard.js';
import type { SessionStore } from '../core/store.js';

/** Positive membership is cached this long, so button spam doesn't refetch. */
const MEMBER_CACHE_MS = 5 * 60_000;

/**
 * Online brute-force guard for the shared ACCESS_CODE. The constant-time compare
 * removes the timing oracle; this removes unlimited guessing: 3 free misses per
 * user, then 1 min lock doubling per further miss, capped at 1 h. In-memory —
 * a restart resets it, which is fine for slowing an online attacker down.
 *
 * Exported so the tests drive the boundary from the shipped numbers instead of
 * restating them — a suite that hardcodes `3` goes on asserting a tolerance the
 * module no longer has.
 */
export const LOCKOUT_OPTIONS = { freeAttempts: 3, baseLockMs: 60_000, maxLockMs: 3_600_000 };

export interface AccessControl {
  allowIds: Set<string>;
  requiredGuildId: string;
  accessCode: string;
  /** Authorized-once user IDs (loaded from the store + grown via /login code). */
  enrolled: Set<string>;
  store: SessionStore | null;
  /** userId → expiry(ms) positive-membership cache, to avoid a fetch per click. */
  memberCache: Map<string, number>;
  /** Wrong-guess lockout for the shared code. */
  lockout: FailureLockout;
  /** Injectable clock, so the lockout can be tested without fake timers —
   *  same seam `core/guard.ts` already offers for the same reason. */
  now: () => number;
}

/** Build the access config from the environment. */
export function createAccess(
  store: SessionStore | null,
  env: NodeJS.ProcessEnv = process.env,
  now: () => number = Date.now,
): AccessControl {
  return {
    allowIds: parseAllowlist(env.ALLOWED_DISCORD_IDS),
    requiredGuildId: (env.REQUIRED_GUILD_ID ?? '').trim(),
    accessCode: (env.ACCESS_CODE ?? '').trim(),
    enrolled: new Set(store?.loadEnrolledIds() ?? []),
    store,
    memberCache: new Map(),
    lockout: new FailureLockout(LOCKOUT_OPTIONS, now),
    now,
  };
}

/**
 * Discord snowflakes only. Anything non-numeric is dropped rather than kept as
 * a never-matching entry, so a typo cannot silently look like a configured
 * allow-list — an empty result makes the deployment fall back to whatever else
 * is configured, and the startup line reports the count it actually parsed.
 */
export function parseAllowlist(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? '')
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter((s) => /^\d+$/.test(s)),
  );
}

/** Is any gate configured at all? If not, the bot is open to anyone. */
export function isGated(access: AccessControl): boolean {
  return Boolean(access.accessCode || access.allowIds.size > 0 || access.requiredGuildId);
}

/**
 * Constant-time compare of the code's CONTENT — no prefix oracle, so a guess
 * cannot be extended one character at a time.
 *
 * It does not hide the code's LENGTH: a mismatch there returns before
 * `timingSafeEqual` is reached, which is unavoidable given the primitive takes
 * equal-length buffers. Said plainly because this comment used to claim
 * otherwise, and a guard whose comment overstates it is worse than one with no
 * comment. Length is cheap to learn and worth little on its own — the search
 * space it leaves is still the whole code — and the lockout caps the attempt
 * rate regardless.
 */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** Already-authorized? (No code redemption here — that's `/login`-only.) */
export async function isAuthorized(
  access: AccessControl,
  interaction: BaseInteraction,
): Promise<boolean> {
  if (!isGated(access)) return true; // open
  const userId = interaction.user.id;
  if (access.enrolled.has(userId)) return true;
  if (access.allowIds.has(userId)) return true;
  if (access.requiredGuildId && (await isGuildMember(interaction, access))) return true;
  return false;
}

/** Allowed through, or refused with something to tell the user. */
export type GateOutcome = { ok: true } | { ok: false; reason: string };

export const NO_ACCESS = '你沒有權限使用這個 bot。請先用 `/login code:<存取碼>` 取得存取權。';

const minutes = (ms: number): number => Math.ceil(ms / 60_000);

/**
 * Gate `/login`, the one command that can also GRANT access.
 *
 * `supplied` is passed in rather than read off the interaction so that the one
 * function comparing a secret takes that secret as a visible argument.
 */
export async function gateLogin(
  access: AccessControl,
  interaction: BaseInteraction,
  supplied: string | null | undefined,
): Promise<GateOutcome> {
  if (await isAuthorized(access, interaction)) return { ok: true };

  if (!access.accessCode) {
    return { ok: false, reason: '你沒有權限使用這個 bot。請聯絡管理者取得存取權。' };
  }

  const userId = interaction.user.id;
  const code = supplied?.trim() ?? '';

  // Locked out from earlier wrong guesses? Refuse BEFORE comparing, so a correct
  // guess during the lock cannot confirm the code either. Checking the code
  // first and merely declining to act on it would still leak the answer through
  // which message came back — and the whole point of the lockout is that an
  // attacker learns nothing per attempt.
  const lockedMs = access.lockout.lockedFor(userId);
  if (lockedMs > 0) {
    return { ok: false, reason: `存取碼錯誤次數過多,請 ${minutes(lockedMs)} 分鐘後再試。` };
  }

  if (code !== '' && safeEqual(code, access.accessCode)) {
    access.lockout.recordSuccess(userId);
    access.enrolled.add(userId);
    access.store?.enroll(userId);
    return { ok: true };
  }

  if (code !== '') {
    const lockMs = access.lockout.recordFailure(userId);
    return {
      ok: false,
      reason:
        lockMs > 0
          ? `存取碼錯誤。錯誤次數過多,已鎖定 ${minutes(lockMs)} 分鐘。`
          : '存取碼錯誤。請向管理者確認後再試:`/login code:<存取碼>`。',
    };
  }

  // No code offered at all. Deliberately NOT a failed attempt: someone who runs
  // `/login` without knowing a code is needed is not guessing, and counting it
  // would let a stranger lock a legitimate user out by nothing more than
  // prompting them to try the command.
  return {
    ok: false,
    reason: '這個 bot 需要存取碼。請用 `/login code:<存取碼>` 提供(只需第一次)。',
  };
}

/** Is the interacting user a member of `requiredGuildId`? A single member fetch
 *  by ID needs the bot to be in the guild but NOT the privileged Members intent.
 *  Positive results are cached briefly so button spam doesn't fetch every time. */
async function isGuildMember(interaction: BaseInteraction, access: AccessControl): Promise<boolean> {
  const userId = interaction.user.id;
  const hit = access.memberCache.get(userId);
  if (hit && hit > access.now()) return true;

  try {
    const guild: Guild =
      interaction.client.guilds.cache.get(access.requiredGuildId) ??
      (await interaction.client.guilds.fetch(access.requiredGuildId));
    await guild.members.fetch(userId); // throws if the user isn't a member
    access.memberCache.set(userId, access.now() + MEMBER_CACHE_MS);
    return true;
  } catch {
    // Negative results are NOT cached: someone who joins the server should get
    // in on their next click, not five minutes later.
    access.memberCache.delete(userId);
    return false;
  }
}
