/**
 * A dead Beanfun session comes back as an HTTP 200 login page, so every
 * "parse it and see" path can quietly degrade into an empty result instead of
 * an error. These are the paths the sweep found still doing that:
 *
 *  - getAccounts -> [] -> the DM claimed "沒有任何服務帳號" (accounts vanished!)
 *  - listGames   -> [] -> an empty select menu the Discord API then rejects,
 *                         so the user's "reason" was a DiscordAPIError
 *  - beginLogin  -> announced the death without dropping the session, leaving a
 *                   ghost in /status (the same defect as deliverOtp had)
 */
import { describe, expect, it, vi } from 'vitest';

import { getAccounts } from '../src/beanfun/account.js';
import type { BeanfunClient } from '../src/beanfun/client.js';
import { BeanfunError } from '../src/beanfun/errors.js';
import { listGames } from '../src/beanfun/games.js';
import { SessionManager } from '../src/core/sessionManager.js';
import type { DMChannel, Message } from 'discord.js';
import type { Session } from '../src/beanfun/types.js';

const LOGIN_PAGE =
  '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN">\n' +
  '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>登入</title></head><body></body></html>';

const SESSION: Session = {
  region: 'TW',
  skey: 'k',
  webToken: 't',
  accountId: '',
  serviceCode: 'code',
  serviceRegion: 'region',
};

/** Minimal stand-in for BeanfunClient: every GET answers 200 + `body`. */
function clientReturning(body: string): BeanfunClient {
  return {
    readBfWebToken: async () => 'token',
    http: { get: async () => ({ statusCode: 200, body, url: 'https://tw.beanfun.com/' }) },
  } as unknown as BeanfunClient;
}

describe('a login page must never look like an empty result', () => {
  it('getAccounts throws session.expired instead of reporting zero accounts', async () => {
    await expect(
      getAccounts(clientReturning(LOGIN_PAGE), SESSION, 'code', 'region'),
    ).rejects.toMatchObject({ code: 'session.expired' });
  });

  it('listGames throws session.expired instead of building an empty menu', async () => {
    await expect(listGames(clientReturning(LOGIN_PAGE))).rejects.toMatchObject({
      code: 'session.expired',
    });
  });

  it('keeps the original parse error when the body is not a login page', async () => {
    // A real format change must stay distinguishable from a dead session.
    await expect(listGames(clientReturning('nothing parseable here'))).rejects.toThrowError(
      /GameListServiceListMissing/,
    );
  });

  it('reports a genuinely empty catalogue distinctly', async () => {
    const empty = 'var x=1; Services.ServiceList = [];';
    await expect(listGames(clientReturning(empty))).rejects.toMatchObject({
      code: 'games.empty_catalogue',
    });
  });
});

describe('beginLogin — session death', () => {
  it('drops the session so /status stops reporting a corpse', async () => {
    const manager = new SessionManager();
    manager.getOrCreate('u1').session = SESSION;
    // The resumed session is dead: the game-catalogue fetch proves it.
    manager.get('u1')!.client = clientReturning(LOGIN_PAGE);

    const sent: string[] = [];
    const deliver = vi.fn(async (p: { content?: string }) => {
      sent.push(String(p.content));
      return { id: 'm1' } as Message;
    });

    const { beginLogin } = await import('../src/discord/flow.js');
    await beginLogin(manager, 'u1', {} as DMChannel, deliver as never);

    expect(sent.join('')).toContain('登入已失效');
    expect(manager.isLoggedIn('u1')).toBe(false);
    expect(manager.activeSessionCount()).toBe(0);
  });

  it('keeps the session when the catalogue fetch fails transiently', async () => {
    const manager = new SessionManager();
    manager.getOrCreate('u2').session = SESSION;
    manager.get('u2')!.client = {
      readBfWebToken: async () => 'token',
      http: {
        get: async () => {
          throw new BeanfunError('http.non_success', 'game_zone/ returned HTTP 502');
        },
      },
    } as unknown as BeanfunClient;

    const sent: string[] = [];
    const deliver = vi.fn(async (p: { content?: string }) => {
      sent.push(String(p.content));
      return { id: 'm2' } as Message;
    });

    const { beginLogin } = await import('../src/discord/flow.js');
    await beginLogin(manager, 'u2', {} as DMChannel, deliver as never);

    expect(sent.join('')).toContain('似乎已失效');
    expect(manager.isLoggedIn('u2')).toBe(true);
  });
});
