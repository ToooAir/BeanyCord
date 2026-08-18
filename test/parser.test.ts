import { describe, expect, it } from 'vitest';

import {
  appLinkFromDeeplink,
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

  // Discord only linkifies http(s), so the deep link beanfun actually hands out
  // (`gameplapp://…`) reached the user as text to select and paste by hand — on
  // the one device where the deep link IS the flow, since you cannot scan a QR
  // on the screen you are holding. `play.games.gamania.com/deeplink` is claimed
  // by the Beanfun app in both app-link manifests, so the same query under https
  // is tappable.
  it('rewrites the app scheme to the https app link, query intact', () => {
    expect(
      appLinkFromDeeplink('gameplapp://gameplhost/deeplink?type=1&action=web&code=AbC%2Bd%3D%3D'),
    ).toBe('https://play.games.gamania.com/deeplink?type=1&action=web&code=AbC%2Bd%3D%3D');
  });

  it('passes an already-https app link straight through', () => {
    const url = 'https://play.games.gamania.com/deeplink?type=1&code=x';
    expect(appLinkFromDeeplink(url)).toBe(url);
  });

  // Every case below must be null rather than a best guess. A button that looks
  // like it opens the app and does not is worse than no button: the user taps
  // it, lands nowhere, and has no reason to look for the copy-paste fallback.
  it.each([
    ['a different scheme', 'beanfun://gameplhost/deeplink?code=x'],
    ['a path the app does not claim', 'gameplapp://gameplhost/other?code=x'],
    ['no query to carry', 'gameplapp://gameplhost/deeplink'],
    ['a look-alike https host', 'https://play.games.gamania.evil.com/deeplink?code=x'],
    ['not a URL at all', 'just some text'],
    ['empty', ''],
  ])('refuses to build a link from %s', (_label, raw) => {
    expect(appLinkFromDeeplink(raw)).toBeNull();
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
