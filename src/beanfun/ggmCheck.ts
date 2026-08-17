/**
 * Is the launcher identity we send still the one Beanfun accepts?
 *
 * `clientIntegrity.ts` pins a `CV`/`Hash` pair describing a Gamania Games
 * Manager build. Gamania ships a new one a few times a year, and when Beanfun
 * stops accepting the old pair, everyone pinning it breaks together — with a
 * server refusal whose wording we have never seen and cannot count on being
 * legible.
 *
 * So this answers the question at the moment it is asked, from three sources:
 *
 *   local     what we send                       (`clientIntegrity.ts`)
 *   upstream  a maintained pair                  (pungin/Beanfun `ggm-client.json`)
 *   beanfun   the build it currently ships       (`CheckVersion.ashx`)
 *
 * Upstream is the one worth trusting for the hash: they run an hourly watcher on
 * `CheckVersion.ashx` and, when the version moves, a Windows runner that
 * installs GGM and reads the DLL's version and SHA-256. Reproducing that here
 * would mean unpacking an Inno Setup 6.3 installer, which the current
 * innoextract cannot do — and a hash we got wrong would fail exactly like a
 * stale one while looking fixed.
 *
 * Deliberately NOT a monitor. A version bump is not a failure: Beanfun may keep
 * accepting the old pair indefinitely, so a daily check would report a
 * difference every day while everything worked, and be ignored by the time it
 * mattered. This runs where the answer is actually needed — on a refusal, at
 * startup, or by hand.
 */
import got from 'got';

import { safeError } from '../core/redact.js';
import { USER_AGENT } from './client.js';
import { GGM_ARCH, GGM_CV, GGM_HASH } from './clientIntegrity.js';

/** Beanfun's own announcement of the build it ships. ~80 bytes. */
const CHECK_VERSION_URL = 'https://tw.beanfun.com/generic_handlers/CheckVersion.ashx';

/** Upstream's published pair. NOTE: their default branch is `code`, not `main`. */
const UPSTREAM_PAIR_URL =
  'https://raw.githubusercontent.com/pungin/Beanfun/code/ggm-client.json';

const FETCH_TIMEOUT_MS = 5_000;
/** Both sources change a few times a year; re-asking within hours is waste. */
const CACHE_TTL_MS = 6 * 60 * 60 * 1_000;

export interface GgmSources {
  /** What we send. */
  local: { cv: string; hash: string; arch: string };
  /** Upstream's published pair; null when unreachable or unparseable. */
  upstream: { cv: string; hash: string } | null;
  /** The version Beanfun says it ships; null when unreachable. */
  beanfunVersion: string | null;
  /** Why a source is null, when it is. */
  problems: string[];
}

export interface GgmVerdict {
  /**
   * `aligned`   — all three agree; this pair is not the suspect.
   * `differs`   — something moved; the line says what and what to do.
   * `unknown`   — could not reach enough sources to say.
   */
  status: 'aligned' | 'differs' | 'unknown';
  /** One line, ready to log. */
  line: string;
}

/** Short, non-secret fingerprint — the hash is public, but 64 chars in a log is noise. */
function shortHash(h: string): string {
  return `${h.slice(0, 8)}…`;
}

/**
 * Pure comparison, so the interesting part is testable without network.
 *
 * Note it does not try to order versions. "Newer" is not decidable from two
 * strings in a scheme we do not control, and getting it wrong would send
 * someone to downgrade. Reporting what each source says, and letting a human
 * look, is both simpler and harder to get wrong.
 */
