/**
 * What the limiter learns from being refused.
 *
 * Its own window is a model of beanfun's counter, not the counter itself, and
 * the two drift: ours resets when the process does, the server's does not. On
 * top of that a refusal costs a fixed 4-5 minute penalty that no amount of
 * window arithmetic describes. Production showed both at once — a login queued
 * 54.9s under a window that looked perfectly healthy, fired, and was
 * rate-limited on arrival.
 *
 * Being refused is the one moment the model is known to be wrong, so it has to
 * be fed back. The assertion with teeth here is the request count: a gate that
 * merely reported the block would let every later caller spend another doomed
 * request to rediscover it.
 *
 * ## Every test takes a fresh module, and that is load-bearing
 *
 * The budget is module state, so a penalty raised by one test is still standing
 * in the next one. Both tests below used to share it, and the second was passing
 * for the wrong reason entirely: it asserted a caller is told how long is left,
 * and that was only true because the FIRST test had already put the gate into a
 * penalty. On its own it failed, and `--sequence.shuffle` failed both. A file
 * whose subject is stateful feedback cannot also be the file that shares state
 * between its cases.
 */
import { describe, expect, it, vi } from 'vitest';

import type { BeanfunClient } from '../src/beanfun/client.js';

/** The real page's identifying sentence; the file name lives only on the URL. */
const BLOCK_PAGE = '<html><body>但由於短時間造訪過於頻繁，IP已自動被系統鎖定。</body></html>';
const BLOCK_URL = 'https://tw.beanfun.com/TW/BlockIPMessage.htm';

/**
 * A limiter with no history, plus the constants that belong to it.
 *
 * Fake timers are installed BEFORE the import on purpose: the module spends a
 * slot at load time (the boot seed), and that slot has to be stamped with the
 * same clock the test then advances.
 */
async function freshLimiter(): Promise<typeof import('../src/beanfun/login/sessionKey.js')> {
  vi.useFakeTimers();
  vi.resetModules();
  return import('../src/beanfun/login/sessionKey.js');
}

/** Answers every request with the block page, and counts how many it got. */
function blockingClient(): { client: BeanfunClient; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    client: {
      http: {
        get: (url: string) => {
          calls += 1;
          return Promise.resolve({
            statusCode: 200,
            body: BLOCK_PAGE,
            url,
            redirectUrls: [BLOCK_URL],
          });
        },
      },
    } as unknown as BeanfunClient,
  };
}

/**
 * Start a call and attach its handler in the same tick.
 *
 * `expect(p).rejects` attaches nothing until the matcher runs, and these
 * rejections land *while* fake timers are being advanced — so the promise is
 * briefly unhandled. Vitest reports that as an unhandled rejection and exits
 * non-zero even though every assertion passed, which is how it reached CI: a
 * local check that grepped for failed tests rather than reading the exit code
 * saw nothing wrong.
 */
function settle<T>(p: Promise<T>): Promise<{ ok: boolean; error?: unknown }> {
  return p.then(
    () => ({ ok: true }),
    (error: unknown) => ({ ok: false, error }),
  );
}

describe('after beanfun refuses us', () => {
  it('stops firing requests that are already known to fail', async () => {
    const { getSessionKey, QR_MIN_INTERVAL_MS } = await freshLimiter();
    const { client, calls } = blockingClient();

    try {
      const first = settle(getSessionKey(client));
      // The boot seed: the first mint after a process starts waits one interval
      // by design, and letting that elapse for real would take 30 seconds.
      await vi.advanceTimersByTimeAsync(QR_MIN_INTERVAL_MS);
      const r1 = await first;
      expect(r1.ok).toBe(false);
      expect(r1.error).toMatchObject({ code: 'http.ip_blocked' });
      expect(calls()).toBe(1);

      // The gate now knows. The next caller must be refused by us, not beanfun:
      // the penalty outruns the queue deadline, so it never reaches the wire.
      const second = settle(getSessionKey(client));
      await vi.advanceTimersByTimeAsync(0);
      const r2 = await second;
      expect(r2.ok).toBe(false);
      expect(r2.error).toMatchObject({ code: 'http.ip_blocked' });
      expect(calls()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('tells the caller who tripped the block how long it lasts', async () => {
    // "about 5 minutes" is a guess repeated forever; the remainder is the thing
    // a user can act on. This caller is the one certain to be looking at the
    // screen right now, and it used to be the only one NOT told — the error came
    // straight off `assertNotIpBlocked`, which inspects a response and so cannot
    // know about a budget, even though `penalise()` had already run one line up.
    const { getSessionKey, QR_MIN_INTERVAL_MS, IP_BLOCK_PENALTY_MS } = await freshLimiter();
    const { client } = blockingClient();

    try {
      const pending = settle(getSessionKey(client));
      await vi.advanceTimersByTimeAsync(QR_MIN_INTERVAL_MS);
      const { error } = await pending;
      expect((error as { retryAfterMs?: number }).retryAfterMs).toBe(IP_BLOCK_PENALTY_MS);
    } finally {
      vi.useRealTimers();
    }
  });

  it('counts the penalty down rather than repeating the nominal figure', async () => {
    // The difference between a remainder and a constant. Told "5 分鐘" four
    // minutes into a five-minute block, a user waits five more — and a wait
    // that is always wrong in the same direction is how people learn to ignore
    // the number and just retry, which is the one thing the block punishes.
    const { getSessionKey, QR_MIN_INTERVAL_MS, IP_BLOCK_PENALTY_MS } = await freshLimiter();
    const { client, calls } = blockingClient();

    try {
      const first = settle(getSessionKey(client));
      await vi.advanceTimersByTimeAsync(QR_MIN_INTERVAL_MS);
      await first;

      const ELAPSED_MS = 60_000;
      await vi.advanceTimersByTimeAsync(ELAPSED_MS);
      const later = settle(getSessionKey(client));
      await vi.advanceTimersByTimeAsync(0);
      const { error } = await later;

      expect((error as { retryAfterMs?: number }).retryAfterMs).toBe(
        IP_BLOCK_PENALTY_MS - ELAPSED_MS,
      );
      // ...and it learned that without spending a request to re-ask.
      expect(calls()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
