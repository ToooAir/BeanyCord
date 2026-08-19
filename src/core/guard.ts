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

/**
 * At most `limit` uses in any `windowMs` span.
 *
 * Distinct from `Cooldown`, which spaces uses evenly: a server quota lets you
 * spend a burst and then stops, and pacing evenly would both waste the burst and
 * fail to model the ceiling. Beanfun's pSKey quota is exactly this shape, so
 * this is the shape that can be proved safe against it.
 */
export class SlidingWindow {
  private hits: number[] = [];

  constructor(
    readonly limit: number,
    readonly windowMs: number,
    private readonly now: Now = Date.now,
  ) {}

  /** Milliseconds until another `take()` would succeed (0 = room right now). */
  remaining(): number {
    const t = this.now();
    const cutoff = t - this.windowMs;
    while (this.hits.length > 0 && this.hits[0]! <= cutoff) this.hits.shift();
    if (this.hits.length < this.limit) return 0;
    // hits[0] is the oldest still counted; room appears the moment it ages out.
    return Math.max(0, this.hits[0]! + this.windowMs - t);
  }

  /** Record a use if there is room. Returns false if there is not. */
  take(): boolean {
    if (this.remaining() > 0) return false;
    this.hits.push(this.now());
    return true;
  }
}

/**
 * Outcome of asking a `RateGate` for a turn.
 *
 * `busy` means our own budget is full; `blocked` means the server has already
 * refused us and is serving a penalty. They need separate answers: one is a
 * queue we manage, the other is a wall we can only wait out.
 */
export type GateResult =
  | { ok: true; waitedMs: number }
  | { ok: false; retryAfterMs: number; reason: 'busy' | 'blocked' };

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * A single queue in front of a `SlidingWindow`, shared by everyone.
 *
 * The constraint being modelled is per-IP, and a deployment has one IP — the
 * server has no idea which user a request belongs to. So throttling per user
 * models nothing: it refuses someone the budget could have served, while the
 * budget itself is what actually keeps us safe. Fairness here comes from FIFO
 * order instead, and nobody is turned away for someone else's traffic.
 *
 * Callers wait rather than fail, because a wait is almost always shorter than
 * the five-minute penalty for getting this wrong, and because a refusal invites
 * an immediate retry. `maxWaitMs` bounds that: past it the honest answer is a
 * refusal with an ETA, not a wait long enough for the caller's own deadline
 * (a Discord interaction token) to expire first.
 */
export class RateGate {
  private chain: Promise<unknown> = Promise.resolve();
  private waiting = 0;
  private penaltyUntil = 0;
  /** Take times kept purely to explain a refusal, well past `windowMs` — the
   *  window itself prunes, and what we need at that moment is the history the
   *  window has already forgotten. */
  private recent: number[] = [];

  constructor(
    private readonly window: SlidingWindow,
    private readonly maxWaitMs: number,
    private readonly now: Now = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = realSleep,
  ) {}

  /** How many callers are queued right now, including the one being served. */
  get queued(): number {
    return this.waiting;
  }

  /**
   * Record that the server has refused us, and hold everyone off for `ms`.
   *
   * A window alone cannot describe beanfun: measured three times, a refusal
   * costs a FIXED 4-5 minutes during which no amount of window arithmetic helps,
   * and our own window is only ever an estimate of the server's — it resets when
   * the process does, while the server's counter does not. Without this, a
   * deployment that gets blocked keeps releasing callers on schedule, each of
   * them waiting out a queue only to be refused on arrival. Which is exactly
   * what production did: queued 54.9s, then rate-limited anyway.
   *
   * Blocked requests were measured NOT to extend the penalty, so the deadline is
   * a max, never a sliding one — a late report cannot strand anybody.
   */
  penalise(ms: number): void {
    this.penaltyUntil = Math.max(this.penaltyUntil, this.now() + ms);
  }

  /**
   * Our own recent footprint, for the log line next to a refusal.
   *
   * Being refused while our model says we are well inside the budget means the
   * model is wrong, and there is no way to tell WHICH way from the refusal
   * alone: the quota may be lower on this address than where it was measured,
   * the window may be a different shape, or the address may be shared with
   * somebody else spending it. All three look identical unless our own history
   * is printed beside the refusal, so print it.
   */
  footprint(): string {
    const t = this.now();
    const spans = [30, 60, 90, 120, 300, 600];
    const counts = spans.map((s) => this.recent.filter((h) => t - h <= s * 1_000).length);
    const newest = this.recent.length > 0 ? (t - this.recent[this.recent.length - 1]!) / 1_000 : null;
    const oldest = this.recent.length > 0 ? (t - this.recent[0]!) / 1_000 : null;
    return (
      `ours in last ${spans.map((s) => `${s}s`).join('/')}: ${counts.join('/')}` +
      (newest === null ? ' (none recorded)' : `; newest ${newest.toFixed(1)}s ago, oldest ${oldest!.toFixed(1)}s ago`)
    );
  }

  /** How long until a turn could be taken: our own budget or the server's
   *  penalty, whichever is further out. */
  private waitNow(): { ms: number; reason: 'busy' | 'blocked' } {
    const penalty = Math.max(0, this.penaltyUntil - this.now());
    const budget = this.window.remaining();
    return penalty > budget ? { ms: penalty, reason: 'blocked' } : { ms: budget, reason: 'busy' };
  }

  /**
   * Roughly how long a caller joining right now would wait.
   *
   * Advisory only, and deliberately so: the exact answer depends on when each
   * slot ages out, which nobody needs to the second. Steady-state throughput is
   * `limit` per window, so `ahead` waiters take `ahead * window / limit` to
   * clear, on top of the wait for the first slot. It exists so a caller can
   * decide whether the wait is worth telling a human about BEFORE joining the
   * queue — after joining it is too late, since a caller deep in the queue does
   * not get its turn (and so learns nothing) until everyone ahead is served.
   */
  projectedWaitMs(): number {
    const first = this.waitNow().ms;
    if (first === 0) return 0;
    return first + (this.waiting * this.window.windowMs) / this.window.limit;
  }

  /**
   * Take a turn, waiting for one if necessary. Resolves in call order.
   *
   * The deadline is fixed when the caller joins, not when its turn arrives, so
   * a long queue refuses the people at the back rather than silently holding
   * them past the point where an answer is still useful.
   */
  async acquire(): Promise<GateResult> {
    const deadline = this.now() + this.maxWaitMs;
    this.waiting += 1;

    const mine = this.chain.then(async (): Promise<GateResult> => {
      const startedAt = this.now();
      const { ms: wait, reason } = this.waitNow();
      if (startedAt + wait > deadline) {
        return { ok: false, retryAfterMs: wait, reason };
      }
      if (wait > 0) await this.sleep(wait);
      this.window.take();
      this.recent.push(this.now());
      if (this.recent.length > 40) this.recent.shift();
      return { ok: true, waitedMs: this.now() - startedAt };
    });

    // The queue must survive one caller's failure, so the chain never carries a
    // rejection forward.
    this.chain = mine.then(
      () => undefined,
      () => undefined,
    );

    try {
      return await mine;
    } finally {
      this.waiting -= 1;
    }
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
