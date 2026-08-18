/**
 * QR init, and the one thing about it that can fail silently.
 *
 * On a phone the QR code is unscannable — it is on the screen you are holding —
 * so the deep link is the entire mobile login path. Discord can only render it
 * as a link button, and only from the https form the Beanfun app claims in its
 * app-link manifests. Build that form from a scheme and path beanfun controls
 * and could rename, and the failure mode is a QR message with no button and no
 * error: mobile login just stops working.
 *
 * Hence the warning. These tests exist because the alternative to them is
 * finding out from a user who says "it doesn't work on my phone".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { BeanfunClient } from '../src/beanfun/client.js';
import { initQrLogin } from '../src/beanfun/login/qrInit.js';

const KNOWN = 'gameplapp://gameplhost/deeplink?type=1&action=web&code=AbC%2Bd';

/** Answers Login/Index with a page and Login/InitLogin with this DeepLink. */
function fakeClient(deepLink: string): BeanfunClient {
  return {
    http: {
      get: (url: string) =>
        Promise.resolve({
          statusCode: 200,
          url,
          body: url.includes('InitLogin')
            ? JSON.stringify({ Result: 0, ResultData: { QRImage: 'aGk=', DeepLink: deepLink } })
            : '<input name="__RequestVerificationToken" value="tok" />',
        }),
    },
  } as unknown as BeanfunClient;
}

let warned: string[];
beforeEach(() => {
  warned = [];
  vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => void warned.push(a.map(String).join(' ')));
});

describe('initQrLogin — the mobile path', () => {
  it('carries both the raw scheme and the tappable https form', async () => {
    const init = await initQrLogin(fakeClient(KNOWN), 'skey');
    expect(init.deeplink).toBe(KNOWN);
    expect(init.appLink).toBe('https://play.games.gamania.com/deeplink?type=1&action=web&code=AbC%2Bd');
    expect(warned).toEqual([]);
  });

  it('says so loudly when the deep link stops being the shape we can linkify', async () => {
    // Beanfun renaming the scheme or the path is invisible otherwise: the button
    // is simply absent, and nothing anywhere says why.
    const init = await initQrLogin(fakeClient('beanfunapp://elsewhere/launch?code=x'), 'skey');
    expect(init.appLink).toBeNull();
    expect(init.deeplink).toBe('beanfunapp://elsewhere/launch?code=x');
    expect(warned.join('\n')).toMatch(/no tappable button/);
    // The scheme is the first thing to look at, so it has to be in the line.
    expect(warned.join('\n')).toContain('beanfunapp:');
  });

  it('stays quiet when there is no deep link at all', async () => {
    // Nothing was lost, so there is nothing to report — a warning here would
    // fire on every login that beanfun simply did not offer a deep link for.
    const init = await initQrLogin(fakeClient(''), 'skey');
    expect(init.deeplink).toBeNull();
    expect(init.appLink).toBeNull();
    expect(warned).toEqual([]);
  });
});
