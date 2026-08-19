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
const getSessionKey = vi.hoisted(() =>
  vi.fn((): Promise<string> => Promise.reject(new Error('network is disabled in this test'))),
);
vi.mock('../src/beanfun/login/sessionKey.js', () => ({
  getSessionKey,
  projectedQrWait: () => ({ waitMs: 0, ahead: 0 }),
  QR_QUEUE_MAX_WAIT_MS: 120_000,
}));

import type { QrLoginInit } from '../src/beanfun/types.js';
import { SessionManager } from '../src/core/sessionManager.js';
import { beginLogin, handleLogin, makeReplyDeliver } from '../src/discord/flow.js';

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

/**
 * The interaction's single reply slot.
 *
 * A queued login spends it on the "please wait" notice, so the message that
 * follows — very often the one explaining why the login then FAILED — must be a
 * follow-up. Shipping it as a second `reply()` throws "already sent or
 * deferred", and because that throw happens inside the error handler it
 * replaces the real error with an opaque internal-error notice. Seen in
 * production 2026-08-19: `initQrLogin` failed after a 52.5s queue and the only
 * trace left anywhere was the reply-slot complaint.
 */
describe('makeReplyDeliver', () => {
  const fake = (): { interaction: ChatInputCommandInteraction; calls: string[] } => {
    const calls: string[] = [];
    const interaction = {
      reply: () => {
        calls.push('reply');
        return Promise.resolve(message('r'));
      },
      editReply: () => {
        calls.push('editReply');
        return Promise.resolve(message('r'));
      },
      followUp: () => {
        calls.push('followUp');
        return Promise.resolve(message('f'));
      },
      deferReply: () => {
        calls.push('deferReply');
        return Promise.resolve(message('r'));
      },
      fetchReply: () => Promise.resolve(message('r')),
    } as unknown as ChatInputCommandInteraction;
    return { interaction, calls };
  };

  it('replies once, then follows up — never replies twice', async () => {
    const f = fake();
    const deliver = makeReplyDeliver(f.interaction);
    await deliver({ content: 'queued' });
    await deliver({ content: 'and here is why it failed' });
    expect(f.calls).toEqual(['reply', 'followUp']);
  });

  it('edits the deferral first, then follows up', async () => {
    vi.useFakeTimers();
    const f = fake();
    const deliver = makeReplyDeliver(f.interaction);
    await vi.advanceTimersByTimeAsync(3_000); // the 2.6s deferral fires
    await deliver({ content: 'queued' });
    await deliver({ content: 'and here is why it failed' });
    expect(f.calls).toEqual(['deferReply', 'editReply', 'followUp']);
  });
});

/** A slash command in the bot's own DM, recording what it was answered with. */
function slashCommand(userId: string): {
  interaction: ChatInputCommandInteraction;
  answers: string[];
} {
  const answers: string[] = [];
  const interaction = {
    user: { id: userId, createDM: () => Promise.resolve({ send: () => Promise.resolve(message('d')) }) },
    context: InteractionContextType.BotDM,
    reply: (p: BaseMessageOptions) => {
      answers.push(String(p.content ?? '<payload>'));
      return Promise.resolve(message('r'));
    },
    editReply: () => Promise.resolve(message('r')),
    followUp: () => Promise.resolve(message('f')),
    deferReply: () => Promise.resolve(message('r')),
    fetchReply: () => Promise.resolve(message('r')),
  } as unknown as ChatInputCommandInteraction;
  return { interaction, answers };
}

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('/login pressed again while one is still fetching a QR', () => {
  it('answers at once instead of parking behind the lock', async () => {
    // The lock is held for the whole pSKey queue wait. Parked presses sat on
    // Discord's "thinking" state for 54 seconds in production, then resolved
    // into QR messages that deleted each other via setActive — all to re-show a
    // challenge that arrives as its own message anyway.
    getSessionKey.mockImplementation(() => new Promise<string>(() => undefined));
    const manager = new SessionManager();

    const first = slashCommand('u2');
    void handleLogin(manager, first.interaction);
    await flush();

    const second = slashCommand('u2');
    await handleLogin(manager, second.interaction);

    expect(second.answers).toHaveLength(1);
    expect(second.answers[0]).toContain('已經有一個登入正在進行中');
  });

  it('lets the next login through once the first one is done', async () => {
    // The flag must not outlive the attempt, or one failure locks the user out
    // of logging in for as long as the process runs.
    getSessionKey.mockImplementation(() => Promise.reject(new Error('nope')));
    const manager = new SessionManager();

    const first = slashCommand('u3');
    await handleLogin(manager, first.interaction);
    await flush();

    const second = slashCommand('u3');
    await handleLogin(manager, second.interaction);
    expect(second.answers.join('')).not.toContain('已經有一個登入正在進行中');
  });
});
