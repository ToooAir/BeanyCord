/**
 * Per-Discord-user session + flow state, with a per-user async lock.
 *
 * M2 scope: single Beanfun account per Discord user, with encrypted on-disk
 * persistence (optional `SessionStore`) and a 60s keep-alive ping per logged-in
 * user (mirrors the Rust backend's `install_session_and_start_ping`). Each user
 * gets their own `BeanfunClient` (its own cookie jar) so users are fully
 * isolated. The lock serialises a user's button / menu clicks so two rapid
 * interactions can't race the same session (mirrors the Rust `withGuard`
 * single-slot semantics).
 */
import { CookieJar } from 'tough-cookie';

import { BeanfunClient } from '../beanfun/client.js';
import type { QrLoginInit, ServiceAccount, Session } from '../beanfun/types.js';
import { getEgressIp } from './egressIp.js';
import { safeError } from './redact.js';
import type { SessionStore } from './store.js';

/** WPF pingWorker cadence (#237): keep the server-side session warm every 60s. */
export const PING_INTERVAL_MS = 60_000;

/**
 * Consecutive keep-alive failures before we declare the session dead. One or
 * two failures are routinely transient (network blip, risk control); five in a
 * row (~5 min) means the server-side session is gone for real.
 *
 * Exported alongside the cadence because the two only mean anything together:
 * what was chosen is a ~5 minute tolerance, and the tests assert that product
 * rather than either number on its own.
 */
export const PING_FAIL_THRESHOLD = 5;

/**
 * How long to keep probing a session AFTER the threshold trips, before actually
 * dropping it. `0` restores the pre-2026-08-26 behaviour of dropping the moment
 * the threshold is reached.
 *
 * Why this exists: we have never once verified that a `session.logged_out`
 * verdict is PERMANENT. The captures we built the detector against
 * (`capture/dead/`) are of sessions we deliberately killed — a transient verdict
 * is byte-identical on the wire. The old code dropped the session at minute 5
 * and never looked again, so a session that recovered at minute 6 would have
 * been killed by us and we would never have known.
 *
 * **Why 90 minutes.** The 2026-08-26 mass logout landed 6 minutes into a
 * Gamania maintenance window announced for 08:00-09:00 TW — so the longest
 * outage this has to outlive is not the ~5 minute IP penalty, it is a
 * scheduled hour, plus however late we noticed, plus the overrun that
 * maintenance windows routinely have. An hour is not enough: notice at 08:06
 * would drop at 09:06, minutes after the session might have come back.
 *
 * The user is still told at minute 5 — the notification does not move, only the
 * drop does. So the cost is a session object kept in memory (and reported as a
 * suspect by `/status`, not as healthy), and the payoff is the answer to "was it
 * really dead?".
 */
export const DEFAULT_DEATH_OBSERVE_MS = 90 * 60_000;

export interface KeepAliveOptions {
  /** See `DEFAULT_DEATH_OBSERVE_MS`. */
  observeMs?: number;
  /** Injected so tests never reach the network. */
  egressIp?: () => Promise<string | undefined>;
}

function observeMsFromEnv(raw = process.env.SESSION_DEATH_OBSERVE_MINUTES): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_DEATH_OBSERVE_MS;
  const mins = Number(raw.trim());
  if (!Number.isFinite(mins) || mins < 0) return DEFAULT_DEATH_OBSERVE_MS;
  return mins * 60_000;
}

/** "3.2 min" — durations in logs are read by a human at 2am. */
function mins(ms: number): string {
  return `${(ms / 60_000).toFixed(1)} min`;
}

/** Minimal FIFO async mutex — chains tasks so only one runs at a time. */
class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    // Swallow errors on the chain so one failure doesn't poison the queue.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export interface UserState {
  /** Owns the cookie jar for this user's whole session. */
  client: BeanfunClient;
  /** Set once QR login finalises. */
  session?: Session;
  /** Live QR challenge while login is in flight. */
  pendingInit?: QrLoginInit;
  /** Recursive-timeout handle for the QR poll loop (so we can cancel it). */
  pollTimer?: NodeJS.Timeout;
  /** 60s keep-alive ping interval; live only while logged in. */
  pingTimer?: NodeJS.Timeout;
  /** Accounts from the last getAccounts, kept so an OTP pick can resolve a sid. */
  accounts?: ServiceAccount[];
  /** Consecutive keep-alive ping failures (reset on any success). */
  pingFails?: number;
  /** When the failure threshold first tripped (ms epoch). While set, the session
   *  is a *suspect*: the user has been told, but we keep probing until the
   *  observation window closes, so a verdict that lifts on its own is recorded
   *  as such instead of being mistaken for a death. */
  suspectAt?: number;
}

