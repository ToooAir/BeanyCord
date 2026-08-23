/**
 * The one security boundary in this repo.
 *
 * Nothing else here guards anything: cross-user OTP theft is impossible by
 * construction (per-user cookie jars, secrets only ever sent to the invoking
 * user's own DM), so what this gate protects is the HOST — its IP, which beanfun
 * rations per address, and its bandwidth. A stranger who gets through does not
 * steal anyone's account; they spend everyone's login budget.
 *
 * It had no tests at all until now, because every part of it was module-private
 * inside `bot.ts` behind `createBot`, which needs a real Discord client. That is
 * the thing `access.ts` fixed; these are what the split was for.
 *
 * The load-bearing case is `refuses even a CORRECT code during a lockout`, and
 * more precisely the one after it: the two answers must be byte-identical. A
 * lockout that still says "wrong code" versus "locked out" IS an oracle — an
 * attacker who can tell those apart gets a free confirmation per lock, which is
 * exactly what the lockout was supposed to cost them.
 */
import { describe, expect, it } from 'vitest';

import type { BaseInteraction } from 'discord.js';

import {
  createAccess,
  gateLogin,
  isAuthorized,
  isGated,
  LOCKOUT_OPTIONS,
  parseAllowlist,
  safeEqual,
  type AccessControl,
} from '../src/discord/access.js';
import type { SessionStore } from '../src/core/store.js';

const CODE = 'let-me-in-2026';

/** Records what was enrolled, so persistence can be asserted separately from
 *  the in-memory set — a restart is exactly when the difference shows up. */
function fakeStore(initial: string[] = []): { store: SessionStore; enrolled: string[] } {
  const enrolled = [...initial];
  return {
    enrolled,
    store: {
      loadEnrolledIds: () => [...enrolled],
      enroll: (id: string) => void (enrolled.includes(id) || enrolled.push(id)),
    } as unknown as SessionStore,
  };
}

/** A clock the test moves by hand — the seam `core/guard.ts` already offers. */
function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => void (t += ms) };
}

const actor = (userId: string): BaseInteraction => ({ user: { id: userId } }) as BaseInteraction;

/** An interaction whose guild really answers, counting the member fetches so
 *  caching can be observed rather than assumed. */
function guildActor(
  userId: string,
  guildId: string,
  members: string[],
): { interaction: BaseInteraction; fetches: () => number } {
  let fetches = 0;
  const guild = {
    members: {
      fetch: (id: string) => {
        fetches += 1;
        return members.includes(id)
          ? Promise.resolve({})
          : Promise.reject(new Error('Unknown Member'));
      },
    },
  };
  return {
    fetches: () => fetches,
    interaction: {
      user: { id: userId },
      client: { guilds: { cache: { get: () => guild }, fetch: () => Promise.resolve(guild) } },
    } as unknown as BaseInteraction,
  };
}

/** Access config built straight from an env shape, no process.env involved. */
const access = (
  env: Record<string, string>,
  store: SessionStore | null = null,
  now: () => number = Date.now,
): AccessControl => createAccess(store, env as NodeJS.ProcessEnv, now);

describe('parseAllowlist', () => {
  it('accepts snowflakes separated by commas, spaces or newlines', () => {
    expect(parseAllowlist('111, 222\n333  444')).toEqual(new Set(['111', '222', '333', '444']));
  });

  it('drops anything that is not a snowflake', () => {
    // A typo must not survive as an entry that can never match: it would make
    // the startup line report a gate that is really just one id short.
    expect(parseAllowlist('111, @someone, <@222>, 333')).toEqual(new Set(['111', '333']));
  });

  it('is empty for unset or blank config', () => {
    expect(parseAllowlist(undefined).size).toBe(0);
    expect(parseAllowlist('   ').size).toBe(0);
  });
});

