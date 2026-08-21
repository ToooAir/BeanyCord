/**
 * Staying under beanfun's pSKey quota.
 *
 * Measured from a home line on 2026-08-19 and 2026-08-21: `default.aspx` serves
 * at most **4 pSKeys per IP in any ~80-second sliding window** — the quota read
 * off a back-to-back fill, the width bracketed by two staircases whose intervals
 * intersect at [79.2, 81.6]s — and answers the request that breaks the rule with
 * `/TW/BlockIPMessage.htm` for 4.5-4.8 minutes. Every user of a deployment leaves
 * through one egress IP, so one trip refuses everybody at once, which is why this
 * is enforced at the endpoint rather than per user.
 *
 * What ships is a minimum interval. Two properties are asserted here, both as
 * executable arguments rather than as chosen-looking constants:
 *
 *   1. **Steady state** — at a 30s spacing only the requests at -30s and -60s are
 *      still inside beanfun's ~80s window when we send, so it sees two and needs
 *      four. Driven under unlimited demand, at both ends of the measured bracket.
 *   2. **Across a restart** — our counter is in memory and beanfun's is not, so
 *      the policy has to survive losing its own state. A burst budget does not;
 *      that is asserted too, because it is why this is an interval.
 *
 * Each is followed by a case that FAILS it, so neither passes vacuously.
 */
import { describe, expect, it, vi } from 'vitest';

import type { BaseMessageOptions, Message } from 'discord.js';

import type { BeanfunClient } from '../src/beanfun/client.js';
import { BeanfunError } from '../src/beanfun/errors.js';
import {
  getSessionKey,
  QR_MIN_INTERVAL_MS,
  QR_QUEUE_MAX_WAIT_MS,
} from '../src/beanfun/login/sessionKey.js';
import { RateGate, SlidingWindow } from '../src/core/guard.js';
import { deliverQr, loginFailureMessage, queueNotice } from '../src/discord/flow.js';

/** Both ends of the measured bracket. The wider end is the harder case for us,
 *  the narrower one is asserted anyway rather than assumed to be easier. */
const MEASURED_W_MS = 83_600;
const MEASURED_W_NARROW_MS = 79_200;
const SERVER_QUOTA = 4;

/** A quota of 3 instead of 4 — not measured anywhere, but cheap to hold, and the
 *  measurement comes from a different address than the one that serves users. */
const HOSTILE_QUOTA = 3;

/**
 * What we ship. A limit of one per interval IS a minimum interval, so the limit
 * is structural and only the interval is imported — restate it and a future
 * change to the constant would stop re-running this proof.
 */
const OUR_LIMIT = 1;
const OUR_WINDOW_MS = QR_MIN_INTERVAL_MS;

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
function firstRefusal(schedule: number[], windowMs: number, quota = SERVER_QUOTA): number | null {
  const served: number[] = [];
  for (const t of schedule) {
    if (served.filter((s) => t - s < windowMs).length >= quota) return t;
    served.push(t);
  }
  return null;
}

/**
 * Replays restarts: our limiter loses its state at each one, beanfun's counter
 * does not. Demand is unlimited throughout, so what comes out is the fastest
 * schedule the policy can produce — the one that has to be safe.
 */
