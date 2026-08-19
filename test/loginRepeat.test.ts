/**
 * Pressing /login twice in a row.
 *
 * Reported as "the application did not respond" on the second press, which
 * turned out to be the visible half of something worse. `handleLogin` built its
 * deliverer — and with it the 2.6s deferral that keeps a Discord interaction
 * alive — INSIDE the callback passed to the per-user lock, so nothing armed
 * until the lock was free. A first login takes three round trips, and with the
 * shared pSKey queue it can take much longer, so the second interaction
 * routinely blew Discord's three-second budget.
 *
 * Meanwhile the queued second run went ahead anyway: `sendFreshQr` opens with
 * `resetClient`, which replaces the cookie jar the pending challenge belongs to.
 * So the QR still on screen was already dead — scanning it did nothing — and a
 * second pSKey was spent out of a budget shared with every other user, to
 * produce a QR that could no longer be delivered.
 */
import { InteractionContextType } from 'discord.js';
import type { BaseMessageOptions, ChatInputCommandInteraction, DMChannel, Message } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

// A regression in the reuse path sends `beginLogin` down `sendFreshQr`, which
// would mint a real pSKey against the live server — spending from a budget
// shared with actual users, from a test run. Cut the wire so a regression fails
// fast and offline instead.
vi.mock('../src/beanfun/login/sessionKey.js', () => ({
  getSessionKey: () => Promise.reject(new Error('network is disabled in this test')),
  projectedQrWait: () => ({ waitMs: 0, ahead: 0 }),
  QR_QUEUE_MAX_WAIT_MS: 120_000,
}));

import type { QrLoginInit } from '../src/beanfun/types.js';
import { SessionManager } from '../src/core/sessionManager.js';
import { beginLogin, handleLogin } from '../src/discord/flow.js';

afterEach(() => {
  vi.useRealTimers();
});

const message = (id: string): Message => ({ id }) as Message;

const PENDING: QrLoginInit = {
  skey: 'skey-1',
  bitmapBase64: 'data:image/png;base64,aGk=',
  deeplink: null,
  appLink: null,
  verificationToken: '',
};

describe('a second /login while the first is still working', () => {
  it('acknowledges the interaction even though the lock is held', async () => {
    vi.useFakeTimers();
    const manager = new SessionManager();
    // The first login, still in flight and holding the user's lock.
    void manager.withLock('u1', () => new Promise<void>(() => undefined));

    const deferReply = vi.fn(() => Promise.resolve(message('r')));
    const interaction = {
      user: { id: 'u1', createDM: () => Promise.resolve({} as DMChannel) },
      context: InteractionContextType.BotDM,
      deferReply,
      reply: vi.fn(),
      editReply: vi.fn(),
      fetchReply: vi.fn(),
    } as unknown as ChatInputCommandInteraction;

    void handleLogin(manager, interaction);
    // Discord discards an interaction that is unacknowledged for three seconds.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(deferReply).toHaveBeenCalledTimes(1);
  });

  it('re-sends the challenge already in flight instead of replacing it', async () => {
    const manager = new SessionManager();
    manager.getOrCreate('u1').pendingInit = PENDING;
    const reset = vi.spyOn(manager, 'resetClient');

    const delivered: BaseMessageOptions[] = [];
    await beginLogin(manager, 'u1', {} as DMChannel, (p) => {
      delivered.push(p);
      return Promise.resolve(message('m2'));
    });

    // `resetClient` is the destructive part: it swaps the cookie jar the pending
    // QR was issued against, so the QR on screen stops working with no symptom.
    expect(reset).not.toHaveBeenCalled();
    expect(manager.get('u1')?.pendingInit).toBe(PENDING);

    // ...and the user gets the same challenge back, not a newly minted one.
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.files).toHaveLength(1);
  });
});
