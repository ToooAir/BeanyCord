import { describe, expect, it } from 'vitest';

import { looksLikeSessionExpiredPage } from '../src/beanfun/client.js';
import { decryptEnvelope } from '../src/beanfun/otp.js';

describe('looksLikeSessionExpiredPage', () => {
  it('flags a full HTML login page (the hijacked-session response)', () => {
    const page =
      '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN">\n' +
      '<html xmlns="http://www.w3.org/1999/xhtml"><head></head></html>';
    expect(looksLikeSessionExpiredPage(page)).toBe(true);
  });

  it('tolerates a leading BOM and whitespace before the doctype', () => {
    expect(looksLikeSessionExpiredPage('﻿  \n<!doctype html><html></html>')).toBe(true);
  });

  it('does not flag the normal OTP fragment', () => {
    expect(looksLikeSessionExpiredPage('longPollingKey=abc123&otherstuff=1')).toBe(false);
  });
});

describe('decryptEnvelope', () => {
  it('rejects an empty envelope', () => {
    expect(() => decryptEnvelope('')).toThrowError(/empty OTP envelope/);
  });

  it('relays a short server rejection verbatim — that reason is useful', () => {
    expect(() => decryptEnvelope('0;帳號狀態異常')).toThrowError(/帳號狀態異常/);
  });

  it('never relays an error page into the DM', () => {
    // The step-5 half of 889a820: a rejection slot holding a whole HTML page.
    const page = '<!DOCTYPE html><html><head><title>Err Msg</title></head>;<body>程式發生錯誤</body></html>';
    try {
      decryptEnvelope(page);
      expect.unreachable('should have thrown');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).not.toContain('<');
      expect(msg).toMatch(/unexpected response shape/);
    }
  });

  it('suppresses an over-long reason', () => {
    expect(() => decryptEnvelope(`0;${'x'.repeat(200)}`)).toThrowError(/unexpected response shape/);
  });
});
