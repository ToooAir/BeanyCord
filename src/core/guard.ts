/**
 * Small abuse guards, transport-agnostic (no discord.js).
 *
 * - `FailureLockout`: per-key exponential lockout after repeated failures.
 *   Used to stop online brute-force of the shared ACCESS_CODE — the constant-time
 *   compare in bot.ts kills the timing oracle, this kills unlimited guessing.
 * - `Cooldown`: per-key minimum interval between successes. Used to keep a user
 *   from hammering the OTP endpoint with rapid button clicks.
 *
 * Both are in-memory only: state resets on restart, which is fine — the lockout
 * is about slowing an online attacker down, not a persistent ban, and a restart
 * is operator-visible anyway.
 */

/** Injectable clock so tests don't need fake timers. */
type Now = () => number;

export interface LockoutOptions {
  /** Failures tolerated before the first lock kicks in. */
  freeAttempts: number;
  /** First lock duration; doubles per further failure. */
  baseLockMs: number;
  /** Upper bound on a single lock. */
  maxLockMs: number;
}

export class FailureLockout {
  private readonly entries = new Map<string, { fails: number; lockedUntil: number }>();

  constructor(
    private readonly opts: LockoutOptions,
    private readonly now: Now = Date.now,
  ) {}

  /** Milliseconds until this key may try again (0 = allowed now). */
  lockedFor(key: string): number {
    const e = this.entries.get(key);
    if (!e) return 0;
    return Math.max(0, e.lockedUntil - this.now());
  }

  /** Record a failed attempt; returns the resulting lock in ms (0 = still free). */
  recordFailure(key: string): number {
    const e = this.entries.get(key) ?? { fails: 0, lockedUntil: 0 };
    e.fails += 1;
    const over = e.fails - this.opts.freeAttempts;
    if (over > 0) {
      const lockMs = Math.min(this.opts.baseLockMs * 2 ** (over - 1), this.opts.maxLockMs);
      e.lockedUntil = this.now() + lockMs;
      this.entries.set(key, e);
      return lockMs;
    }
    this.entries.set(key, e);
    return 0;
  }

  /** A successful attempt clears the key's history. */
  recordSuccess(key: string): void {
    this.entries.delete(key);
  }
}

export class Cooldown {
  private readonly lastAt = new Map<string, number>();

  constructor(
    private readonly intervalMs: number,
    private readonly now: Now = Date.now,
  ) {}

  /** Milliseconds until this key is allowed again (0 = allowed now). */
  remaining(key: string): number {
    const last = this.lastAt.get(key);
    if (last === undefined) return 0;
    return Math.max(0, last + this.intervalMs - this.now());
  }

  /** Mark a successful use, starting the cooldown window. */
  touch(key: string): void {
    this.lastAt.set(key, this.now());
  }

  clear(key: string): void {
    this.lastAt.delete(key);
  }
}
