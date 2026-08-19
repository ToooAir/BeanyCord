/**
 * Staying under beanfun's pSKey quota.
 *
 * Measured 2026-08-19 by tripping it repeatedly from a home line: `default.aspx`
 * serves at most 4 pSKey issuances per IP in any ~80-second sliding window
 * (bracketed to 79.2s <= W < 83.6s from one run of 27 successes and a refusal),
 * and answers the request that breaks the rule with `/TW/BlockIPMessage.htm` for
 * a fixed 4-5 minutes. Every user of a deployment leaves through one egress IP,
 * so one trip refuses everybody at once — which is why the budget is enforced at
 * the endpoint rather than per user.
 *
 * The safety argument is not "90 feels far enough from 80". It is that our
 * window is strictly WIDER than beanfun's, so beanfun's window is always a
 * subset of one of ours and can never hold a 5th request. The property test
 * below is that argument, executed — and it is followed by a demonstration that
 * a narrower window fails it, so the property is not passing vacuously.
 */
import { describe, expect, it, vi } from 'vitest';

import type { BaseMessageOptions, Message } from 'discord.js';

import type { BeanfunClient } from '../src/beanfun/client.js';
import { BeanfunError } from '../src/beanfun/errors.js';
import {
  getSessionKey,
  QR_BUDGET_LIMIT,
  QR_BUDGET_WINDOW_MS,
  QR_QUEUE_MAX_WAIT_MS,
} from '../src/beanfun/login/sessionKey.js';
import { RateGate, SlidingWindow } from '../src/core/guard.js';
import { deliverQr, loginFailureMessage, queueNotice } from '../src/discord/flow.js';

/** The widest counting window the measurement allows beanfun to have. */
const MEASURED_W_MS = 83_600;
const SERVER_QUOTA = 4;

/** What we ship — imported, not restated, so changing it re-runs the proof. */
const OUR_LIMIT = QR_BUDGET_LIMIT;
const OUR_WINDOW_MS = QR_BUDGET_WINDOW_MS;

describe('SlidingWindow', () => {
  it('spends a burst up to the limit, then refuses', () => {
    let t = 0;
    const w = new SlidingWindow(4, 90_000, () => t);
    expect([w.take(), w.take(), w.take(), w.take()]).toEqual([true, true, true, true]);
    expect(w.take()).toBe(false);
  });

  it('reports how long until the oldest use ages out', () => {
    let t = 0;
    const w = new SlidingWindow(2, 1_000, () => t);
    w.take();
    t = 400;
    w.take();
    // Counted from now, not from the use: the t=0 slot frees at t=1000, which is
    // 600ms away. Telling the caller "1000ms" would park them past the opening.
    expect(w.remaining()).toBe(600);
    t = 900;
    expect(w.remaining()).toBe(100);
  });

  it('frees one slot at a time, not the whole window', () => {
    // A limiter that cleared everything at once would hand back a full burst the
    // instant the first use expired — four more requests in a blink, which is
    // the exact shape that gets refused.
    let t = 0;
    const w = new SlidingWindow(2, 1_000, () => t);
    w.take();
    t = 500;
    w.take();
    t = 1_000; // the t=0 use has aged out; the t=500 one has not
    expect(w.take()).toBe(true);
    expect(w.take()).toBe(false);
  });

  it('treats a use exactly at the window edge as expired', () => {
    let t = 0;
    const w = new SlidingWindow(1, 1_000, () => t);
    w.take();
    t = 1_000;
    expect(w.take()).toBe(true);
  });
});

/** Replays a schedule against beanfun's measured behaviour and returns the time
 *  of the first request it would have refused, or null if it refuses none. */
function firstRefusal(schedule: number[], windowMs: number): number | null {
  const served: number[] = [];
  for (const t of schedule) {
    if (served.filter((s) => t - s < windowMs).length >= SERVER_QUOTA) return t;
    served.push(t);
  }
  return null;
}

