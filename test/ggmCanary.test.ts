/**
 * The launcher-identity canary's reading of a reply.
 *
 * The canary exists because the failure it watches for is otherwise invisible:
 * beanfun refusing our `CV`/`Hash` breaks every user at once, but only a v2
 * request can observe it, and a deployment whose users all sit on legacy games
 * makes none for months. Measured 2026-08-19, the endpoint answers a worthless
 * ticket with `Client_Integrity_Failed` when the pair is wrong and
 * `Invalid_Start_Ticket` when it is right — with no session at all.
 *
 * What these tests are really defending is the THIRD state. A canary that reads
 * an answer it does not recognise as "healthy" reports success while measuring
 * nothing, and would keep doing so forever after beanfun reworded a message or a
 * WAF started returning HTML. That is not hypothetical here: `isLoggedOutEcho`
 * shipped exactly that bug and passed production for weeks.
 */
import { describe, expect, it } from 'vitest';

import {
  classifyCanary,
  CLIENT_INTEGRITY_FAILED,
  INVALID_START_TICKET,
} from '../src/beanfun/ggmCanary.js';

const reply = (message: string, result = 0): string => JSON.stringify({ result, data: null, message });

describe('classifyCanary', () => {
  it('reads a ticket-only refusal as proof the pair is still accepted', () => {
    const r = classifyCanary(200, reply(INVALID_START_TICKET));
    expect(r.status).toBe('healthy');
    expect(r.line).toContain('still accepts');
  });

  it('reads an integrity refusal as the outage it is', () => {
    const r = classifyCanary(200, reply(CLIENT_INTEGRITY_FAILED));
    expect(r.status).toBe('rejected');
    expect(r.line).toContain(CLIENT_INTEGRITY_FAILED);
  });

  // The four below are the whole point of the file: none of them may be
  // 'healthy', because in every one of them we did not measure anything.
  it('does not call an unrecognised message healthy', () => {
    const r = classifyCanary(200, reply('Some_New_Token_We_Have_Never_Seen'));
    expect(r.status).toBe('inconclusive');
    expect(r.line).toContain('unrecognised');
  });

  it('does not call a non-JSON body healthy', () => {
    const r = classifyCanary(200, '<html><body>Access denied</body></html>');
    expect(r.status).toBe('inconclusive');
    expect(r.line).toContain('non-JSON');
  });

  it('does not call an HTTP error healthy', () => {
    const r = classifyCanary(503, reply(INVALID_START_TICKET));
    expect(r.status).toBe('inconclusive');
    expect(r.line).toContain('503');
  });

  it('treats a throwaway ticket being ACCEPTED as a broken measurement, not a pass', () => {
    // If a random 32-byte ticket is good enough, the endpoint stopped validating
    // tickets — which says nothing about the identity and quietly retires this
    // check. Reporting it as healthy would hide that forever.
    const r = classifyCanary(200, JSON.stringify({ result: 1, data: 'ABCDEFGH0011', message: null }));
    expect(r.status).toBe('inconclusive');
    expect(r.line).toContain('ACCEPTED');
  });

  it('reports which pair it asked about, so a log line stands alone', () => {
    expect(classifyCanary(200, reply(INVALID_START_TICKET)).line).toMatch(/cv=\d+\.\d+/);
  });
});
