/**
 * The substitution layer wrapped around the LaunchTicket blob. See
 * `src/beanfun/launchData.ts` for the format; these lock down the properties
 * the decoder depends on and the failure modes that would otherwise surface as
 * an unexplained OTP failure.
 */
import { describe, expect, it } from 'vitest';

import { decodeLaunchFields, decodeLaunchTicket, TABLES } from '../src/beanfun/launchData.js';
import {
  encodeLaunchData,
  launchPlaintext,
  legacyPlaintext,
  SAMPLE_PPPPP,
  SAMPLE_TICKET,
} from './helpers/launchBlob.js';

describe('substitution tables', () => {
  it('are each a permutation of the hex alphabet', () => {
    // The mapping is only reversible if every table is a complete permutation.
    // Pinned so a future transcription slip is caught here rather than as an
    // unexplained decode failure against a live server.
    for (const [i, table] of TABLES.entries()) {
      const sorted = [...table].sort().join('');
      expect(sorted, `table ${i}`).toBe('0123456789abcdef');
    }
  });
});

describe('decodeLaunchTicket', () => {
  it('round-trips a blob built the way the page builds it', () => {
    const blob = encodeLaunchData(3, '1a2b3c4d', launchPlaintext(SAMPLE_TICKET));
    expect(decodeLaunchTicket(blob)).toBe(SAMPLE_TICKET);
  });

  it('finds the table when the selector does not name it directly', () => {
    // `n % 4` decodes the two captures upstream has, but with eight tables that
    // rule is unconfirmed — so the decoder tries them all. Selector 5 encodes
    // with table 5 while `5 % 4` points at table 1: only the fallback finds it.
    expect(5 % 4).not.toBe(5 % TABLES.length);
    const blob = encodeLaunchData(5, 'a1b2c3d4', launchPlaintext(SAMPLE_TICKET));
    expect(decodeLaunchTicket(blob)).toBe(SAMPLE_TICKET);
  });

  it('rejects an empty blob', () => {
    expect(() => decodeLaunchTicket('')).toThrowError(/launch data is empty/);
  });

  it('rejects a blob that does not start with a hex digit', () => {
    expect(() => decodeLaunchTicket('zzzz')).toThrowError(/does not start with a hex digit/);
  });

  it('names the fields that are there when LaunchTicket is not', () => {
    // The real Mabinogi (600309_A2) payload shape. Saying only "no table worked"
    // here sent a whole round of investigation at the decoder, which was fine —
    // the error has to distinguish "cannot read it" from "read it, no ticket".
    const blob = encodeLaunchData(11, '1a2b3c4d', legacyPlaintext());
    expect(() => decodeLaunchTicket(blob)).toThrowError(/fields: ppppp, ServiceCode/);
  });

  it('reports a blob that decodes to noise distinctly', () => {
    // Not the same failure as "decoded fine, different fields".
    // 168 body chars: minus the 8-char key leaves 160 hex = 10 whole DES blocks,
    // so this fails on the content, not on a length check.
    expect(() => decodeLaunchTicket(`0${'abcdef01'.repeat(21)}`)).toThrowError(
      /no substitution table decoded the blob to text/,
    );
  });
});

describe('decodeLaunchFields', () => {
  it('splits on the &&&& separator the handoff uses', () => {
    const blob = encodeLaunchData(11, '1a2b3c4d', legacyPlaintext());
    expect(decodeLaunchFields(blob)).toEqual({
      ppppp: SAMPLE_PPPPP,
      ServiceCode: '600309',
      ServiceRegion: 'A2',
      CreateTime: '2011-08-22 20:02:08',
    });
  });

  it('rejects a ticket that is not 64 hex characters', () => {
    const short = `LaunchTicket=abc123&ServiceCode=600309`.padEnd(48, '\0');
    const blob = encodeLaunchData(1, '1a2b3c4d', short);
    expect(() => decodeLaunchTicket(blob)).toThrowError(/not 64 hex characters/);
  });
});