function acrossRestarts(
  limit: number,
  windowMs: number,
  seedOnBoot: boolean,
  restartsAt: number[],
): number | null {
  const sent: number[] = [];
  let t = 0;
  for (const end of [...restartsAt, 600_000]) {
    const w = new SlidingWindow(limit, windowMs, () => t);
    if (seedOnBoot) w.take();
    for (; t < end; t += 1_000) if (w.take()) sent.push(t);
  }
  return firstRefusal(sent, MEASURED_W_MS);
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
    expect(firstRefusal(drive(OUR_LIMIT, OUR_WINDOW_MS), MEASURED_W_NARROW_MS)).toBeNull();
  });

  it('leaves beanfun looking at two of ours, not three', () => {
    // The headroom, stated directly rather than inferred from "nothing was
    // refused". Two is what the previous 3-per-120s budget also left, so this
    // change bought throughput without spending margin — and a bare pass/fail
    // would not have shown that.
    const sent = drive(OUR_LIMIT, OUR_WINDOW_MS);
    const seen = Math.max(
      ...sent.map((t) => sent.filter((s) => s < t && t - s < MEASURED_W_MS).length),
    );
    expect(seen).toBe(2);
    expect(seen).toBeLessThan(SERVER_QUOTA);
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

  it('holds even if the quota on this address were 3 rather than the 4 measured', () => {
    expect(firstRefusal(drive(OUR_LIMIT, OUR_WINDOW_MS), MEASURED_W_MS, HOSTILE_QUOTA)).toBeNull();
  });

  it('survives a restart, which is why this is an interval and not a budget', () => {
    // Our counter is in memory; beanfun's is not. So the policy has to hold
    // across losing its own state, and a burst budget cannot: it hands its whole
    // burst to whoever asks first, and a restart hands it out a second time.
    expect(acrossRestarts(OUR_LIMIT, OUR_WINDOW_MS, true, [125_000, 126_000, 127_000])).toBeNull();
  });

  it('...and a burst budget does not: three, a redeploy, three more', () => {
    // The falsification for choosing an interval. 3 per 120s is what shipped
    // before, and it is refused within seconds of a restart — six requests land
    // inside one 80s window while our own window still reads empty.
    expect(acrossRestarts(3, 120_000, false, [5_000])).not.toBeNull();
  });

  it('...and without the boot seed, a crash loop leaks one request per restart', () => {
    // The falsification for seeding at boot. One restart is survivable on its
    // own; a process that restarts three times in a row is not, because each
    // fresh start contributes a request that our window has no memory of.
    expect(acrossRestarts(OUR_LIMIT, OUR_WINDOW_MS, false, [125_000, 126_000, 127_000])).not.toBeNull();
  });

  it('and the shipped module really does start a boot spent', async () => {
    // The restart properties above are proved against a locally-built window.
    // This asserts sessionKey.ts itself seeds one at import, because otherwise
    // deleting that single line would silently give every restart a free
    // request and none of the tests above would notice — which is exactly what
    // happened when this was checked by deleting it.
    vi.resetModules();
    const fresh = await import('../src/beanfun/login/sessionKey.js');
    expect(fresh.projectedQrWait().waitMs).toBeGreaterThan(0);
  });

  it('and the property is not vacuous: a 20s interval fails it', () => {
    // At 20s, four of ours (-20, -40, -60, -80) fit inside an 83.6s window and
    // the fifth is refused. This is what the margin at 30s consists of, and the
    // real limiter is one constant away from losing it.
    expect(firstRefusal(drive(OUR_LIMIT, 20_000), MEASURED_W_MS)).not.toBeNull();
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
    expect(await gate.acquire()).toEqual({ ok: false, retryAfterMs: 90_000, reason: 'busy' });
  });

  it('holds everyone off for the penalty once the server has refused us', async () => {
    // A window alone cannot describe beanfun. A refusal costs a fixed 4-5
    // minutes, and our window is only a model of the server's counter — it
    // resets when the process does, the server's does not. Production queued
    // 54.9s under a perfectly healthy-looking window and was rate-limited on
    // arrival anyway.
    const gate = gateOf(4, 90_000, 600_000);
    expect((await gate.acquire()).ok).toBe(true);
    gate.penalise(5 * 60_000);
    const turn = await gate.acquire();
    expect(turn).toMatchObject({ ok: true, waitedMs: 5 * 60_000 });
  });

  it('calls a penalty what it is, so the caller can say so', async () => {
    const gate = gateOf(4, 90_000, 10_000);
    gate.penalise(5 * 60_000);
    expect(await gate.acquire()).toMatchObject({ ok: false, reason: 'blocked' });
  });

  it('never lets a later report shorten a penalty already running', () => {
    // Blocked requests were measured not to extend the penalty, so reports can
    // arrive late and out of order. Taking the max means a stale one cannot
    // release everybody early into a wall that is still standing.
    const gate = gateOf(4, 90_000, 600_000);
    gate.penalise(5 * 60_000);
    gate.penalise(1_000);
    expect(gate.projectedWaitMs()).toBeGreaterThan(4 * 60_000);
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
      // Drain whatever the module-level boot seed is still holding, so the
      // assertion below does not depend on how long ago this file was imported.
      const first = getSessionKey(client);
      await vi.advanceTimersByTimeAsync(OUR_WINDOW_MS);
      expect(await first).toBe('abc123');

      // The point of the rewrite: the next caller waits rather than being turned
      // away. Asserting it is still unsettled is what separates "queued" from
      // both "served" and "refused" — the earlier budget threw here.
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
