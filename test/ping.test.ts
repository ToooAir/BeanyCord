/**
 * The keep-alive death detector used to be blind: `echo_token.ashx` answers
 * HTTP 200 even when the session is gone, and ping() only checked the status
 * code, so pingFails never incremented and the "session expired" notice could
 * never fire. The logged-out body below was captured from the live TW portal
 * with an empty cookie jar (2026-08-13).
 */
import { describe, expect, it } from 'vitest';

import { isLoggedOutEcho } from '../src/beanfun/client.js';

const LOGGED_OUT =
  'BeanFunBlock.EchoTokenResult({ResultCode:0, ResultDesc: "User is logged out.", MainAccountID : "" });';

describe('isLoggedOutEcho', () => {
  it('detects the captured logged-out response', () => {
    expect(isLoggedOutEcho(LOGGED_OUT)).toBe(true);
  });

  it('treats an echoed account id as alive', () => {
    const alive =
      'BeanFunBlock.EchoTokenResult({ResultCode:1, ResultDesc: "", MainAccountID : "AB12345678" });';
    expect(isLoggedOutEcho(alive)).toBe(false);
  });

  it('tolerates whitespace / quoting variants around the field', () => {
    expect(isLoggedOutEcho('{MainAccountID:""}')).toBe(true);
    expect(isLoggedOutEcho('{ mainaccountid  :   "   " }')).toBe(true);
    expect(isLoggedOutEcho('{ MainAccountID : "  X  " }')).toBe(false);
  });

  it('fails open on an unrecognised body so a format change cannot mass-kill sessions', () => {
    expect(isLoggedOutEcho('')).toBe(false);
    expect(isLoggedOutEcho('<html>totally different</html>')).toBe(false);
    expect(isLoggedOutEcho('BeanFunBlock.EchoTokenResult({ResultCode:0});')).toBe(false);
  });
});