export class SessionManager {
  private states = new Map<string, UserState>();
  private mutexes = new Map<string, Mutex>();
  private readonly store: SessionStore | null;
  private readonly observeMs: number;
  private readonly egressIp: () => Promise<string | undefined>;

  /**
   * Called when a user's keep-alive has failed PING_FAIL_THRESHOLD times in a
   * row and their session was dropped, so the front-end can tell the user
   * proactively instead of letting them find out at the next OTP attempt.
   * Set by the Discord layer; errors are swallowed.
   */
  onSessionExpired?: (userId: string) => Promise<void>;

  /**
   * Called when a session that had already been declared a suspect starts
   * answering again — i.e. the "logged out" verdict was NOT permanent. Rare
   * enough to be worth a message: the user was told to re-login a moment ago.
   */
  onSessionRecovered?: (userId: string) => Promise<void>;

  constructor(store: SessionStore | null = null, opts: KeepAliveOptions = {}) {
    this.store = store;
    this.observeMs = opts.observeMs ?? observeMsFromEnv();
    this.egressIp = opts.egressIp ?? getEgressIp;
  }

  /** Get (creating if needed) the user's state + fresh client. */
  getOrCreate(userId: string): UserState {
    let s = this.states.get(userId);
    if (!s) {
      s = { client: new BeanfunClient() };
      this.states.set(userId, s);
    }
    return s;
  }

  get(userId: string): UserState | undefined {
    return this.states.get(userId);
  }

  isLoggedIn(userId: string): boolean {
    return this.states.get(userId)?.session !== undefined;
  }

  /** How many users currently have a live (logged-in) session. */
  activeSessionCount(): number {
    let n = 0;
    for (const s of this.states.values()) if (s.session) n += 1;
    return n;
  }

  /**
   * Of those, how many are only *suspected* live — the keep-alive has been
   * refused past the threshold and we are still probing.
   *
   * Reported separately because the observation window would otherwise make
   * `/status` confidently wrong for an hour and a half, which is exactly the
   * cost the old drop-at-minute-5 behaviour was avoiding.
   */
  suspectSessionCount(): number {
    let n = 0;
    for (const s of this.states.values()) if (s.session && s.suspectAt !== undefined) n += 1;
    return n;
  }

  /** Whether this user's session is under observation rather than known good. */
  isSuspect(userId: string): boolean {
    return this.states.get(userId)?.suspectAt !== undefined;
  }

  /** Drop a fresh client (clean cookie jar) for a new login attempt. */
  resetClient(userId: string): UserState {
    this.clearPoll(userId);
    this.stopPing(userId);
    const s: UserState = { client: new BeanfunClient() };
    this.states.set(userId, s);
    return s;
  }

  /** Fully forget a user (logout): cancel timers, drop in-memory + persisted. */
  remove(userId: string): void {
    this.clearPoll(userId);
    this.stopPing(userId);
    this.states.delete(userId);
    this.store?.remove(userId);
  }

  clearPoll(userId: string): void {
    const s = this.states.get(userId);
    if (s?.pollTimer) {
      clearTimeout(s.pollTimer);
      s.pollTimer = undefined;
    }
  }

  /**
   * Persist a logged-in user's session (cookie jar + handle) and ensure the
   * keep-alive loop is running. Call after login finalises and after any step
   * that mutates the session/cookies (e.g. game select). No-op pre-login.
   */
  async persist(userId: string): Promise<void> {
    const s = this.states.get(userId);
    if (!s?.session) return;
    if (s.session.bornAt === undefined) {
      s.session.bornAt = Date.now();
      // The "before" reading. Compared against the one taken at death, it is the
      // whole test for "did our egress IP move under us?" — and it is only
      // available if we take it now, while everything still works.
      void this.egressIp().then((ip) =>
        console.log(`[session] ${userId} session born — egress=${ip ?? 'unknown'}`),
      );
    }
    this.startPing(userId);
    if (!this.store) return;
    const cookies = await s.client.jar.serialize();
    this.store.save(userId, { session: s.session, cookies });
  }