describe('the shipped budget, against the server we measured', () => {
  /** Hammer the limiter once a second for an hour and collect what it lets out. */
  const drive = (limit: number, windowMs: number): number[] => {
    let t = 0;
    const ours = new SlidingWindow(limit, windowMs, () => t);
    const out: number[] = [];
    for (; t < 3_600_000; t += 1_000) if (ours.take()) out.push(t);
    return out;
  };

  it('never lets a 5th request into beanfun window, under unlimited demand', () => {
    expect(firstRefusal(drive(OUR_LIMIT, OUR_WINDOW_MS), MEASURED_W_MS)).toBeNull();
  });

  it('still holds if beanfun window is actually the narrow end of the bracket', () => {
    // A narrower server window is strictly easier on us; assert it rather than
    // assume it, since the bracket is the measurement and not a single number.
    expect(firstRefusal(drive(OUR_LIMIT, OUR_WINDOW_MS), 79_200)).toBeNull();
  });

  it('holds when callers QUEUE for slots rather than retrying', async () => {
    // The shipped path waits instead of failing, which paces requests right up
    // against the window edge — a tighter schedule than polling produces, and
    // therefore the one that has to be checked.
    const c = fakeClock();
    const gate = new RateGate(
      new SlidingWindow(OUR_LIMIT, OUR_WINDOW_MS, c.now),
      60 * 60_000,
      c.now,
      c.sleep,
    );
    const emitted: number[] = [];
    for (let i = 0; i < 60; i++) {
      const turn = await gate.acquire();
      if (turn.ok) emitted.push(c.now());
    }
    expect(firstRefusal(emitted, MEASURED_W_MS)).toBeNull();
  });

  it('and the property is not vacuous: a window narrower than beanfun fails it', () => {
    // 75s < 83.6s, so beanfun window is no longer a subset of ours and four of
    // our permits can land inside it alongside a fifth. This is the mistake the
    // real limiter is one constant away from.
    expect(firstRefusal(drive(OUR_LIMIT, 75_000), MEASURED_W_MS)).not.toBeNull();
  });
});

/** A clock the queue drives itself: sleeping is what advances time, so the
 *  tests are deterministic and take no real time. */
function fakeClock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let t = 0;
  return {
    now: () => t,
    sleep: (ms: number) => {
      t += ms;
      return Promise.resolve();
    },
  };
}

const gateOf = (limit: number, windowMs: number, maxWaitMs: number): RateGate => {
  const c = fakeClock();
  return new RateGate(new SlidingWindow(limit, windowMs, c.now), maxWaitMs, c.now, c.sleep);
};

