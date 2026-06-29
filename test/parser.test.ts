import { describe, expect, it } from 'vitest';

import {
  extractHiddenInputs,
  extractServiceAccounts,
  extractVerificationToken,
  normalizeDeeplink,
  parseServiceList,
  sessionKeyFromUrl,
} from '../src/beanfun/parser.js';

describe('parser', () => {
  it('extracts the antiforgery token', () => {
    const html = '<input name="__RequestVerificationToken" type="hidden" value="TOK+/=" />';
    expect(extractVerificationToken(html)).toBe('TOK+/=');
  });

  it('scrapes hidden inputs and skips submit', () => {
    const html =
      '<input type="hidden" name="A" value="1" /><input type="submit" name="b" value="x" />';
    expect(extractHiddenInputs(html)).toEqual([['A', '1']]);
  });

  it('reads pSKey from a redirected URL', () => {
    expect(sessionKeyFromUrl('https://h/p?service=999999_T0&pSKey=ABC123')).toBe('ABC123');
  });

  it('parses service-account rows and the enabled flag', () => {
    const html =
      '<a onclick="doLogin(\'x\')"><div id="abc1" sn="123" name="Hero"></div></a>' +
      '<a href="#"><div id="def2" sn="456" name="Disabled"></div></a>';
    const rows = extractServiceAccounts(html);
    expect(rows).toHaveLength(1); // the no-onclick row does not match the regex
    expect(rows[0]).toEqual({ isEnable: true, sid: 'abc1', ssn: '123', sname: 'Hero' });
  });

  it('unwraps a gamania deeplink', () => {
    const raw = 'https://play.games.gamania.com/app/deeplink/?url=https://t.example/a';
    expect(normalizeDeeplink(raw)).toBe('https://t.example/a');
  });

  it('parses the new-shape ServiceList array', () => {
    const html =
      '<script>Services.ServiceList = [{"ServiceFamilyName":"新楓之谷","ServiceCode":"610074","ServiceRegion":"T9"}];</script>';
    const s = parseServiceList(html);
    expect(s).toHaveLength(1);
    expect(s[0]!.name).toBe('新楓之谷');
    expect(s[0]!.serviceCode).toBe('610074');
  });
});