  /**
   * Restore persisted sessions on startup: rebuild each user's client around its
   * saved cookie jar and resume the keep-alive ping. Returns the count restored.
   */
  async restore(): Promise<number> {
    if (!this.store) return 0;
    let n = 0;
    for (const [userId, payload] of this.store.loadAll()) {
      try {
        const jar = await CookieJar.deserialize(payload.cookies as never);
        this.states.set(userId, { client: new BeanfunClient({ jar }), session: payload.session });
        this.startPing(userId);
        n++;
      } catch (e) {
        console.error(`[session] restore failed for ${userId}:`, safeError(e));
        this.store.remove(userId);
      }
    }
    return n;
  }

  private startPing(userId: string): void {
    const s = this.states.get(userId);
    if (!s || s.pingTimer) return;
    s.pingTimer = setInterval(() => {
      const st = this.states.get(userId);
      if (!st?.session) return;
      // A single failure is transient (network / risk control) — retry next
      // tick, mirroring the Rust ping loop. But a long unbroken run of failures
      // means the server-side session is *probably* dead: tell the user, then
      // keep probing for `observeMs` so that "probably" can be checked.
      void st.client.ping().then(
        () => this.onPingSuccess(userId, st),
        (e) => {
          st.pingFails = (st.pingFails ?? 0) + 1;
          this.onPingFailure(userId, st, e);
        },
      );
    }, PING_INTERVAL_MS);
  }

  /** Age of a live session, or `undefined` for one persisted before `bornAt`. */
  private ageOf(st: UserState): string {
    return st.session?.bornAt === undefined ? 'unknown' : mins(Date.now() - st.session.bornAt);
  }

  private onPingSuccess(userId: string, st: UserState): void {
    const failed = st.pingFails ?? 0;
    st.pingFails = 0;
    if (st.suspectAt !== undefined) {
      const down = Date.now() - st.suspectAt;
      st.suspectAt = undefined;
      // The finding this whole observation window exists to produce. Loud on
      // purpose: it falsifies the assumption every part of the death path is
      // built on, and the old code could not have printed it.
      console.warn(
        `[ping] RECOVERED for ${userId} after ${mins(down)} of "logged out" — ` +
          'the verdict was NOT permanent; this session would have been killed by us',
      );
      void this.onSessionRecovered?.(userId).catch(() => undefined);
      return;
    }
    if (failed > 0) console.log(`[ping] ${userId} recovered after ${failed} failure(s)`);
  }

  private onPingFailure(userId: string, st: UserState, e: unknown): void {
    const n = st.pingFails ?? 0;
    // EVERY failure, not just the one that trips the threshold. The 5th failure
    // alone cannot tell you whether the first four were the same thing — four
    // network errors followed by one `session.logged_out` reads identically in
    // the old log, and means something completely different.
    console.warn(`[ping] fail #${n} for ${userId} (age=${this.ageOf(st)}): ${safeError(e)}`);
    if (n < PING_FAIL_THRESHOLD) return;

    if (st.suspectAt === undefined) {
      st.suspectAt = Date.now();
      console.warn(
        `[session] keep-alive failed ${n}x for ${userId} (age=${this.ageOf(st)}) — ` +
          (this.observeMs > 0
            ? `notifying, and probing for another ${mins(this.observeMs)} before dropping`
            : 'dropping session'),
      );
      // Not awaited: the drop decision must never wait on a third-party
      // service, least of all under a timer.
      void this.egressIp().then((ip) =>
        console.warn(`[session] ${userId} suspected dead — egress=${ip ?? 'unknown'}`),
      );
      void this.onSessionExpired?.(userId).catch(() => undefined);
    }

    if (this.observeMs > 0 && Date.now() - st.suspectAt < this.observeMs) return;
    console.warn(
      `[session] dropping ${userId} — still logged out after ${mins(Date.now() - st.suspectAt)} of probing`,
    );
    this.remove(userId);
  }

  private stopPing(userId: string): void {
    const s = this.states.get(userId);
    if (s?.pingTimer) {
      clearInterval(s.pingTimer);
      s.pingTimer = undefined;
    }
  }

  /** Serialise this user's actions. */
  withLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    let m = this.mutexes.get(userId);
    if (!m) {
      m = new Mutex();
      this.mutexes.set(userId, m);
    }
    return m.run(fn);
  }
}
