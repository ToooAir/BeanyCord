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
import { safeError } from './redact.js';
import type { SessionStore } from './store.js';

/** WPF pingWorker cadence (#237): keep the server-side session warm every 60s. */
const PING_INTERVAL_MS = 60_000;

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
}

export class SessionManager {
  private states = new Map<string, UserState>();
  private mutexes = new Map<string, Mutex>();
  private readonly store: SessionStore | null;

  constructor(store: SessionStore | null = null) {
    this.store = store;
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
      // Swallow failures (transient network / risk control); retry next tick —
      // mirrors the Rust ping loop which logs-and-continues.
      void st.client.ping().catch(() => undefined);
    }, PING_INTERVAL_MS);
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
