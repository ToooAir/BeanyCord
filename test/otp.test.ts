import { describe, expect, it } from 'vitest';

import { decryptEnvelope, looksLikeSessionExpiredPage } from '../src/beanfun/otp.js';

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
});