describe('RateGate — one queue, shared by everyone', () => {
  it('serves a burst immediately, then makes the next caller wait for room', async () => {
    const gate = gateOf(4, 90_000, 600_000);
    for (let i = 0; i < 4; i++) expect(await gate.acquire()).toEqual({ ok: true, waitedMs: 0 });
    expect(await gate.acquire()).toEqual({ ok: true, waitedMs: 90_000 });
  });

  it('holds the limit when callers arrive together, not one at a time', async () => {
    // What serialising the queue actually buys. Without it, everyone waiting
    // reads the same `remaining()`, sleeps the same duration, and then takes a
    // slot in the same instant — six requests landing at once under a limit of
    // two. Concurrency is the only way to see that; a sequential test passes
    // either way, which an earlier version of this test did.
    vi.useFakeTimers();
    try {
      const gate = new RateGate(new SlidingWindow(2, 60_000), 600_000);
      const served: number[] = [];
      const all = Promise.all(
        [0, 1, 2, 3, 4, 5].map((i) =>
          gate.acquire().then((r) => {
            if (r.ok) served.push(Date.now());
            return i;
          }),
        ),
      );
      await vi.advanceTimersByTimeAsync(600_000);
      expect(await all).toEqual([0, 1, 2, 3, 4, 5]);

      expect(served).toHaveLength(6);
      // No 60-second span ever holds more than two.
      for (const t of served) {
        expect(served.filter((s) => Math.abs(s - t) < 60_000).length).toBeLessThanOrEqual(2);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses rather than holding a caller past its deadline', async () => {
    // A caller held longer than its own interaction stays alive gets nothing at
    // all. A refusal carrying an ETA is strictly better than a silent expiry.
    const gate = gateOf(1, 90_000, 10_000);
    expect(await gate.acquire()).toEqual({ ok: true, waitedMs: 0 });
    expect(await gate.acquire()).toEqual({ ok: false, retryAfterMs: 90_000 });
  });

  it('keeps the queue moving after a caller is refused', async () => {
    // The refusal path must not poison the chain every later caller is waiting
    // on — that would turn one timeout into a permanently stuck login.
    const gate = gateOf(1, 90_000, 10_000);
    await gate.acquire();
    expect((await gate.acquire()).ok).toBe(false);
    expect((await gate.acquire()).ok).toBe(false);
  });
});

describe('the queue notice', () => {
  it('says nothing for a wait shorter than the reading of it', () => {
    expect(queueNotice(2_000, 0)).toBeNull();
  });

  it('warns, with the wait and the depth, once the wait is worth noticing', () => {
    const msg = queueNotice(45_000, 3);
    expect(msg?.content).toContain('45 秒');
    expect(msg?.content).toContain('3 個人');
  });

  it('tells the user that retrying costs them a slot', () => {
    // Silence is what makes someone run /login again, and a second run does not
    // join the first — it mints another pSKey out of the same budget they are
    // queued for. This sentence is the reason the notice exists at all.
    expect(queueNotice(45_000, 0)?.content).toContain('只會多佔一個名額');
  });

  it('stays quiet when the wait is so long the request will be refused instead', () => {
    // The refusal carries its own message; two in a row would just be noise.
    expect(queueNotice(QR_QUEUE_MAX_WAIT_MS, 9)).toBeNull();
  });
});

describe('where the QR is delivered', () => {
  type Send = (payload: BaseMessageOptions) => Promise<Message>;
  const spies = (): { deliver: Send; dmSend: Send; used: string[] } => {
    const used: string[] = [];
    return {
      used,
      deliver: (() => {
        used.push('deliver');
        return Promise.resolve({} as Message);
      }) as Send,
      dmSend: (() => {
        used.push('dmSend');
        return Promise.resolve({} as Message);
      }) as Send,
    };
  };

  it('replaces the command reply when there was no wait', async () => {
    const s = spies();
    await deliverQr({ content: 'qr' }, false, s.deliver, s.dmSend);
    expect(s.used).toEqual(['deliver']);
  });

  it('sends a NEW message after a wait, so the user is notified', async () => {
    // The whole point. An edit of the queue notice fires no notification, and
    // someone who waited a minute has stopped looking — they would be handed a
    // QR they never see, which then expires in 150s.
    const s = spies();
    await deliverQr({ content: 'qr' }, true, s.deliver, s.dmSend);
    expect(s.used).toEqual(['dmSend']);
  });
});

describe('RateGate.projectedWaitMs', () => {
  it('is zero while the window still has room', () => {
    const gate = gateOf(4, 90_000, 600_000);
    expect(gate.projectedWaitMs()).toBe(0);
  });

  it('grows with the number of callers already waiting', async () => {
    // Whatever a caller is told has to account for the queue ahead of them, not
    // just the next free slot — otherwise the estimate is wrong by exactly the
    // amount that matters when it matters.
    const c = fakeClock();
    const gate = new RateGate(new SlidingWindow(2, 60_000, c.now), 600_000, c.now, c.sleep);
    await gate.acquire();
    await gate.acquire();
    const alone = gate.projectedWaitMs();
    expect(alone).toBe(60_000);

    const held = [gate.acquire(), gate.acquire()];
    expect(gate.projectedWaitMs()).toBeGreaterThan(alone);
    await Promise.all(held);
  });
});

describe('what the user is told while queued', () => {
  it('names the actual number of seconds, not "later"', () => {
    // A user who is told "try again later" tries again immediately. The wait is
    // the only part of this message that changes behaviour.
    const msg = loginFailureMessage(new BeanfunError('login.rate_budget', 'spent', 12_400));
    expect(msg.content).toContain('13 秒');
    expect(msg.components).toBeUndefined();
  });
});

describe('getSessionKey', () => {
  it('queues the 5th mint instead of failing it, and serves it when room opens', async () => {
    // The budget lives on the endpoint, so this holds for every caller — the
    // Discord flow, `m0`, anything added later. A guard in the Discord layer
    // could be routed around by the next call site; this one cannot.
    const client = {
      http: {
        get: (url: string) =>
          Promise.resolve({ statusCode: 200, body: '<html>ok</html>', url: `${url}&pSKey=abc123` }),
      },
    } as unknown as BeanfunClient;

    vi.useFakeTimers();
    try {
      for (let i = 0; i < OUR_LIMIT; i++) expect(await getSessionKey(client)).toBe('abc123');

      // The point of the rewrite: the 5th waits rather than being turned away.
      // Asserting it is still unsettled is what separates "queued" from both
      // "served" and "refused" — the earlier version of this budget threw here.
      let settled = false;
      const fifth = getSessionKey(client).then(
        (v) => {
          settled = true;
          return v;
        },
        (e: unknown) => {
          settled = true;
          throw e;
        },
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(OUR_WINDOW_MS);
      expect(await fifth).toBe('abc123');
    } finally {
      vi.useRealTimers();
    }
  });
});