export function compareGgm(s: GgmSources): GgmVerdict {
  const { local, upstream, beanfunVersion, problems } = s;
  const pinned = `pinned cv=${local.cv} hash=${shortHash(local.hash)} arch=${local.arch}`;

  if (!upstream && !beanfunVersion) {
    return {
      status: 'unknown',
      line: `${pinned}; could not reach either source — ${problems.join('; ') || 'no detail'}`,
    };
  }

  const notes: string[] = [];
  if (upstream) {
    if (upstream.cv !== local.cv || upstream.hash !== local.hash) {
      notes.push(
        `upstream publishes cv=${upstream.cv} hash=${shortHash(upstream.hash)} — if OTP is ` +
          'failing, copy that pair into src/beanfun/clientIntegrity.ts and redeploy',
      );
    }
  } else {
    notes.push('upstream pair unavailable');
  }

  if (beanfunVersion) {
    if (beanfunVersion !== local.cv) {
      notes.push(
        `beanfun ships ${beanfunVersion}` +
          (upstream && upstream.cv !== beanfunVersion
            ? ' — upstream has not published a matching hash yet, so there is nothing to copy in yet'
            : ''),
      );
    }
  } else {
    notes.push('CheckVersion.ashx unavailable');
  }

  if (notes.length === 0) {
    return { status: 'aligned', line: `${pinned}; matches upstream and what beanfun ships` };
  }
  // A difference is not by itself a failure — beanfun may keep accepting the old
  // pair for a long time. Say so, so nobody reads this as an outage.
  const hasRealDiff = notes.some((n) => n.startsWith('upstream publishes') || n.startsWith('beanfun ships'));
  return {
    status: hasRealDiff ? 'differs' : 'unknown',
    line: `${pinned}; ${notes.join('; ')}${hasRealDiff ? ' (a difference alone does not mean it is rejected)' : ''}`,
  };
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await got.get(url, {
    timeout: { request: FETCH_TIMEOUT_MS },
    headers: { 'user-agent': USER_AGENT },
    retry: { limit: 0 },
    throwHttpErrors: false,
  });
  if (res.statusCode < 200 || res.statusCode >= 300) throw new Error(`HTTP ${res.statusCode}`);
  return JSON.parse(typeof res.body === 'string' ? res.body : String(res.body)) as unknown;
}

/** Anything that is not obviously a version and a 64-hex hash is treated as absent. */
function readUpstream(v: unknown): { cv: string; hash: string } | null {
  if (typeof v !== 'object' || v === null) return null;
  const { cv, hash } = v as { cv?: unknown; hash?: unknown };
  if (typeof cv !== 'string' || !/^[\d.]+$/.test(cv)) return null;
  if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/i.test(hash)) return null;
  return { cv, hash: hash.toLowerCase() };
}

export async function readGgmSources(): Promise<GgmSources> {
  const problems: string[] = [];
  const [up, bf] = await Promise.allSettled([
    fetchJson(UPSTREAM_PAIR_URL),
    fetchJson(CHECK_VERSION_URL),
  ]);

  let upstream: { cv: string; hash: string } | null = null;
  if (up.status === 'fulfilled') {
    upstream = readUpstream(up.value);
    if (!upstream) problems.push('upstream ggm-client.json was not the expected shape');
  } else {
    problems.push(`upstream fetch failed: ${safeError(up.reason)}`);
  }

  let beanfunVersion: string | null = null;
  if (bf.status === 'fulfilled') {
    const v = (bf.value as { version?: unknown }).version;
    if (typeof v === 'string' && v !== '') beanfunVersion = v;
    else problems.push('CheckVersion.ashx carried no version');
  } else {
    problems.push(`CheckVersion.ashx fetch failed: ${safeError(bf.reason)}`);
  }

  return {
    local: { cv: GGM_CV, hash: GGM_HASH, arch: GGM_ARCH },
    upstream,
    beanfunVersion,
    problems,
  };
}

let cached: { at: number; verdict: GgmVerdict } | undefined;

/**
 * Cached verdict, and never throws: this runs on a path that is already failing,
 * and a network hiccup here must not replace the user's real error with ours.
 */
export async function ggmVerdict(force = false): Promise<GgmVerdict> {
  if (!force && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.verdict;
  let verdict: GgmVerdict;
  try {
    verdict = compareGgm(await readGgmSources());
  } catch (e) {
    verdict = { status: 'unknown', line: `check failed: ${safeError(e)}` };
  }
  cached = { at: Date.now(), verdict };
  return verdict;
}

/** Test seam: drop the cached verdict. */
export function resetGgmCache(): void {
  cached = undefined;
}
