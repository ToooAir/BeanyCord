/**
 * The "ghost session" regression: when Beanfun kills a session server-side, the
 * OTP path used to *announce* the death ("🔒 登入已失效") without dropping it.
 * The corpse stayed in the manager, so /status still answered "✅ 已登入" and
 * kept counting it in activeSessionCount() a minute later.
 */
import { describe, expect, it, vi } from 'vitest';

import { BeanfunError } from '../src/beanfun/errors.js';
import { SessionManager } from '../src/core/sessionManager.js';
import type { ServiceAccount, Session } from '../src/beanfun/types.js';

const getOtp = vi.hoisted(() => vi.fn());
vi.mock('../src/beanfun/otp.js', () => ({ getOtp }));

const { deliverOtp } = await import('../src/discord/flow.js');

const ACCOUNT: ServiceAccount = { sid: 'sid-1', sname: 'acct' } as ServiceAccount;

/** A manager holding one logged-in user, primed so deliverOtp reaches getOtp. */
function loggedIn(userId: string): SessionManager {
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
  return manager;
}

describe('deliverOtp — session death', () => {
  it('drops the session so /status stops reporting a corpse', async () => {
    const manager = loggedIn('u1');
    getOtp.mockRejectedValueOnce(new BeanfunError('otp.session_expired', 'gone'));
    const sent: string[] = [];

    await deliverOtp(manager, 'u1', ACCOUNT.sid, async (p) => {
      sent.push(String(p.content));
      return {} as never;
    });

    expect(sent.join('')).toContain('登入已失效');
    expect(manager.isLoggedIn('u1')).toBe(false);
    expect(manager.activeSessionCount()).toBe(0);
  });

  it('keeps the session for a transient failure', async () => {
    const manager = loggedIn('u2');
    getOtp.mockRejectedValueOnce(new BeanfunError('http.non_success', 'blip'));
    const sent: string[] = [];

    await deliverOtp(manager, 'u2', ACCOUNT.sid, async (p) => {
      sent.push(String(p.content));
      return {} as never;
    });

    expect(sent.join('')).toContain('取得 OTP 失敗');
    expect(manager.isLoggedIn('u2')).toBe(true);
    expect(manager.activeSessionCount()).toBe(1);
  });
});
