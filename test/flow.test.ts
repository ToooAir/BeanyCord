/**
 * The "ghost session" regression and its counterweight.
 *
 * Ghost: when Beanfun kills a session, the OTP path used to *announce* the death
 * ("🔒 登入已失效") without dropping it, so /status still answered "✅ 已登入".
 *
 * Counterweight: the OTP path's death signal is a guess. `game_start_step2.aspx`
 * answers a dead session with a generic "程式發生錯誤" page (see
 * test/fixtures/game_start_step2.session-dead.txt) that a transient server fault
 * produces too — so a claimed death must be confirmed against echo_token before
 * we log a live user out.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { BeanfunError } from '../src/beanfun/errors.js';
import { SessionManager } from '../src/core/sessionManager.js';
import type { BeanfunClient } from '../src/beanfun/client.js';
import type { ServiceAccount, Session } from '../src/beanfun/types.js';

const getOtp = vi.hoisted(() => vi.fn());
vi.mock('../src/beanfun/otp.js', () => ({ getOtp }));

const { deliverOtp } = await import('../src/discord/flow.js');

const ACCOUNT: ServiceAccount = { sid: 'sid-1', sname: 'acct' } as ServiceAccount;

/** The real dead-session page the OTP step-1 check has to work from. */
const ERR_MSG_PAGE = readFileSync(
  fileURLToPath(new URL('./fixtures/game_start_step2.session-dead.txt', import.meta.url)),
  'utf8',
);

/** A manager holding one logged-in user, with a ping we control. */
function loggedIn(userId: string, ping: () => Promise<void>): SessionManager {
  const manager = new SessionManager();
  const state = manager.getOrCreate(userId);
  state.session = {
    region: 'TW',
    skey: 'k',
    webToken: 't',
    accountId: '',
    serviceCode: 'code',
    serviceRegion: 'region',
  } satisfies Session;
  state.accounts = [ACCOUNT];
  state.client = { ping } as unknown as BeanfunClient;
  return manager;
}

async function runOtp(manager: SessionManager, userId: string): Promise<string> {
  const sent: string[] = [];
  await deliverOtp(manager, userId, ACCOUNT.sid, async (p) => {
    sent.push(String(p.content));
    return {} as never;
  });
  return sent.join('');
}

const loggedOut = () => Promise.reject(new BeanfunError('session.logged_out', 'gone'));
const alive = () => Promise.resolve();

describe('deliverOtp — session death', () => {
  it('drops the session once echo_token confirms it is gone', async () => {
    const manager = loggedIn('u1', loggedOut);
    getOtp.mockRejectedValueOnce(new BeanfunError('otp.session_expired', 'gone'));

    expect(await runOtp(manager, 'u1')).toContain('登入已失效');
    expect(manager.isLoggedIn('u1')).toBe(false);
    expect(manager.activeSessionCount()).toBe(0);
  });

  it('keeps a live session when the OTP page lied about the death', async () => {
    // The "程式發生錯誤" page means "no OTP right now", not necessarily "logged
    // out" — dropping on it would log out a user whose session is fine.
    expect(ERR_MSG_PAGE).toContain('程式發生錯誤');
    const manager = loggedIn('u2', alive);
    getOtp.mockRejectedValueOnce(new BeanfunError('otp.session_expired', 'gone'));

    expect(await runOtp(manager, 'u2')).toContain('登入仍然有效');
    expect(manager.isLoggedIn('u2')).toBe(true);
  });

  it('keeps the session when the confirmation itself cannot be reached', async () => {
    const manager = loggedIn('u3', () => Promise.reject(new Error('ETIMEDOUT')));
    getOtp.mockRejectedValueOnce(new BeanfunError('otp.session_expired', 'gone'));

    expect(await runOtp(manager, 'u3')).toContain('登入仍然有效');
    expect(manager.isLoggedIn('u3')).toBe(true);
  });

  it('trusts session.logged_out without a second round-trip', async () => {
    const ping = vi.fn(alive); // would say "alive" — must not be consulted
    const manager = loggedIn('u4', ping);
    getOtp.mockRejectedValueOnce(new BeanfunError('session.logged_out', 'gone'));

    expect(await runOtp(manager, 'u4')).toContain('登入已失效');
    expect(ping).not.toHaveBeenCalled();
    expect(manager.isLoggedIn('u4')).toBe(false);
  });

  it('keeps the session for a transient failure', async () => {
    const manager = loggedIn('u5', alive);
    getOtp.mockRejectedValueOnce(new BeanfunError('http.non_success', 'blip'));

    expect(await runOtp(manager, 'u5')).toContain('取得 OTP 失敗');
    expect(manager.isLoggedIn('u5')).toBe(true);
  });
});
