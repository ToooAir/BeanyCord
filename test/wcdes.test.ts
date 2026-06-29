/**
 * WCDES parity tests — fixtures copied verbatim from the Rust port
 * `core/wcdes/mod.rs::WPF_FIXTURES`. If these pass, OTP decryption is
 * byte-compatible with the WPF/Rust reference.
 */
import { describe, expect, it } from 'vitest';

import { decryptHex, encryptHex } from '../src/beanfun/wcdes.js';

const FIXTURES: ReadonlyArray<[key: string, plaintext: string, hex: string]> = [
  ['12345678', 'PLAINTXT', '0309B843D74E1A40'],
  ['12345678', 'MAPLESTORY123456', '3FFCE1682ADB96B9A5BA42853018BFF3'],
  ['12345678', 'ABCDEFGH12345678HELLOTHX', '96DE603EAED6256F96D0028878D58C89DA4A75D69D63A29C'],
  ['abcdefgh', 'Now is t', '27176663304B9404'],
  ['12345678', 'OTP:1234', '5495D9041D7E149B'],
  ['KEYONE89', '123456\0\0', '16D42698743EB312'],
];

describe('wcdes', () => {
  it('encrypts to the WPF/Rust fixtures', () => {
    for (const [key, plaintext, hex] of FIXTURES) {
      expect(encryptHex(plaintext, key)).toBe(hex);
    }
  });

  it('decrypts the WPF/Rust fixtures', () => {
    for (const [key, plaintext, hex] of FIXTURES) {
      expect(decryptHex(hex, key)).toBe(plaintext);
    }
  });

  it('accepts lowercase hex input', () => {
    expect(decryptHex('0309b843d74e1a40', '12345678')).toBe('PLAINTXT');
  });

  it('rejects a non-8-byte key', () => {
    expect(() => decryptHex('0309B843D74E1A40', 'short')).toThrow();
  });
});
