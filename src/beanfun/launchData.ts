/**
 * Decoder for the `Data` blob on Beanfun's game-start page.
 *
 * `game_start_step2.aspx` embeds a launcher handoff:
 *
 * ```javascript
 * var m_objData = { "region": "TW;Production", "sn": "<36-char GUID>", "data": "<blob>" };
 * ```
 *
 * and hands it to the native Gamania Games Manager over the `gamaniagames://`
 * URL scheme. `data` carries the `LaunchTicket` that `get_webstart_otp_v2.ashx`
 * requires — obfuscated, but present, so the value is recoverable without the
 * launcher being installed. Port of Rust `core/launch_data.rs`; the derivation
 * is in that repo's `docs/OTP-PROTOCOL-CHANGE.md` (decoding algorithm published
 * by @takidog in pungin/Beanfun#368).
 *
 * Format:
 *   1. First character is a hex digit `n`, selecting a substitution table.
 *   2. Every remaining character maps to its INDEX in that table, re-emitted as
 *      a hex digit — the "normalized hex".
 *   3. The 8 characters at offset `n + 1` of the normalized hex are the DES key.
 *   4. Removing those 8 leaves the ciphertext hex.
 *   5. DES-ECB, no padding, trailing NULs trimmed.
 *
 * Steps 3-5 are the same construction the pre-v2 OTP envelope used (8-char
 * ASCII key + hex ciphertext), so `wcdes.decryptHex` handles them unchanged.
 * Only the substitution layer and the field parse are new.
 */
import { BeanfunError } from './errors.js';
import { decryptHex } from './wcdes.js';

/**
 * The substitution alphabets, lifted from the launcher's
 * `Command.DecryptParam()`. Each is a permutation of the 16 hex digits — a
 * precondition for the mapping to be reversible, asserted in the tests.
 * Exported so a test can build a blob the way the page does, rather than
 * pasting one from a capture.
 */
export const TABLES = [
  'bac987d65e432f10',
  '3bc4d5e6f2a79108',
  'cdbeaf9012456378',
  '4e6fb81a3c5d7092',
  'bdef1246789ac530',
  '5f82cb4093e71d6a',
  'df1468ace0357b92',
  'b50c61a4f93e82d7',
] as const;

/** Length of the ASCII DES key embedded in the normalized hex. */
const KEY_LEN = 8;

/**
 * A decoded payload's `key=value` fields.
 *
 * Not every page carries the same ones. A game whose start goes through the v2
 * credential endpoint yields `LaunchTicket`; others yield the legacy OTP
 * parameter set (`ppppp`, `ServiceCode`, `ServiceRegion`, `ServiceAccount`,
 * `CreateTime`, `BeanfunUrl`, `WebStartPatch`) — which is why the route has to
 * be decided on what actually decoded, not on the handoff merely being present.
 */
export type LaunchFields = Record<string, string>;

/**
 * Decode the blob into its fields.
 *
 * Fields are joined by `&&&&`, the same separator the `gamaniagames://` handoff
 * URI uses, so splitting on a single `&` leaves empty segments — dropped here.
 */
export function decodeLaunchFields(data: string): LaunchFields {
  const fields: LaunchFields = {};
  for (const segment of decode(data).split(';')[0]!.split('&')) {
    if (segment === '') continue;
    const eq = segment.indexOf('=');
    if (eq > 0) fields[segment.slice(0, eq)] = segment.slice(eq + 1);
  }
  return fields;
}

