/**
 * The keep-alive loop, which is the only thing that notices a session dying
 * while nobody is using it.
 *
 * This loop has been entirely dead once already. Before `c67bea6`, `ping()` ran
 * only `ensureSuccess`, and `echo_token.ashx` answers **HTTP 200 for a dead
 * session** — so it always resolved, `pingFails` never left 0, the threshold
 * never tripped, and `notifySessionExpired` was unreachable code. Nothing caught
 * it, because the detector it depends on was tested (`ping.test.ts`) while the
 * loop that acts on the detector was not. This file is that missing half.
 *
 * Everything runs on fake timers: the real cadence is one minute, and the
 * property under test needs five of them.
 */
import { describe, expect, it, vi } from 'vitest';

import type { BeanfunClient } from '../src/beanfun/client.js';
import { BeanfunError } from '../src/beanfun/errors.js';
import {
  PING_FAIL_THRESHOLD,
  PING_INTERVAL_MS,
  SessionManager,
} from '../src/core/sessionManager.js';
import type { Session } from '../src/beanfun/types.js';

const SESSION: Session = {
  region: 'TW',
  skey: 'k',
  webToken: 't',
  accountId: '',
  serviceCode: 'code',
  serviceRegion: 'region',
};

/** A logged-in user whose keep-alive answers however `ping` says. `persist()` is
 *  what arms the loop, exactly as the login path does. */
async function withKeepAlive(
  userId: string,
  ping: () => Promise<void>,
): Promise<{ manager: SessionManager; expired: string[] }> {
  // `egressIp` is stubbed unconditionally: the real one makes a network
  // request, and under fake timers a unit test must never depend on one
  // resolving.
  const manager = new SessionManager(null, { egressIp: async () => undefined });
  const expired: string[] = [];
  manager.onSessionExpired = async (u) => void expired.push(u);
  const state = manager.getOrCreate(userId);
  // A fresh copy per test: `persist` stamps `bornAt` onto it.
  state.session = { ...SESSION };
  state.client = { ping } as unknown as BeanfunClient;
  await manager.persist(userId);
  return { manager, expired };
}

/** Advance whole ping cycles. */
const ticks = async (n: number): Promise<void> => {
  await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS * n);
};

const dead = (): Promise<void> => Promise.reject(new BeanfunError('session.logged_out', 'gone'));

describe('the keep-alive loop', () => {
  it('drops the session and notifies once the failures are unbroken enough', async () => {
    // The property, stated against the module's own constants rather than
    // against the number 5 — what was chosen is a tolerance, not a magic count.
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { manager, expired } = await withKeepAlive('u1', dead);

      await ticks(PING_FAIL_THRESHOLD - 1);
      expect(manager.isLoggedIn('u1')).toBe(true);
      expect(expired).toEqual([]);

      await ticks(1);
      expect(manager.isLoggedIn('u1')).toBe(false);
      expect(manager.activeSessionCount()).toBe(0);
      // Told, not left to discover the corpse at the next OTP attempt.
      expect(expired).toEqual(['u1']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('holds on through blips, because a failure alone proves nothing', async () => {
    // A single failure is routinely a network hiccup or risk control. Dropping
    // on it would log people out for free, all day.
    //
    // A flapping connection — failing most ticks but recovering before any run
    // reaches the threshold — must therefore survive indefinitely. The first
    // version of this test failed the session by accident: it succeeded only
    // ONCE, which lets a full run accumulate afterwards. That the code caught
    // my mistake is the point of writing the falsification as a pattern rather
    // than as a single flip.
    vi.useFakeTimers();
    try {
      let n = 0;
      const { manager } = await withKeepAlive('u2', () => {
        n += 1;
        return n % PING_FAIL_THRESHOLD === 0 ? Promise.resolve() : dead();
      });

      await ticks(PING_FAIL_THRESHOLD * 10);
      expect(manager.isLoggedIn('u2')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('counts CONSECUTIVE failures — a success resets the streak', async () => {
    // The distinction the test above depends on, asserted directly: without the
    // reset, "5 failures ever" would eventually drop every long-lived session,
    // and the bot's users stay signed in for days.
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      let alive = true;
      const { manager } = await withKeepAlive('u3', () => (alive ? Promise.resolve() : dead()));

      // Fail almost to the threshold, then recover.
      alive = false;
      await ticks(PING_FAIL_THRESHOLD - 1);
      alive = true;
      await ticks(1);
      expect(manager.isLoggedIn('u3')).toBe(true);

      // The counter is back to zero, so it takes a FULL run to drop it now.
      alive = false;
      await ticks(PING_FAIL_THRESHOLD - 1);
      expect(manager.isLoggedIn('u3')).toBe(true);
      await ticks(1);
      expect(manager.isLoggedIn('u3')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('actually cancels the interval of a session it drops, not just the pings', async () => {
    // `remove()` calls `stopPing` BEFORE `states.delete`, and that order is
    // load-bearing: `stopPing` looks the state up to find the timer handle, so
    // deleting first finds nothing and the interval is never cleared — one
    // orphan timer per dropped user, held for the life of the process.
    //
    // Counting pings CANNOT see this, which is what the first version of this
    // test did and why it passed against the broken order: the interval body
    // opens with `if (!st?.session) return`, so a dropped user stops being
    // pinged either way. The leak is the timer itself, so that is what gets
    // asserted — `getTimerCount()` is the only thing that distinguishes
    // "stopped working" from "stopped existing".
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      let calls = 0;
      const { manager } = await withKeepAlive('u4', () => {
        calls += 1;
        return dead();
      });
      expect(vi.getTimerCount()).toBe(1); // the keep-alive is running

      await ticks(PING_FAIL_THRESHOLD);
      expect(manager.isLoggedIn('u4')).toBe(false);
      expect(vi.getTimerCount()).toBe(0); // ...and is gone, not merely idle

      const atDrop = calls;
      await ticks(10);
      expect(calls).toBe(atDrop);
    } finally {
      vi.useRealTimers();
    }
  });

  it('survives a notifier that throws', async () => {
    // The DM can fail — the user may have DMs closed, or have blocked the bot.
    // An unhandled rejection out of a background interval takes the whole
    // process down, which is a steep price for failing to deliver a courtesy.
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { manager } = await withKeepAlive('u5', dead);
      manager.onSessionExpired = () => Promise.reject(new Error('cannot DM this user'));

      await ticks(PING_FAIL_THRESHOLD);
      expect(manager.isLoggedIn('u5')).toBe(false); // dropped anyway
    } finally {
      vi.useRealTimers();
    }
  });

  it('stamps a birth time, so a death can be reported with an age', async () => {
    // Which is the difference between "they all died at the same age" and "they
    // all died at the same moment" — two explanations that are indistinguishable
    // without it, and we spent an evening unable to tell them apart.
    const { manager } = await withKeepAlive('u6', () => Promise.resolve());
    expect(manager.get('u6')?.session?.bornAt).toBeTypeOf('number');
  });

  it('tolerates roughly five minutes before giving up on a session', async () => {
    // The two constants only mean something as a product, and that product is
    // the actual design decision: long enough to ride out a blip, short enough
    // that /status is not confidently wrong for an hour. Pinned loosely so
    // retuning either number stays possible without rewriting the tests above.
    const toleranceMs = PING_INTERVAL_MS * PING_FAIL_THRESHOLD;
    expect(toleranceMs).toBeGreaterThanOrEqual(3 * 60_000);
    expect(toleranceMs).toBeLessThanOrEqual(15 * 60_000);
  });
});
