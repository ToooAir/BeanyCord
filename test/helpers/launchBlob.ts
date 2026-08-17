/**
 * Build a `m_objData.data` blob the way Beanfun's page does — the exact inverse
 * of `launchData.ts::decode`. Lets the tests construct their own payloads
 * instead of pasting one from a capture (a captured blob carries a real
 * LaunchTicket and could not be committed anyway).
 */
import { TABLES } from '../../src/beanfun/launchData.js';
import { encryptHex } from '../../src/beanfun/wcdes.js';

/**
 * @param selector hex digit that leads the blob; also picks the table
 * @param key 8 lowercase-hex characters (the decoder reads them back out of the
 *   normalized hex, which is lowercase, so an uppercase key would not round-trip)
 * @param plaintext must be a multiple of 8 bytes for DES with no padding
 */
export function encodeLaunchData(selector: number, key: string, plaintext: string): string {
  const cipherHex = encryptHex(plaintext, key);
  const table = TABLES[selector % TABLES.length]!;
  const offset = selector + 1;
  const normalized = cipherHex.slice(0, offset) + key + cipherHex.slice(offset);
  let body = '';
  for (const c of normalized) body += table[parseInt(c, 16)]!;
  return selector.toString(16) + body;
}

/** A plausible decoded payload, padded to a whole number of DES blocks. */
export function launchPlaintext(ticket: string): string {
  const text = `LaunchTicket=${ticket}&ServiceCode=600309`;
  return text.padEnd(Math.ceil(text.length / 8) * 8, '\0');
}

/** 64 hex characters, the shape the decoder insists on. */
export const SAMPLE_TICKET = 'a1b2c3d4'.repeat(8);

/** The per-request `ppppp` a legacy-payload page supplies (112 chars observed). */
export const SAMPLE_PPPPP = 'f0e1d2c3'.repeat(14);

/**
 * The other payload shape: no LaunchTicket, and the legacy OTP parameters
 * instead. Fields are joined by `&&&&`, as observed on 600309/A2.
 */
export function legacyPlaintext(): string {
  const text = [
    `ppppp=${SAMPLE_PPPPP}`,
    'ServiceCode=600309',
    'ServiceRegion=A2',
    'CreateTime=2011-08-22 20:02:08',
  ].join('&&&&');
  return text.padEnd(Math.ceil(text.length / 8) * 8, '\0');
}
