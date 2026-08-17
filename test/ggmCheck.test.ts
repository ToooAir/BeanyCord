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

import { compareGgm, type GgmSources } from '../src/beanfun/ggmCheck.js';

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