describe('safeEqual', () => {
  it('accepts an exact match and rejects anything else', () => {
    expect(safeEqual(CODE, CODE)).toBe(true);
    expect(safeEqual(`${CODE}x`, CODE)).toBe(false);
    expect(safeEqual('', CODE)).toBe(false);
  });

  it('rejects a correct prefix, which is the attack it exists to stop', () => {
    expect(safeEqual(CODE.slice(0, -1), CODE)).toBe(false);
  });

  it('handles a multi-byte code without throwing on the length check', () => {
    // `timingSafeEqual` compares BYTES. A code of Chinese characters has a
    // byte length three times its character length, and a naive implementation
    // that measured `.length` would compare buffers of different sizes and
    // throw — turning a wrong guess into a crashed interaction.
    expect(safeEqual('通關密語', '通關密語')).toBe(true);
    expect(safeEqual('通關密碼', '通關密語')).toBe(false);
    expect(() => safeEqual('ab', '通關密語')).not.toThrow();
  });
});

describe('when nothing is configured', () => {
  it('is open, and says so', async () => {
    // Deliberate: an unconfigured deployment must still work. It is warned about
    // loudly at startup instead (see createBot).
    const a = access({});
    expect(isGated(a)).toBe(false);
    expect(await isAuthorized(a, actor('stranger'))).toBe(true);
    expect(await gateLogin(a, actor('stranger'), null)).toEqual({ ok: true });
  });
});

describe('isAuthorized', () => {
  it('lets an already-enrolled user through', async () => {
    const { store } = fakeStore(['friend']);
    const a = access({ ACCESS_CODE: CODE }, store);
    expect(await isAuthorized(a, actor('friend'))).toBe(true);
    expect(await isAuthorized(a, actor('stranger'))).toBe(false);
  });

  it('lets an explicitly allow-listed id through', async () => {
    const a = access({ ALLOWED_DISCORD_IDS: '111,222' });
    expect(await isAuthorized(a, actor('222'))).toBe(true);
    expect(await isAuthorized(a, actor('333'))).toBe(false);
  });

  it('lets a member of the required guild through', async () => {
    const g = guildActor('member', 'G1', ['member']);
    const a = access({ REQUIRED_GUILD_ID: 'G1' });
    expect(await isAuthorized(a, g.interaction)).toBe(true);
  });

  it('refuses a non-member of the required guild', async () => {
    const g = guildActor('outsider', 'G1', ['member']);
    const a = access({ REQUIRED_GUILD_ID: 'G1' });
    expect(await isAuthorized(a, g.interaction)).toBe(false);
  });

  it('caches a membership hit, so button spam is not a fetch storm', async () => {
    const g = guildActor('member', 'G1', ['member']);
    const a = access({ REQUIRED_GUILD_ID: 'G1' });
    for (let i = 0; i < 5; i++) expect(await isAuthorized(a, g.interaction)).toBe(true);
    expect(g.fetches()).toBe(1);
  });

  it('does NOT cache a miss, so joining the server works on the next click', async () => {
    // Caching a negative would lock a brand-new member out for five minutes
    // with no way to tell why, right at the moment they did the thing they
    // were asked to do.
    const members: string[] = [];
    const g = guildActor('newcomer', 'G1', members);
    const a = access({ REQUIRED_GUILD_ID: 'G1' });

    expect(await isAuthorized(a, g.interaction)).toBe(false);
    members.push('newcomer'); // they join
    expect(await isAuthorized(a, g.interaction)).toBe(true);
    expect(g.fetches()).toBe(2);
  });

  it('does not redeem a code — that is /login only', async () => {
    // Every non-/login command routes through here, and none of them carries a
    // code option. If this path could enroll, a button press would be an
    // enrollment vector.
    const { store, enrolled } = fakeStore();
    const a = access({ ACCESS_CODE: CODE }, store);
    expect(await isAuthorized(a, actor('stranger'))).toBe(false);
    expect(enrolled).toEqual([]);
    expect(a.enrolled.size).toBe(0);
  });
});

