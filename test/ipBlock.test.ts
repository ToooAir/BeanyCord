/**
 * Recognising beanfun's IP rate-limit page.
 *
 * Measured 2026-08-19 by deliberately tripping it: `bflogin/default.aspx` issues
 * 4 pSKeys per IP per ~5 minutes and answers the 5th with a redirect to
 * `/TW/BlockIPMessage.htm`. It counts requests, not rate — the 5th was refused
 * whether the five took 12s, 35s or 76s — and it is scoped to the IP, confirmed
 * by the same phone being refused on Wi-Fi and served over cellular. Every user
 * of a deployment leaves through one address, so this is a shared budget.
 *
 * The trap these tests exist for is that the page carries its two identifying
 * marks in two different places, and the obvious one is not in the body: the
 * fixture below is the real 544-byte response, and the string "BlockIPMessage"
 * does not appear anywhere in it. A body-only detector reads it as a perfectly
 * ordinary page — which is exactly what shipped before this, where the only
 * symptom was a pSKey that was inexplicably missing.
 */
import { describe, expect, it, vi } from 'vitest';

import type { Response } from 'got';

import type { BeanfunClient } from '../src/beanfun/client.js';
import { assertNotIpBlocked, isIpBlockedPage } from '../src/beanfun/client.js';
import { BeanfunError } from '../src/beanfun/errors.js';
import { getOtp } from '../src/beanfun/otp.js';
import { loginFailureMessage } from '../src/discord/flow.js';
import type { ServiceAccount, Session } from '../src/beanfun/types.js';

/** The real page, byte for byte. Note: no "BlockIPMessage" anywhere in it. */
const BLOCK_PAGE = `﻿<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">

<html xmlns="http://www.w3.org/1999/xhtml">
<head>
    <title>遊戲橘子</title>
</head>
<body>
    <div>
    \t<span style="font-size: 14px">感謝您造訪遊戲橘子</span><br />
\t\t<span style="font-size: 14px">但由於短時間造訪過於頻繁，IP已自動被系統鎖定。</span><br />
\t\t<span style="font-size: 14px">請稍後再試，敬請見諒。</span><br />
    </div>
</body>
</html>`;

const BLOCK_URL = 'https://tw.beanfun.com/TW/BlockIPMessage.htm';
const GOOD_URL = 'https://tw.beanfun.com/beanfun_block/bflogin/default.aspx?pSKey=abc';

const res = (body: string, url: string, redirectUrls?: string[]): Response =>
  ({ statusCode: 200, body, url, redirectUrls }) as unknown as Response;

describe('isIpBlockedPage', () => {
  it('recognises the real page by the sentence in its body', () => {
    expect(isIpBlockedPage(BLOCK_PAGE)).toBe(true);
  });

  it('does not fire on an ordinary portal page', () => {
    expect(isIpBlockedPage('<html><head><title>遊戲橘子</title></head><body>hi</body></html>')).toBe(false);
  });
});

describe('assertNotIpBlocked', () => {
  it('catches the live shape: redirected away, body is the block page', () => {
    // got follows the redirect, so we end up holding the block page itself while
    // the page NAME survives only on the final URL.
    expect(() => assertNotIpBlocked(res(BLOCK_PAGE, GOOD_URL, [BLOCK_URL]), 'default.aspx')).toThrow(
      BeanfunError,
    );
  });

  it('catches a block whose only tell is the redirect target', () => {
    // Deliberately a body with NO block wording — beanfun rewording the page but
    // keeping the filename. Without an innocuous body here this case is covered
    // by the body marker instead, and the URL check is never exercised at all;
    // it passed for that wrong reason until a falsification pass caught it.
    expect(() =>
      assertNotIpBlocked(res('<html>something else entirely</html>', GOOD_URL, [BLOCK_URL]), 'default.aspx'),
    ).toThrow(BeanfunError);
  });

  it('catches a block whose only tell is the body', () => {
    // If beanfun ever renames the file, or serves the page without redirecting,
    // the URL marker is gone. The sentence is the independent second signal.
    expect(() => assertNotIpBlocked(res(BLOCK_PAGE, GOOD_URL), 'default.aspx')).toThrow(BeanfunError);
  });

  it('reports it as a rate limit, not as a generic HTTP failure', () => {
    try {
      assertNotIpBlocked(res(BLOCK_PAGE, BLOCK_URL), 'default.aspx');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as BeanfunError).code).toBe('http.ip_blocked');
    }
  });

  it('stays out of the way of a healthy response', () => {
    expect(() => assertNotIpBlocked(res('<html>fine</html>', GOOD_URL), 'default.aspx')).not.toThrow();
  });

  it('does not throw a TypeError when a response carries no URL', () => {
    // A helper whose whole job is to name a failure must not fail differently.
    expect(() =>
      assertNotIpBlocked({ statusCode: 200, body: '<html>fine</html>' } as unknown as Response, 'x'),
    ).not.toThrow();
  });
});

describe('what the user is told', () => {
  it('offers no retry button when the whole deployment is rate-limited', () => {
    // The budget is shared across every user, so a retry button spends the next
    // person's turn — and the user pressing it is the single worst response to
    // this failure. The absence of `components` here is the actual feature.
    const msg = loginFailureMessage(new BeanfunError('http.ip_blocked', 'default.aspx: rate-limited'));
    expect(msg.components).toBeUndefined();
    expect(msg.content).toContain('5 分鐘');
  });

  it('still offers one for ordinary failures, where retrying is the right move', () => {
    const msg = loginFailureMessage(new Error('connection reset'));
    expect(msg.components).toHaveLength(1);
  });
});

describe('the OTP page, when the portal is refusing us', () => {
  const SESSION: Session = {
    region: 'TW',
    skey: 'k',
    webToken: 'web-token',
    accountId: '',
    serviceCode: '610074',
    serviceRegion: 'T9',
  };
  const ACCOUNT = { sid: 'A1', ssn: '1', sname: 'c', screatetime: null } as ServiceAccount;

  it('says "rate limited", never "your session expired"', async () => {
    // This ordering is the point. The block page is HTML, so the session-expired
    // heuristic downstream matches it happily — and that verdict tells the user
    // to log in again, which is the one action a block makes worse. Every user
    // would be told their account had a problem, and every one of them would be
    // sent to hammer the endpoint that is refusing them.
    const client = {
      http: {
        get: (url: string) =>
          Promise.resolve({ statusCode: 200, body: BLOCK_PAGE, url, redirectUrls: [BLOCK_URL] }),
      },
      readSecretCode: () => Promise.resolve('s'),
      readBfWebToken: () => Promise.resolve('web-token'),
    } as unknown as BeanfunClient;

    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await expect(getOtp(client, SESSION, ACCOUNT, '610074', 'T9')).rejects.toMatchObject({
      code: 'http.ip_blocked',
    });
  });
});
