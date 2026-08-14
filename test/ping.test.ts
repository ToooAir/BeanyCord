/**
 * Keep-alive death detection, against bodies captured from the live TW portal
 * (test/fixtures/, 2026-08-14) — the SAME session before and after it was killed
 * by a login elsewhere. That matched pair is the whole point: the two responses
 * are byte-identical apart from ResultCode/ResultDesc, which is how we learned
 * the first version of this check was reading a field that carries no signal.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { isLoggedOutEcho } from '../src/beanfun/client.js';

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');

const ALIVE = fixture('echo_token.alive.txt');
const DEAD = fixture('echo_token.dead.txt');

describe('isLoggedOutEcho', () => {
  it('reads the captured live session as alive', () => {
    expect(isLoggedOutEcho(ALIVE)).toBe(false);
  });

  it('reads the captured dead session as logged out', () => {
    expect(isLoggedOutEcho(DEAD)).toBe(true);
  });

  it('does not depend on MainAccountID, which is identical in both states', () => {
    // Regression guard: the first version keyed off an empty MainAccountID and
    // was blind, because a dead session still echoes a bfguest id.
    const idOf = (s: string) => /MainAccountID\s*:\s*"([^"]*)"/.exec(s)?.[1];
    expect(idOf(ALIVE)).toBe(idOf(DEAD));
    expect(idOf(DEAD)).not.toBe('');
  });

  it('accepts either signal on its own', () => {
    expect(isLoggedOutEcho('{ResultCode:0}')).toBe(true);
    expect(isLoggedOutEcho('{ResultDesc: "User is logged out."}')).toBe(true);
    expect(isLoggedOutEcho('{ResultCode:1}')).toBe(false);
  });

  it('fails open on an unrecognised body so a format change cannot mass-kill sessions', () => {
    expect(isLoggedOutEcho('')).toBe(false);
    expect(isLoggedOutEcho('<html>totally different</html>')).toBe(false);
  });
});
