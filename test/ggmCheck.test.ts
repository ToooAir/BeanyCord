/**
 * The launcher-identity comparison.
 *
 * Gamania ships a new Games Manager a few times a year and Beanfun eventually
 * stops accepting the previous build's `CV`/`Hash`. The comparison itself is
 * pure, so it is tested here without touching the network; the fetching is a
 * thin wrapper around it.
 *
 * The distinction these lock down is that **a difference is not an outage**.
 * Beanfun may keep accepting the old pair for a long time, so nothing here may
 * phrase a version gap as a failure — that is what would turn the startup line
 * into noise, and noise is what gets ignored on the day it matters.
 */
import { describe, expect, it } from 'vitest';

import type { CanaryResult } from '../src/beanfun/ggmCanary.js';
import { combineGgm, compareGgm, type GgmSources } from '../src/beanfun/ggmCheck.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function sources(over: Partial<GgmSources> = {}): GgmSources {
  return {
    local: { cv: '1.5.0.2', hash: HASH_A, arch: 'x64' },
    upstream: { cv: '1.5.0.2', hash: HASH_A },
    beanfunVersion: '1.5.0.2',
    problems: [],
    ...over,
  };
}

describe('compareGgm', () => {
  it('calls all three agreeing "aligned"', () => {
    const v = compareGgm(sources());
    expect(v.status).toBe('aligned');
    expect(v.line).toContain('matches upstream');
  });

  it('tells you what to copy when upstream has a different pair', () => {
    const v = compareGgm(sources({ upstream: { cv: '1.5.0.3', hash: HASH_B } }));
    expect(v.status).toBe('differs');
    expect(v.line).toContain('cv=1.5.0.3');
    expect(v.line).toContain('clientIntegrity.ts');
  });

  it('notices a hash change even when the version is unchanged', () => {
    // A rebuild under the same version number is possible, and the hash is the
    // half that is actually checked byte-for-byte.
    const v = compareGgm(sources({ upstream: { cv: '1.5.0.2', hash: HASH_B } }));
    expect(v.status).toBe('differs');
  });

  it('says there is nothing to copy yet when only beanfun has moved', () => {
    // The common ordering: beanfun ships a build before upstream's watcher has
    // produced the matching hash. Telling someone to "update" here would send
    // them looking for a value that does not exist.
    const v = compareGgm(sources({ beanfunVersion: '1.5.0.3' }));
    expect(v.status).toBe('differs');
    expect(v.line).toContain('beanfun ships 1.5.0.3');
    expect(v.line).toContain('nothing to copy in yet');
  });

  it('never phrases a difference as a rejection', () => {
    const v = compareGgm(sources({ upstream: { cv: '1.5.0.3', hash: HASH_B } }));
    expect(v.line).toContain('does not mean it is rejected');
  });

  it('is "unknown", not "aligned", when neither source could be reached', () => {
    // Silence must never read as confirmation.
    const v = compareGgm(
      sources({ upstream: null, beanfunVersion: null, problems: ['offline'] }),
    );
    expect(v.status).toBe('unknown');
    expect(v.line).toContain('offline');
  });

  it('still compares the source it did reach', () => {
    const v = compareGgm(sources({ beanfunVersion: null, problems: ['CheckVersion down'] }));
    expect(v.status).not.toBe('aligned');
    expect(v.line).toContain('CheckVersion.ashx unavailable');
  });

  it('keeps the full hash out of the line', () => {
    // Public, but 64 characters of it per log line is noise.
    expect(compareGgm(sources()).line).not.toContain(HASH_A);
  });
});

/**
 * Folding the measurement in.
 *
 * The canary outranks the comparison because it asked the server instead of
 * guessing from version strings — but "outranks" must not mean "replaces": when
 * the pair is refused, the only actionable half of the answer (what to copy in)
 * comes from upstream, and it has to survive into the same line.
 */
describe('combineGgm', () => {
  const canary = (status: CanaryResult['status'], line = `canary says ${status}`): CanaryResult => ({
    status,
    line,
  });

  it('lets a refusal outrank a comparison that thinks everything is fine', () => {
    const v = combineGgm(compareGgm(sources()), canary('rejected', 'beanfun REFUSES this pair'));
    expect(v.status).toBe('rejected');
    expect(v.line).toContain('REFUSES');
  });

  it('keeps upstream\'s pair in the refusal line — it is the fix', () => {
    const comparison = compareGgm(sources({ upstream: { cv: '1.5.0.3', hash: HASH_B } }));
    const v = combineGgm(comparison, canary('rejected'));
    expect(v.status).toBe('rejected');
    expect(v.line).toContain('1.5.0.3');
    expect(v.line).toContain('clientIntegrity.ts');
  });

  it('turns a version difference into a PROVEN harmless one when the pair still works', () => {
    // This is the whole reason to run the canary beside the comparison: on its
    // own `compareGgm` can only hedge, because acceptance is not decidable from
    // version strings. With a measurement it does not have to.
    const comparison = compareGgm(sources({ beanfunVersion: '1.6.0.0' }));
    expect(comparison.status).toBe('differs');
    const v = combineGgm(comparison, canary('healthy', 'beanfun still accepts this pair'));
    expect(v.status).toBe('accepted');
    expect(v.line).toContain('currently harmless');
    expect(v.line).toContain('1.6.0.0');
  });

  it('falls back to the comparison when the canary could not measure', () => {
    // Degrading everything to `unknown` would throw away the one source that
    // still had something to say.
    const comparison = compareGgm(sources({ upstream: { cv: '1.5.0.3', hash: HASH_B } }));
    const v = combineGgm(comparison, canary('inconclusive', 'canary got a non-JSON reply'));
    expect(v.status).toBe('differs');
    expect(v.line).toContain('1.5.0.3');
    expect(v.line).toContain('non-JSON');
  });
});
