import { describe, expect, it } from 'vitest';

import { Cooldown, FailureLockout } from '../src/core/guard.js';

/** Manually advanced clock so tests are deterministic without fake timers. */
function makeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

describe('FailureLockout', () => {
  const opts = { freeAttempts: 3, baseLockMs: 60_000, maxLockMs: 3_600_000 };

  it('allows the free attempts without locking', () => {
    const clock = makeClock();
    const g = new FailureLockout(opts, clock.now);
    expect(g.recordFailure('u')).toBe(0);
    expect(g.recordFailure('u')).toBe(0);
    expect(g.recordFailure('u')).toBe(0);
    expect(g.lockedFor('u')).toBe(0);
  });

  it('locks exponentially past the free attempts, capped at maxLockMs', () => {
    const clock = makeClock();
    const g = new FailureLockout(opts, clock.now);
    for (let i = 0; i < 3; i++) g.recordFailure('u');
    expect(g.recordFailure('u')).toBe(60_000); // 4th fail → base
    expect(g.recordFailure('u')).toBe(120_000); // 5th → 2x
    expect(g.recordFailure('u')).toBe(240_000); // 6th → 4x
    for (let i = 0; i < 10; i++) g.recordFailure('u');
    expect(g.recordFailure('u')).toBe(3_600_000); // capped
  });

  it('unlocks after the lock elapses but keeps the failure count', () => {
    const clock = makeClock();
    const g = new FailureLockout(opts, clock.now);
    for (let i = 0; i < 4; i++) g.recordFailure('u');
    expect(g.lockedFor('u')).toBe(60_000);
    clock.advance(60_001);
    expect(g.lockedFor('u')).toBe(0);
    // Next failure escalates rather than restarting from the free tier.
    expect(g.recordFailure('u')).toBe(120_000);
  });

  it('success resets the key; other keys are independent', () => {
    const clock = makeClock();
    const g = new FailureLockout(opts, clock.now);
    for (let i = 0; i < 4; i++) g.recordFailure('a');
    g.recordFailure('b');
    expect(g.lockedFor('a')).toBeGreaterThan(0);
    expect(g.lockedFor('b')).toBe(0);
    g.recordSuccess('a');
    expect(g.lockedFor('a')).toBe(0);
    expect(g.recordFailure('a')).toBe(0); // back in the free tier
  });
});

describe('Cooldown', () => {
  it('is open before first touch and closed for intervalMs after', () => {
    const clock = makeClock();
    const c = new Cooldown(10_000, clock.now);
    expect(c.remaining('u')).toBe(0);
    c.touch('u');
    expect(c.remaining('u')).toBe(10_000);
    clock.advance(4_000);
    expect(c.remaining('u')).toBe(6_000);
    clock.advance(6_000);
    expect(c.remaining('u')).toBe(0);
  });

  it('keys are independent and clear() reopens immediately', () => {
    const clock = makeClock();
    const c = new Cooldown(10_000, clock.now);
    c.touch('a');
    expect(c.remaining('b')).toBe(0);
    c.clear('a');
    expect(c.remaining('a')).toBe(0);
  });
});
