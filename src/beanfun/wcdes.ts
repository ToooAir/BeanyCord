/**
 * WCDES — DES/ECB/NoPadding, byte-compatible with the legacy WPF `WCDESComp`
 * and the Rust port `core/wcdes/mod.rs`.
 *
 * Used to decrypt the OTP envelope from `get_webstart_otp.ashx`:
 *   payload = `<8-byte ASCII key><hex ciphertext>`
 *
 * Rules (all match the Rust/C# reference exactly):
 * - Key + plaintext are ASCII (8-byte key). We encode as latin1 (1 byte/char);
 *   server keys are ASCII so this is byte-identical. (The Rust replaces
 *   non-ASCII with '?'; server data never triggers that path.)
 * - No padding. Ciphertext length must be a multiple of 8 bytes.
 * - Hex output uppercase; hex input case-insensitive.
 * - Trailing NULs are NOT stripped here — the caller trims (see otp.ts).
 *
 * Node's `crypto` `des-ecb` with `setAutoPadding(false)` is byte-equal to
 * .NET `DES + ECB + PaddingMode.None`, which the Rust test fixtures were
 * generated against.
 *
 * REQUIRES `--openssl-legacy-provider`: single-DES is a legacy cipher that
 * OpenSSL 3 (Node 18+) disables by default. The npm scripts set
 * `NODE_OPTIONS=--openssl-legacy-provider`; deployment (systemd/pm2) must do
 * the same. We considered a pure-JS DES (des.js) but it only does PKCS
 * padding — no NoPadding mode — so the battle-tested OpenSSL path is correct.
 */
import crypto, { type Decipher, type Cipher } from 'node:crypto';

import { BeanfunError } from './errors.js';

const BLOCK = 8;

const LEGACY_HINT =
  'des-ecb is unavailable — run Node with --openssl-legacy-provider ' +
  '(set NODE_OPTIONS=--openssl-legacy-provider).';

function makeDecipher(key: string): Decipher {
  try {
    const d = crypto.createDecipheriv('des-ecb', keyBuf(key), null);
    d.setAutoPadding(false);
    return d;
  } catch (e) {
    if (e instanceof Error && /unsupported|des-ecb/i.test(e.message)) {
      throw new BeanfunError('wcdes.legacy_provider_required', LEGACY_HINT);
    }
    throw e;
  }
}

function makeCipher(key: string): Cipher {
  try {
    const c = crypto.createCipheriv('des-ecb', keyBuf(key), null);
    c.setAutoPadding(false);
    return c;
  } catch (e) {
    if (e instanceof Error && /unsupported|des-ecb/i.test(e.message)) {
      throw new BeanfunError('wcdes.legacy_provider_required', LEGACY_HINT);
    }
    throw e;
  }
}

function keyBuf(key: string): Buffer {
  const buf = Buffer.from(key, 'latin1');
  if (buf.length !== BLOCK) {
    throw new BeanfunError('wcdes.invalid_key_length', `key must be 8 bytes, got ${buf.length}`);
  }
  return buf;
}

/** DES-ECB-NoPadding decrypt of an uppercase/lowercase hex string. */
export function decryptHex(hexStr: string, key: string): string {
  const data = Buffer.from(hexStr, 'hex');
  if (data.length === 0 && hexStr.length !== 0) {
    throw new BeanfunError('wcdes.invalid_hex', 'ciphertext is not valid hex');
  }
  if (data.length % BLOCK !== 0) {
    throw new BeanfunError(
      'wcdes.invalid_ciphertext_length',
      `ciphertext must be a multiple of ${BLOCK} bytes`,
    );
  }
  const d = makeDecipher(key);
  return Buffer.concat([d.update(data), d.final()]).toString('latin1');
}

/** DES-ECB-NoPadding encrypt -> uppercase hex. Used by unit tests / parity. */
export function encryptHex(plaintext: string, key: string): string {
  const pt = Buffer.from(plaintext, 'latin1');
  if (pt.length % BLOCK !== 0) {
    throw new BeanfunError(
      'wcdes.invalid_plaintext_length',
      `plaintext must be a multiple of ${BLOCK} bytes`,
    );
  }
  const c = makeCipher(key);
  return Buffer.concat([c.update(pt), c.final()]).toString('hex').toUpperCase();
}
