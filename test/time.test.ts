/**
 * Cache-buster format tests — fixtures from Rust `core/time.rs`.
 * `Date` is constructed in LOCAL time (matching .NET `DateTime.Now`), so
 * these assert the format/quirks, not a fixed timezone.
 */
import { describe, expect, it } from 'vitest';

import { dtCompact, dtIso } from '../src/beanfun/time.js';

describe('dtCompact (0-indexed, non-padded month)', () => {
  it('January -> single "0" month', () => {
    // 2024-01-05 03:09:07.042  (month index 0)
    expect(dtCompact(new Date(2024, 0, 5, 3, 9, 7, 42))).toBe('2024005030907042');
  });
  it('December -> "11" month', () => {
    expect(dtCompact(new Date(2024, 11, 31, 23, 59, 59, 999))).toBe('20241131235959999');
  });
  it('October -> single "9" month', () => {
    expect(dtCompact(new Date(2024, 9, 1, 0, 0, 0, 0))).toBe('2024901000000000');
  });
});

describe('dtIso', () => {
  it('yyyyMMddHHmmss.fff', () => {
    expect(dtIso(new Date(2024, 0, 5, 3, 9, 7, 42))).toBe('20240105030907.042');
  });
});