/** Pull `LaunchTicket` out of a decoded payload, or explain what was there instead. */
export function decodeLaunchTicket(data: string): string {
  const fields = decodeLaunchFields(data);
  const ticket = fields['LaunchTicket'];

  if (ticket === undefined) {
    // Naming the fields that ARE present is the difference between "our decoder
    // is broken" and "this page hands the launcher something else" — the two
    // were indistinguishable while this said only "no table worked", and that
    // cost a full round of chasing the decoder instead of reading the payload.
    throw new BeanfunError(
      'launch.missing_ticket',
      `decoded launch data carries no LaunchTicket (fields: ${Object.keys(fields).join(', ') || 'none'})`,
    );
  }
  // Presence decides the route; shape does not. Every ticket seen so far is 64
  // hex characters, but pinning that is the same over-narrow acceptance that
  // made a perfectly good decode look like a failure above — and the cost is
  // asymmetric: routing already committed to v2 on the field being there, so a
  // ticket we refuse to pass on is an OTP the user does not get, while one the
  // server dislikes is a refusal it can explain itself. Upstream removed the
  // identical check in hiimyusheng/Beanfun@283dc54 for the same reason.
  if (ticket === '') {
    throw new BeanfunError('launch.malformed_ticket', 'LaunchTicket is present but empty');
  }
  return ticket;
}

/**
 * Undo the substitution layer and decrypt, returning the plaintext with NULs
 * trimmed.
 *
 * Which table the selector names is not settled: `n % 4` decodes every sample
 * we have, but with eight tables and few captures that rule is not proven. So
 * try every table and accept the first whose output is text.
 *
 * "Is text" — not "contains LaunchTicket". Keying acceptance on that field made
 * a page that decoded perfectly but carries a different field set look like a
 * decoder failure. Measured on a real blob, the right table yields 100%
 * printable ASCII and every wrong one lands near 43%, so the threshold below
 * separates them with a wide margin and no assumption about the contents.
 */
function decode(data: string): string {
  if (data === '') throw new BeanfunError('launch.empty', 'launch data is empty');

  const selectorChar = data[0]!;
  const selector = parseInt(selectorChar, 16);
  if (Number.isNaN(selector)) {
    throw new BeanfunError(
      'launch.bad_selector',
      `launch data does not start with a hex digit (got ${JSON.stringify(selectorChar)})`,
    );
  }
  const rest = data.slice(1);

  const order = [selector % 4, selector % TABLES.length, ...TABLES.map((_, i) => i)];
  const tried = new Set<number>();
  let firstError: unknown;

  for (const tableIndex of order) {
    if (tried.has(tableIndex)) continue;
    tried.add(tableIndex);
    try {
      const plaintext = decodeWith(rest, selector, tableIndex);
      if (looksLikeText(plaintext)) return plaintext;
      // Noise — that is a wrong table, not a broken blob, so keep going.
    } catch (e) {
      firstError ??= e;
    }
  }
  if (firstError) throw firstError;
  throw new BeanfunError('launch.undecodable', 'no substitution table decoded the blob to text');
}

/** Printable-ASCII share, with a field separator present. */
function looksLikeText(s: string): boolean {
  if (s.length === 0 || !s.includes('=')) return false;
  let printable = 0;
  for (const c of s) if (c >= ' ' && c <= '~') printable++;
  return printable / s.length >= 0.95;
}

/** One decode attempt with the table already chosen. */
function decodeWith(body: string, selector: number, tableIndex: number): string {
  const table = TABLES[tableIndex]!;

  let normalized = '';
  for (const ch of body) {
    const idx = table.indexOf(ch);
    if (idx < 0) {
      throw new BeanfunError(
        'launch.unmappable_char',
        `launch data contains ${JSON.stringify(ch)}, absent from substitution table ${tableIndex}`,
      );
    }
    normalized += idx.toString(16);
  }

  const offset = selector + 1;
  if (normalized.length < offset + KEY_LEN) {
    throw new BeanfunError(
      'launch.too_short',
      `launch data cannot hold a key at offset ${offset} (have ${normalized.length} characters)`,
    );
  }

  const key = normalized.slice(offset, offset + KEY_LEN);
  const cipherHex = normalized.slice(0, offset) + normalized.slice(offset + KEY_LEN);
  return decryptHex(cipherHex, key).replace(/^\0+/, '').replace(/\0+$/, '');
}