describe('gateLogin — redeeming the shared code', () => {
  it('admits a correct code and enrolls the user, in memory and on disk', async () => {
    const { store, enrolled } = fakeStore();
    const a = access({ ACCESS_CODE: CODE }, store);

    expect(await gateLogin(a, actor('friend'), CODE)).toEqual({ ok: true });
    expect(a.enrolled.has('friend')).toBe(true);
    // Persisted too, or they re-enter the code after every deploy — which is
    // the whole reason enrollment exists.
    expect(enrolled).toEqual(['friend']);
  });

  it('tolerates whitespace around a pasted code', async () => {
    const a = access({ ACCESS_CODE: CODE });
    expect(await gateLogin(a, actor('friend'), `  ${CODE}\n`)).toEqual({ ok: true });
  });

  it('lets an enrolled user back in without a code', async () => {
    const a = access({ ACCESS_CODE: CODE });
    await gateLogin(a, actor('friend'), CODE);
    expect(await gateLogin(a, actor('friend'), null)).toEqual({ ok: true });
  });

  it('refuses a wrong code and says so', async () => {
    const a = access({ ACCESS_CODE: CODE });
    const r = await gateLogin(a, actor('stranger'), 'nope');
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain('存取碼錯誤');
  });

  it('asks for a code when none was offered', async () => {
    const a = access({ ACCESS_CODE: CODE });
    const r = await gateLogin(a, actor('curious'), null);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain('需要存取碼');
  });

  it('does not count "no code offered" as a wrong guess', async () => {
    // Otherwise anyone could burn a legitimate user's free attempts by getting
    // them to run `/login` a few times — a lockout you can inflict on someone
    // else is a denial of service wearing a security guard's uniform.
    const c = clock();
    const a = access({ ACCESS_CODE: CODE }, null, c.now);
    for (let i = 0; i < LOCKOUT_OPTIONS.freeAttempts + 3; i++) {
      await gateLogin(a, actor('victim'), null);
    }
    expect(a.lockout.lockedFor('victim')).toBe(0);
    // ...and their first real attempt still works.
    expect(await gateLogin(a, actor('victim'), CODE)).toEqual({ ok: true });
  });

  it('locks a user out after the free attempts are spent', async () => {
    const c = clock();
    const a = access({ ACCESS_CODE: CODE }, null, c.now);

    for (let i = 0; i < LOCKOUT_OPTIONS.freeAttempts; i++) {
      const r = await gateLogin(a, actor('attacker'), `guess-${i}`);
      expect(r.ok === false && r.reason).not.toContain('鎖定');
    }
    const locked = await gateLogin(a, actor('attacker'), 'guess-final');
    expect(locked.ok === false && locked.reason).toContain('鎖定');
  });

  it('refuses even a CORRECT code during a lockout', async () => {
    // The rule the ordering in gateLogin exists for: the lockout is checked
    // BEFORE the comparison. Otherwise the lock only costs an attacker the
    // login, not the answer — they would still learn they had found the code
    // and could simply wait out the timer.
    const c = clock();
    const a = access({ ACCESS_CODE: CODE }, null, c.now);
    for (let i = 0; i <= LOCKOUT_OPTIONS.freeAttempts; i++) {
      await gateLogin(a, actor('attacker'), `guess-${i}`);
    }
    expect(a.lockout.lockedFor('attacker')).toBeGreaterThan(0);

    const r = await gateLogin(a, actor('attacker'), CODE);
    expect(r.ok).toBe(false);
    expect(a.enrolled.has('attacker')).toBe(false);
  });

  it('...and answers a right and a wrong guess identically while locked', async () => {
    // The assertion with teeth. "Refused" is not enough — refusing a correct
    // code with a DIFFERENT message than a wrong one hands back the exact bit
    // the lockout was meant to withhold, one free confirmation per lock.
    const c = clock();
    const a = access({ ACCESS_CODE: CODE }, null, c.now);
    for (let i = 0; i <= LOCKOUT_OPTIONS.freeAttempts; i++) {
      await gateLogin(a, actor('attacker'), `guess-${i}`);
    }

    const right = await gateLogin(a, actor('attacker'), CODE);
    const wrong = await gateLogin(a, actor('attacker'), 'definitely-not-it');

    // Both refusals FIRST, then identical. Comparing them alone is not enough
    // and this test proved it: with the lockout checked after the compare, the
    // correct probe admits and enrolls the attacker, so the second probe sails
    // through `isAuthorized` and the two come back equal — as two successes.
    // The equality held while the property it stands for was gone.
    expect(right.ok).toBe(false);
    expect(wrong.ok).toBe(false);
    expect(right).toEqual(wrong);
    expect(a.enrolled.has('attacker')).toBe(false);
  });

  it('admits the user once the lock expires', async () => {
    // The lock is a delay, not a ban. Someone who mistyped their code twice is
    // far more likely than an attacker, and must not be shut out permanently.
    const c = clock();
    const a = access({ ACCESS_CODE: CODE }, null, c.now);
    for (let i = 0; i <= LOCKOUT_OPTIONS.freeAttempts; i++) {
      await gateLogin(a, actor('typo'), `guess-${i}`);
    }
    expect((await gateLogin(a, actor('typo'), CODE)).ok).toBe(false);

    c.advance(LOCKOUT_OPTIONS.baseLockMs + 1);
    expect(await gateLogin(a, actor('typo'), CODE)).toEqual({ ok: true });
  });

  it('keeps lockouts per user', async () => {
    // A shared code means everyone's guesses land on the same secret; if the
    // lockout were global, one attacker could lock out every friend at once.
    const c = clock();
    const a = access({ ACCESS_CODE: CODE }, null, c.now);
    for (let i = 0; i <= LOCKOUT_OPTIONS.freeAttempts; i++) {
      await gateLogin(a, actor('attacker'), `guess-${i}`);
    }
    expect(await gateLogin(a, actor('bystander'), CODE)).toEqual({ ok: true });
  });

  it('clears the record on success, so an honest typo is not cumulative', async () => {
    const c = clock();
    const a = access({ ACCESS_CODE: CODE }, null, c.now);
    await gateLogin(a, actor('friend'), 'typo');
    await gateLogin(a, actor('friend'), CODE); // in, and forgiven
    a.enrolled.delete('friend'); // simulate a /logout-and-return

    // Back in the free tier: the earlier miss must not count toward this run.
    for (let i = 0; i < LOCKOUT_OPTIONS.freeAttempts; i++) {
      const r = await gateLogin(a, actor('friend'), `typo-${i}`);
      expect(r.ok === false && r.reason).not.toContain('鎖定');
    }
  });

  it('never consults the lockout for a user who is already authorized', async () => {
    // An enrolled user carrying a stale, wrong `code:` option must not be able
    // to lock themselves out of their own account.
    const c = clock();
    const { store } = fakeStore(['friend']);
    const a = access({ ACCESS_CODE: CODE }, store, c.now);
    for (let i = 0; i < LOCKOUT_OPTIONS.freeAttempts + 5; i++) {
      expect(await gateLogin(a, actor('friend'), 'stale-wrong-code')).toEqual({ ok: true });
    }
    expect(a.lockout.lockedFor('friend')).toBe(0);
  });

  it('points at the admin when the gate is not a code at all', async () => {
    // Gated by allow-list / guild only: there is nothing for the user to type,
    // so telling them to supply a code would send them looking for one that
    // does not exist.
    const a = access({ ALLOWED_DISCORD_IDS: '111' });
    const r = await gateLogin(a, actor('stranger'), 'anything');
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain('聯絡管理者');
  });
});
