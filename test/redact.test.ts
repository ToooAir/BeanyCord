/** Secret redaction (M3): URLs, error text, and length capping. */
import { describe, expect, it } from 'vitest';

import { redactText, redactUrl, safeError } from '../src/core/redact.js';

describe('redactUrl', () => {
  it('masks sensitive query params, keeps the rest', () => {
    const url =
      'https://tw.beanfun.com/beanfun_block/generic_handlers/get_webstart_otp.ashx' +
      '?SN=longpollkey&WebToken=SECRET&SecretCode=abc&ppppp=DEAD&ServiceCode=610074&ServiceRegion=T9';
    const out = redactUrl(url);
    expect(out).not.toContain('SECRET');
    expect(out).not.toContain('longpollkey');
    expect(out).not.toContain('abc');
    expect(out).toContain('ServiceCode=610074');
    expect(out).toContain('ServiceRegion=T9');
  });

  it('masks the auth.aspx web_token param', () => {
    const out = redactUrl('https://tw.beanfun.com/beanfun_block/auth.aspx?web_token=TOPSECRET&channel=game_zone');
    expect(out).not.toContain('TOPSECRET');
    expect(out).toContain('channel=game_zone');
  });

  it('falls back to text redaction for non-URLs', () => {
    expect(redactUrl('not a url skey=HUSH')).toContain('skey=***');
  });
});

describe('redactText', () => {
  it('masks embedded sensitive key=value pairs', () => {
    const out = redactText('failed: bfWebToken=AAA&WebToken=BBB at step');
    expect(out).not.toContain('AAA');
    expect(out).not.toContain('BBB');
    expect(out).toContain('at step');
  });

  it('caps very long strings', () => {
    const out = redactText('x'.repeat(1000));
    expect(out.length).toBeLessThanOrEqual(301);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('safeError', () => {
  it('redacts an Error message', () => {
    expect(safeError(new Error('token=zzz boom'))).toContain('token=***');
  });
  it('handles non-Error values', () => {
    expect(safeError('plain string')).toBe('plain string');
  });
});
