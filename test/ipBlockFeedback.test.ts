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
 * Its own file because the budget is module state — a fresh registry per test
 * file is what keeps this measurement from inheriting another one's.
 */
import { describe, expect, it, vi } from 'vitest';

import type { BeanfunClient } from '../src/beanfun/client.js';
import { getSessionKey, QR_MIN_INTERVAL_MS } from '../src/beanfun/login/sessionKey.js';

/** The real page's identifying sentence; the file name lives only on the URL. */
const BLOCK_PAGE = '<html><body>但由於短時間造訪過於頻繁，IP已自動被系統鎖定。</body></html>';
const BLOCK_URL = 'https://tw.beanfun.com/TW/BlockIPMessage.htm';

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
    // Fake timers because the limiter starts a boot spent: the first mint after
    // a process starts waits one interval by design, and a test that let that
    // elapse for real would take 30 seconds.
    vi.useFakeTimers();
    let calls = 0;
    const client = {
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
    } as unknown as BeanfunClient;

    try {
      const first = settle(getSessionKey(client));
      await vi.advanceTimersByTimeAsync(QR_MIN_INTERVAL_MS);
      const r1 = await first;
      expect(r1.ok).toBe(false);
      expect(r1.error).toMatchObject({ code: 'http.ip_blocked' });
      expect(calls).toBe(1);

      // The gate now knows. The next caller must be refused by us, not beanfun:
      // the penalty outruns the queue deadline, so it never reaches the wire.
      const second = settle(getSessionKey(client));
      await vi.advanceTimersByTimeAsync(0);
      const r2 = await second;
      expect(r2.ok).toBe(false);
      expect(r2.error).toMatchObject({ code: 'http.ip_blocked' });
      expect(calls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('tells the caller how much of the penalty is left', async () => {
    // "about 5 minutes" is a guess repeated forever; the remainder is the thing
    // a user can actually act on, and after the first refusal we know it.
    const client = {
      http: {
        get: (url: string) =>
          Promise.resolve({ statusCode: 200, body: BLOCK_PAGE, url, redirectUrls: [BLOCK_URL] }),
      },
    } as unknown as BeanfunClient;

    // Fake timers here too: run on its own (`-t`), this test would otherwise be
    // the one paying the boot interval, in real seconds.
    vi.useFakeTimers();
    try {
      const pending = settle(getSessionKey(client));
      await vi.advanceTimersByTimeAsync(QR_MIN_INTERVAL_MS);
      const { error } = await pending;
      expect((error as { retryAfterMs?: number }).retryAfterMs).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
