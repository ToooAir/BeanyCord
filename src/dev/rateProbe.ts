/**
 * Dev-only: find out what beanfun's risk control actually does to us, before it
 * does it in production.
 *
 * The exposure is concrete. `sendFreshQr` has no cooldown, so `/login` and the
 * 🔄 button each mint a brand-new QR session on demand, and a login waiting to
 * be scanned posts `CheckLoginStatus` every 2s for up to 150s — up to 75
 * requests. All of it leaves the deployment through one shared egress IP, so
 * what beanfun sees is not one user's traffic, it is everyone's, summed. A
 * report of a desktop client being IP-blocked after two QR requests in a row is
 * what prompted this, but one second-hand sample is not a number to design
 * against.
 *
 * The number is not the valuable part anyway. These four answers are, and unlike
 * a threshold they transfer from whatever IP you measure them on:
 *
 *   1. What a block LOOKS like on the wire. We cannot currently recognise one:
 *      the user sees `❌ 啟動登入失敗:<something>` and nothing is recorded.
 *      Until this is captured once, any detector for it is a guess.
 *   2. WHICH endpoint is gated — minting a QR, or polling one. If polling is
 *      ungated, the 75-request loop is fine and only issuance needs a cooldown.
 *   3. The SCOPE — one endpoint or the whole host, our cookies or our IP.
 *   4. How LONG it lasts. That decides whether an incident is five minutes or a
 *      day, and so whether backing off is enough on its own.
 *
 * Read any threshold it prints as an UPPER BOUND, never as a budget. It is
 * measured with one client, one pSKey, sequentially. Production is several users
 * with several pSKeys concurrently, behind an IP that may be shared with other
 * tenants of the same host. Set production limits well underneath it.
 *
 * Nothing here needs an account: `default.aspx`, `Login/Index`, `InitLogin` and
 * `CheckLoginStatus` all run before anyone has logged in. This probe risks an
 * IP, never a credential.
 *
 * NOTE: the sweeps here deliberately bypass the shipped pSKey budget in
 * `sessionKey.ts` — they call `client.http.get` directly rather than
 * `getSessionKey`. That is the point: a probe whose job is to find the ceiling
 * cannot be subject to the limiter that exists to stay under it. Do not "fix"
 * this by routing it through `getSessionKey`; that would make every run stop at
 * 4 and measure our own constant instead of beanfun's.
 *
 * It stops at the first response that stops looking healthy. The boundary is the
 * measurement; going further past it only deepens whatever penalty is being
 * applied, and buys nothing. Run it somewhere you can get a new IP — a home line
 * you can re-dial — and not on the host that serves users.
 *
 * Usage:
 *   npm run probe:rate                       # print the plan and exit; fires nothing
 *   npm run probe:rate -- --go               # arm 1: mint QR sessions until refused
 *   npm run probe:rate -- --go --arm=poll    # arm 2: poll one QR until refused
 *   npm run probe:rate -- --go --arm=hammer --target=echo --burst=60  # the ping herd, as it really lands
 *   npm run probe:rate -- --go --only=key --gap=90000 --accel=0.75   # staircase for the sustainable rate
 *   npm run probe:rate -- --go --arm=window --after=100             # one window trial at D=100s
 *   npm run probe:rate -- --go --arm=window --search --lo=60 --hi=300
 *   npm run probe:rate -- --go --max=50 --gap=250
 *   npm run probe:rate -- --go --write       # also dump every probe to capture/rate/
 *   npm run probe:rate -- --go --recheck=60 --wait=3600
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Response } from 'got';

import { BeanfunClient, finalUrl } from '../beanfun/client.js';
import { TW } from '../beanfun/endpoints.js';
import { initQrLogin } from '../beanfun/login/qrInit.js';
import { getSessionKey } from '../beanfun/login/sessionKey.js';
import { sessionKeyFromUrl } from '../beanfun/parser.js';
import { dtCompact } from '../beanfun/time.js';
import type { QrLoginInit } from '../beanfun/types.js';
import { redactText, safeError } from '../core/redact.js';

// ---- arguments -------------------------------------------------------------

const argv = process.argv.slice(2);
const has = (flag: string): boolean => argv.includes(flag);
const opt = (name: string): string | undefined =>
  argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const num = (name: string, dflt: number): number => {
  const v = Number(opt(name));
  return Number.isFinite(v) && v >= 0 ? v : dflt;
};

const GO = has('--go');
const WRITE = has('--write');
const ARM = opt('arm') ?? 'issue';
const ONLY = opt('only') ?? 'full';
const TARGET = opt('target') ?? 'echo';
const ACCEL = Number(opt('accel') ?? '1');
const STEP = num('step', 5);
const BURST = Math.max(1, num('burst', 1));
const QUOTA_HINT = Math.max(1, num('quota', 4));
const AFTER_S = num('after', 90);
const SEARCH = has('--search');
const LO_S = num('lo', 60);
const HI_S = num('hi', 300);
const TOL_S = Math.max(1, num('tol', 10));
const SETTLE_S = num('settle', 0);
const MIN_GAP_MS = 250;
const MAX = num('max', 30);
const GAP_MS = num('gap', 0);
const RECHECK_S = num('recheck', 30);
const WAIT_S = num('wait', 1800);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---- one observation -------------------------------------------------------

/**
 * One request, described in the terms a detector would later have to match on.
 *
 * `healthy` is deliberately a positive test — "this is the answer the endpoint
 * gives when it is willing to serve us" — not `!isBlocked`. We do not know what
 * a block looks like; that is the thing being measured. Anything that is not
 * recognisably the good answer counts as a deviation and stops the run, which
 * is the same discipline the GGM canary uses for the same reason: a checker
 * that treats an unrecognised answer as a pass measures nothing forever.
 */
interface Probe {
  step: string;
  host: string;
  status: number;
  ctype: string;
  bytes: number;
  healthy: boolean;
  /** Positively identified as the IP-block page, rather than merely not-healthy. */
  blocked: boolean;
  note: string;
  head: string;
  ms: number;
}

/**
 * Measured 2026-08-19: a blocked IP is served an HTTP 200 `text/html` page that
 * redirects to `/TW/BlockIPMessage.htm`. The status code says nothing — this
 * name is the only honest part of the response, which is why it is matched
 * rather than the body size or the `<html` prefix. (Third time this codebase has
 * met a beanfun endpoint that lies with a 200; see `isLoggedOutEcho`.)
 */
const BLOCK_MARKER = 'BlockIPMessage';

function isIpBlock(res: Response, body: string): boolean {
  return finalUrl(res).includes(BLOCK_MARKER) || body.includes(BLOCK_MARKER);
}

const all: Probe[] = [];

function record(p: Probe): Probe {
  all.push(p);
  return p;
}

function shape(res: Response, step: string, healthy: boolean, note: string): Probe {
  const body = typeof res.body === 'string' ? res.body : String(res.body ?? '');
  // The block page is valid HTML with a 200, so every `is this HTML?` predicate
  // in this file would call it healthy. Veto it once, here, rather than trusting
  // each step to remember — that is exactly the kind of per-caller check this
  // codebase has already got wrong twice.
  const blocked = isIpBlock(res, body);
  let host = '?';
  try {
    host = new URL(res.url).host;
  } catch {
    /* keep the placeholder */
  }
  return record({
    step,
    host,
    status: res.statusCode,
    ctype: (String(res.headers['content-type'] ?? '—').split(';')[0] ?? '—').trim(),
    bytes: Buffer.byteLength(body),
    healthy: healthy && !blocked,
    blocked,
    note,
    head: redactText(body.replace(/\s+/g, ' ').trim().slice(0, 200)),
    ms: Math.round(res.timings?.phases?.total ?? 0),
  });
}

/** A request that never got an answer — a connection reset or a timeout is a
 *  perfectly good way for risk control to say no, so it is an observation too. */
function transportFailure(step: string, host: string, e: unknown): Probe {
  return record({
    step,
    host,
    status: 0,
    ctype: '—',
    bytes: 0,
    healthy: false,
    blocked: false,
    note: `transport error: ${safeError(e)}`,
    head: '',
    ms: 0,
  });
}

const ok2xx = (res: Response): boolean => res.statusCode >= 200 && res.statusCode < 300;

// ---- the individual steps --------------------------------------------------

async function stepSessionKey(c: BeanfunClient): Promise<{ probe: Probe; key: string | null }> {
  const url = `${TW.portalBase}beanfun_block/bflogin/default.aspx?service=999999_T0`;
  try {
    const res = await c.http.get(url);
    const key =
      [finalUrl(res), res.url, ...(res.redirectUrls ?? []).map(String)]
        .map((u) => sessionKeyFromUrl(u))
        .find((k): k is string => Boolean(k)) ?? null;
    const healthy = ok2xx(res) && key !== null;
    return {
      probe: shape(
        res,
        'default.aspx',
        healthy,
        healthy ? 'pSKey issued' : key === null ? 'no pSKey on the final URL' : `HTTP ${res.statusCode}`,
      ),
      key,
    };
  } catch (e) {
    return { probe: transportFailure('default.aspx', 'tw.beanfun.com', e), key: null };
  }
}

async function stepIndex(c: BeanfunClient, key: string): Promise<Probe> {
  const url = `${TW.loginBase}Login/Index?pSKey=${encodeURIComponent(key)}`;
  try {
    const res = await c.http.get(url, { headers: { accept: 'text/html' } });
    const healthy = ok2xx(res) && /<html/i.test(String(res.body ?? ''));
    return shape(res, 'Login/Index', healthy, healthy ? 'login page served' : 'not the login page');
  } catch (e) {
    return transportFailure('Login/Index', 'login.beanfun.com', e);
  }
}

async function stepInitLogin(c: BeanfunClient, key: string): Promise<Probe> {
  const indexUrl = `${TW.loginBase}Login/Index?pSKey=${encodeURIComponent(key)}`;
  const url = `${TW.loginBase}Login/InitLogin?pSKey=${encodeURIComponent(key)}`;
  try {
    const res = await c.http.get(url, {
      headers: {
        accept: 'application/json, text/plain, */*',
        referer: indexUrl,
        'x-requested-with': 'XMLHttpRequest',
        origin: 'https://login.beanfun.com',
      },
    });
    let healthy = false;
    let note = 'body is not JSON';
    try {
      const j = JSON.parse(String(res.body ?? '')) as {
        Result?: number;
        ResultData?: { QRImage?: string };
      };
      healthy = ok2xx(res) && j.Result === 0 && Boolean(j.ResultData?.QRImage);
      note = healthy ? 'QR issued' : `Result=${String(j.Result)}, QRImage=${j.ResultData?.QRImage ? 'yes' : 'no'}`;
    } catch {
      /* note already says so */
    }
    return shape(res, 'Login/InitLogin', healthy, note);
  } catch (e) {
    return transportFailure('Login/InitLogin', 'login.beanfun.com', e);
  }
}

/** The four `ResultMessage` values `qrPoll.ts` is willing to act on. Anything
 *  else is, by that module's own rule, an error — so it is a deviation here. */
const KNOWN_POLL_RESULTS = ['Failed', 'Wait Login', 'Token Expired', 'Success'];

async function stepPoll(c: BeanfunClient, init: QrLoginInit): Promise<Probe> {
  const referer = `${TW.loginBase}Login/Index?pSKey=${encodeURIComponent(init.skey)}`;
  const headers: Record<string, string> = {
    accept: 'application/json, text/plain, */*',
    referer,
    origin: 'https://login.beanfun.com',
    'content-type': 'application/x-www-form-urlencoded',
    'content-length': '0',
  };
  if (init.verificationToken !== '') headers['requestverificationtoken'] = init.verificationToken;
  try {
    const res = await c.http.post(`${TW.loginBase}QRLogin/CheckLoginStatus`, { headers, body: '' });
    let healthy = false;
    let note = 'body is not JSON';
    try {
      const j = JSON.parse(String(res.body ?? '')) as { ResultMessage?: string };
      healthy = ok2xx(res) && KNOWN_POLL_RESULTS.includes(String(j.ResultMessage));
      note = `ResultMessage=${String(j.ResultMessage)}`;
    } catch {
      /* note already says so */
    }
    return shape(res, 'CheckLoginStatus', healthy, note);
  } catch (e) {
    return transportFailure('CheckLoginStatus', 'login.beanfun.com', e);
  }
}

/**
 * A GET of something that answers without a session, so it can be asked "are
 * you blocked?" on its own. Both callers below are public: `game_zone/` serves
 * the catalogue to anyone, and `echo_token.ashx` answers a session-less caller
 * with a logged-out echo rather than an error.
 */
async function stepPublic(
  c: BeanfunClient,
  url: string,
  label: string,
  healthyWhen: (body: string) => boolean,
): Promise<Probe> {
  try {
    const res = await c.http.get(url, { headers: { accept: '*/*' } });
    const body = String(res.body ?? '');
    const healthy = ok2xx(res) && healthyWhen(body);
    return shape(res, label, healthy, healthy ? 'answering normally' : 'not the expected content');
  } catch (e) {
    return transportFailure(label, new URL(url).host, e);
  }
}

/** A plain GET of a host's front door — the cheapest way to ask "is it this one
 *  endpoint, or is this whole host done with us?". */
async function stepRoot(c: BeanfunClient, base: string, label: string): Promise<Probe> {
  try {
    const res = await c.http.get(base, { headers: { accept: 'text/html' } });
    const healthy = ok2xx(res) && /<html/i.test(String(res.body ?? ''));
    return shape(res, label, healthy, healthy ? 'serving normally' : 'not serving a page');
  } catch (e) {
    return transportFailure(label, new URL(base).host, e);
  }
}

// ---- reporting -------------------------------------------------------------

function line(n: number, p: Probe): string {
  const mark = p.healthy ? ' ok ' : p.blocked ? 'BLOK' : '>>>>';
  return (
    `${String(n).padStart(3)} ${mark} ${p.step.padEnd(16)} ` +
    `HTTP ${String(p.status).padStart(3)}  ${p.ctype.padEnd(26)} ` +
    `${String(p.bytes).padStart(7)}B ${String(p.ms).padStart(5)}ms  ${p.note}`
  );
}

/**
 * The single most valuable thing this script produces. Everything else is a
 * number that may not transfer; this is the shape a refusal has on the wire,
 * which is what `flow.ts` would need in order to ever say "we are rate-limited"
 * instead of dumping an opaque error into a DM.
 */
function reportSignature(p: Probe): void {
  console.log('\n--- what a refusal looks like (this is what a detector must match) ---');
  console.log(`  step          : ${p.step}`);
  console.log(`  host          : ${p.host}`);
  console.log(`  HTTP status   : ${p.status}`);
  console.log(`  content-type  : ${p.ctype}`);
  console.log(`  body bytes    : ${p.bytes}`);
  console.log(`  why not ok    : ${p.note}`);
  console.log(`  IP-block page : ${p.blocked ? `yes — carries "${BLOCK_MARKER}"` : 'no — this is some OTHER failure'}`);
  console.log(`  body head     : ${p.head || '<empty>'}`);
}

// ---- arms ------------------------------------------------------------------

/**
 * Windows to count successes over when something finally refuses us.
 *
 * Measured 2026-08-19, `default.aspx` refused the 5th request whether the five
 * took 12s, 35s or 76s — so it counts requests, not rate, and the only open
 * question left is how wide the window is. The smallest window here whose count
 * equals the burst quota is that width, which is the number a token bucket has
 * to be built around.
 */
const TRAILING_WINDOWS_S = [30, 45, 60, 75, 90, 120, 150, 180, 240, 300, 600, 900];

/** Every request the sweep made, so the raw evidence is printed rather than a
 *  derived summary that has to be trusted. */
interface Event {
  at: number;
  ok: boolean;
}

function reportTimeline(events: Event[], t0: number): void {
  console.log('\n--- every request, as the server saw them ---');
  console.log('    #      t(s)    gap(s)   result');
  let prev: number | null = null;
  events.forEach((e, i) => {
    const t = (e.at - t0) / 1_000;
    const gap = prev === null ? '     —' : ((e.at - prev) / 1_000).toFixed(1).padStart(6);
    console.log(`  ${String(i + 1).padStart(3)}  ${t.toFixed(1).padStart(8)}  ${gap}   ${e.ok ? 'ok' : 'REFUSED'}`);
    prev = e.at;
  });
}

function reportTrailing(okAt: number[], at: number): void {
  if (okAt.length === 0) return;
  console.log('\n--- successes still inside the trailing window at that moment ---');
  for (const w of TRAILING_WINDOWS_S) {
    const n = okAt.filter((t) => at - t <= w * 1_000).length;
    console.log(`  last ${String(w).padStart(3)}s : ${n}`);
  }
}

/**
 * Bracket the counting window W from the run.
 *
 * With a quota of Q successes per window (measured: Q = 4), every request in the
 * sweep constrains W, not just the one that was refused:
 *
 *   - the refusal at T proves at least Q successes were still inside W,
 *     so  W >= T - s(n-Q+1)                                     [lower bound]
 *   - EVERY served request s(i) proves its Q-th predecessor had already fallen
 *     out, so  W < s(i) - s(i-Q)  — take the tightest of them   [upper bound]
 *
 * Using every served request rather than only the last five matters: at a
 * perfectly uniform spacing the two bounds computed from one stage collapse onto
 * the same number and say nothing. It is the staircase — faster stages near the
 * refusal, slower ones before it — that separates them.
 */
const QUOTA = 4;

function reportWindowBracket(okAt: number[], refusedAt: number): void {
  if (okAt.length < QUOTA + 1) {
    console.log(`\n(need ${QUOTA + 1} successes before the refusal to bracket the window; had ${okAt.length}.)`);
    return;
  }
  const lower = (refusedAt - okAt[okAt.length - QUOTA]!) / 1_000;

  let upper = Infinity;
  let upperAt = -1;
  for (let i = QUOTA; i < okAt.length; i++) {
    const span = (okAt[i]! - okAt[i - QUOTA]!) / 1_000;
    if (span < upper) {
      upper = span;
      upperAt = i + 1;
    }
  }

  console.log(`\n--- the counting window, bracketed (assuming the quota is ${QUOTA}) ---`);
  console.log(`  lower bound : ${lower.toFixed(1)}s  — ${QUOTA} successes were still inside W when we were refused`);
  console.log(`  upper bound : ${upper.toFixed(1)}s  — request #${upperAt} was served, so ${QUOTA} did not fit in W then`);

  if (lower < upper) {
    console.log(`\n  W is between ${lower.toFixed(1)}s and ${upper.toFixed(1)}s.`);
    console.log(`  A limiter of ${QUOTA} per ${Math.ceil(upper)}s (or slower) can never trip this one.`);
  } else {
    console.log('\n  The bounds cross. Either the quota is not 4, or the limiter is not a plain');
    console.log('  sliding window — read the timeline above directly rather than this summary.');
  }
}

/**
 * One sweep: fire `fire` until it returns a bad probe or `MAX` rounds pass.
 *
 * `--accel` turns this into a staircase — start at a gap believed to be safe and
 * tighten it every `--step` survivals. A sweep that starts fast only ever
 * measures the burst quota, which is already known; starting slow and closing in
 * is what finds the sustainable rate, and it is the sustainable rate that says
 * whether a token bucket can be generous or has to be miserly.
 */
/** What one round did: the first refusal it saw (if any) and how many of its
 *  requests actually succeeded — a burst round can be partly served. */
interface Fired {
  bad: Probe | null;
  ok: number;
}

/**
 * Fire `BURST` requests at once and report the round as a whole.
 *
 * Sequential sweeps measure a rate; production does not produce one. `restore()`
 * starts every session's keep-alive timer inside a single tight loop, so after a
 * redeploy N pings leave together, and `account.ts` fans `game_start_step2.aspx`
 * out with `Promise.all`, so one user with N characters bursts N at once. A
 * limiter counting per second sees nothing alike in the two shapes, so the
 * sequential number transfers to neither.
 *
 * A partly-served burst is the interesting outcome: it says how many the server
 * will take before it starts refusing, which is exactly the bucket depth.
 */
async function burstOf(round: number, label: string, one: () => Promise<Probe>): Promise<Fired> {
  const t0 = Date.now();
  const probes = await Promise.all(Array.from({ length: BURST }, () => one()));
  const bad = probes.find((p) => !p.healthy) ?? null;
  const ok = probes.filter((p) => p.healthy).length;
  const blocked = probes.filter((p) => p.blocked).length;
  const mark = bad === null ? ' ok ' : blocked > 0 ? 'BLOK' : '>>>>';
  console.log(
    `${String(round).padStart(3)} ${mark} ${label.padEnd(16)} x${String(BURST).padEnd(4)} ` +
      `${String(ok).padStart(3)} ok / ${String(blocked).padStart(3)} blocked / ` +
      `${String(probes.length - ok - blocked).padStart(3)} other   ${String(Date.now() - t0).padStart(5)}ms wall`,
  );
  return { bad, ok };
}

async function sweep(
  title: string,
  subtitle: string,
  fire: (round: number) => Promise<Fired>,
): Promise<Probe | null> {
  console.log(`\n=== ${title} ===`);
  console.log(`${subtitle}\n`);
  const t0 = Date.now();
  const okAt: number[] = [];
  const events: Event[] = [];
  let gap = GAP_MS;

  for (let i = 1; i <= MAX; i++) {
    const { bad, ok } = await fire(i);
    const now = Date.now();
    for (let k = 0; k < ok; k++) {
      okAt.push(now);
      events.push({ at: now, ok: true });
    }
    if (bad) {
      events.push({ at: now, ok: false });
      console.log(`\n>>> refused on round ${i}, ${((now - t0) / 1_000).toFixed(1)}s into the sweep.`);
      console.log(`    ${okAt.length} requests had been served before that.`);
      if (ACCEL < 1) console.log(`    The gap in effect was ${(gap / 1_000).toFixed(1)}s.`);
      reportTimeline(events, t0);
      reportTrailing(okAt, now);
      reportWindowBracket(okAt, now);
      return bad;
    }

    if (ACCEL < 1 && i % STEP === 0 && gap > MIN_GAP_MS) {
      gap = Math.max(MIN_GAP_MS, Math.round(gap * ACCEL));
      console.log(`     ── ${STEP} in a row survived; tightening the gap to ${(gap / 1_000).toFixed(1)}s ──`);
    }
    // Not after the last round: the trailing-window report is taken at "now",
    // and a final sleep would push every success out of the short windows and
    // make an untroubled sweep look idle.
    if (gap > 0 && i < MAX) await sleep(gap);
  }

  console.log(
    `\n>>> ${MAX} rounds (${okAt.length} requests${BURST > 1 ? `, ${BURST} at a time` : ''}) ` +
      `over ${((Date.now() - t0) / 1_000).toFixed(1)}s with no refusal.`,
  );
  console.log('    A ceiling that was never reached is not the same as no ceiling.');
  reportTimeline(events, t0);
  reportTrailing(okAt, Date.now());
  return null;
}

/** One press of `/login`, request for request: a fresh client (production calls
 *  `resetClient` first, so there are no carried cookies), then the three GETs. */
async function mintOnce(round: number): Promise<Fired> {
  // A burst only models anything real when the round is one request. The full
  // chain is three sequential steps sharing a client, so bursting it would be a
  // shape production never produces.
  if (BURST > 1) {
    if (ONLY !== 'key') throw new Error('--burst needs --only=key (the full chain is sequential per user)');
    return burstOf(round, 'default.aspx', async () => (await stepSessionKey(new BeanfunClient())).probe);
  }

  const c = new BeanfunClient();

  const { probe: p1, key } = await stepSessionKey(c);
  console.log(line(round, p1));
  if (!p1.healthy || key === null) return { bad: p1, ok: 0 };

  // `--only=key` stops here. The refusal landed on `default.aspx` and nothing on
  // login.beanfun.com was ever refused, so the counter is kept on this one
  // request — confirmed by this mode reaching the identical threshold as the
  // full chain. One request per round also makes a rate sweep about a rate
  // rather than about a request mix.
  if (ONLY === 'key') return { bad: null, ok: 1 };

  const p2 = await stepIndex(c, key);
  console.log(line(round, p2));
  if (!p2.healthy) return { bad: p2, ok: 1 };

  const p3 = await stepInitLogin(c, key);
  console.log(line(round, p3));
  if (!p3.healthy) return { bad: p3, ok: 1 };

  return { bad: null, ok: 1 };
}

function armIssue(): Promise<Probe | null> {
  const accel = ACCEL < 1 ? `, tightening x${ACCEL} every ${STEP}` : '';
  return sweep(
    `arm 1 — mint QR sessions until refused (max ${MAX}, gap ${(GAP_MS / 1_000).toFixed(1)}s${accel})`,
    ONLY === 'key'
      ? 'Only default.aspx per round — one request, to isolate what is being counted.'
      : 'Each round is exactly what pressing /login does: three requests across two hosts.',
    mintOnce,
  );
}

async function armPoll(): Promise<Probe | null> {
  const c = new BeanfunClient();
  let init: QrLoginInit;
  try {
    init = await initQrLogin(c, await getSessionKey(c));
  } catch (e) {
    console.log(`could not mint a QR to poll: ${safeError(e)}`);
    console.log('If arm 1 ran recently, this IP may still be blocked — wait for it to clear first.');
    return null;
  }

  let terminal = false;
  const bad = await sweep(
    `arm 2 — poll one QR session until refused (max ${MAX}, gap ${(GAP_MS / 1_000).toFixed(1)}s)`,
    "This is the request the bot repeats every 2s for up to 150s while it waits.\nQR minted; hammering the poll.",
    async (i) => {
      const p = await stepPoll(c, init);
      console.log(line(i, p));
      if (!p.healthy) return { bad: p, ok: 0 };
      // A QR that expires or gets scanned still answers healthily, but it stops
      // being a measurement — every further poll asks about a dead token, not
      // about our request rate.
      if (p.note.includes('Token Expired') || p.note.includes('Success')) {
        terminal = true;
        return { bad: p, ok: 1 }; // ends the sweep; unpicked below, not a block
      }
      return { bad: null, ok: 1 };
    },
  );
  if (terminal) {
    console.log('\n    ...but that was the QR reaching a terminal state, not a refusal.');
    console.log('    The poll survived a whole QR lifetime ungated — that is the finding.');
    return null;
  }
  return bad;
}

/**
 * The endpoints a logged-in user's traffic actually lands on, each hammered on
 * its own.
 *
 * `default.aspx` having a quota tells us nothing about these: arm 3 only showed
 * that its block does not *cover* them, not that they have no counter of their
 * own. That distinction is load-bearing. `echo_token.ashx` is fired once per
 * minute per live session and `restore()` starts every session's timer inside
 * one tight loop, so after a redeploy N sessions hit it simultaneously, forever.
 * `game_start_step2.aspx` is fanned out with `Promise.all`, one request per
 * character, so a single user with eight characters bursts eight at once.
 *
 * All four answer without a session, so this costs no credentials.
 */
interface Target {
  label: string;
  url: () => string;
  healthyWhen: (body: string) => boolean;
}

const TARGETS: Record<string, Target> = {
  echo: {
    label: 'echo_token.ashx',
    url: () => `${TW.portalBase}beanfun_block/generic_handlers/echo_token.ashx?webtoken=1`,
    healthyWhen: (b) => b.includes('EchoTokenResult'),
  },
  step2: {
    label: 'game_start_step2',
    url: () =>
      `${TW.portalBase}beanfun_block/game_zone/game_start_step2.aspx` +
      `?service_code=610074&service_region=T9&sotp=0&dt=${dtCompact()}`,
    healthyWhen: (b) => /<html/i.test(b),
  },
  zone: {
    label: 'game_zone/',
    url: () => `${TW.portalBase}game_zone/`,
    healthyWhen: (b) => /<html/i.test(b),
  },
  ini: {
    label: 'get_service_ini',
    url: () => `${TW.portalBase}beanfun_block/generic_handlers/get_service_ini.ashx`,
    healthyWhen: (b) => b.trim().length > 0,
  },
};

function armHammer(): Promise<Probe | null> {
  const t = TARGETS[TARGET];
  if (!t) throw new Error(`unknown --target=${TARGET} (expected ${Object.keys(TARGETS).join(', ')})`);
  const accel = ACCEL < 1 ? `, tightening x${ACCEL} every ${STEP}` : '';
  const c = new BeanfunClient();
  return sweep(
    `arm 5 — hammer ${t.label} on its own (max ${MAX} rounds x${BURST}, gap ${(GAP_MS / 1_000).toFixed(1)}s${accel})`,
    BURST > 1
      ? `${BURST} requests fired at once per round, no session — the shape production actually makes.`
      : 'One request per round, no session. Does THIS endpoint have a counter of its own?',
    async (i) => {
      if (BURST > 1) {
        return burstOf(i, t.label, () => stepPublic(new BeanfunClient(), t.url(), t.label, t.healthyWhen));
      }
      const p = await stepPublic(c, t.url(), t.label, t.healthyWhen);
      console.log(line(i, p));
      return { bad: p.healthy ? null : p, ok: p.healthy ? 1 : 0 };
    },
  );
}

/**
 * Find the counting window's WIDTH, without the penalty hiding it.
 *
 * "How long after a refusal does it clear" cannot answer this: a refusal starts
 * a fixed 4-5 minute penalty, and that penalty is what the recovery measures.
 * The window has to be probed from below instead — fill the quota, wait, and
 * see whether one more is still refused:
 *
 *   fill Q mints back to back, then send one more D seconds after the FIRST
 *     refused  => the first is still counted     => W >= D
 *     allowed  => the first has aged out         => W <  D
 *
 * So D's flip point IS the window. The fill also calibrates Q for free: if it is
 * refused partway, the real quota is however many got through, which is worth
 * knowing on its own — a production refusal on 2026-08-19 was consistent either
 * with a quota of 3 or a window past 90s, and this separates them.
 */
async function fillQuota(quota: number): Promise<{ at: number[]; refusedAt: Probe | null }> {
  const at: number[] = [];
  for (let i = 1; i <= quota; i++) {
    const { probe } = await stepSessionKey(new BeanfunClient());
    console.log(line(i, probe));
    if (!probe.healthy) return { at, refusedAt: probe };
    at.push(Date.now());
  }
  return { at, refusedAt: null };
}

interface WindowTrial {
  afterS: number;
  filled: number;
  refused: boolean | null;
}

async function windowTrial(afterS: number, quota: number): Promise<WindowTrial> {
  console.log(`\n--- trial: fill ${quota}, then one more ${afterS}s after the first ---`);
  const { at, refusedAt } = await fillQuota(quota);

  if (refusedAt) {
    console.log(`\n>>> refused while still FILLING, after ${at.length} mints.`);
    console.log(`    The quota on this address is ${at.length}, not ${quota}. Re-run with --quota=${at.length}.`);
    return { afterS, filled: at.length, refused: null };
  }

  const first = at[0]!;
  const fireAt = first + afterS * 1_000;
  const wait = fireAt - Date.now();
  if (wait < 0) {
    console.log(`\n>>> the fill itself took ${((Date.now() - first) / 1_000).toFixed(1)}s, past --after=${afterS}.`);
    console.log('    Nothing to measure; raise --after.');
    return { afterS, filled: at.length, refused: null };
  }
  console.log(`\nfilled in ${((at[at.length - 1]! - first) / 1_000).toFixed(1)}s; holding ${(wait / 1_000).toFixed(1)}s...`);
  await sleep(wait);

  const { probe } = await stepSessionKey(new BeanfunClient());
  const now = Date.now();
  console.log(line(quota + 1, probe));

  console.log('\n  #   minted at   gap(s)   age at the probe(s)');
  at.forEach((t, i) => {
    const gap = i === 0 ? '    —' : ((t - at[i - 1]!) / 1_000).toFixed(1).padStart(5);
    console.log(`  ${String(i + 1).padStart(2)}  ${((t - first) / 1_000).toFixed(1).padStart(9)}  ${gap}   ${((now - t) / 1_000).toFixed(1).padStart(10)}`);
  });

  const refused = !probe.healthy;
  console.log('');
  if (refused) {
    console.log(`>>> REFUSED at D=${afterS}s — the first mint still counts. W >= ${afterS}s.`);
  } else {
    console.log(`>>> ALLOWED at D=${afterS}s — the first mint has aged out. W < ${afterS}s.`);
  }
  return { afterS, filled: at.length, refused };
}

/** Between trials: serve any penalty, then let the window drain completely, so
 *  the next trial starts from an empty counter rather than the last one's tail. */
async function settle(refused: boolean, hiS: number): Promise<void> {
  const s = SETTLE_S > 0 ? SETTLE_S : (refused ? 330 : 0) + hiS + 30;
  console.log(`\nsettling ${s}s before the next trial (penalty + a full window)...`);
  await sleep(s * 1_000);
}

async function armWindow(): Promise<Probe | null> {
  console.log('\n=== arm 6 — how wide is the counting window? ===');
  console.log('Probed from below, so no measurement is taken while a penalty is running.\n');

  if (!SEARCH) {
    await windowTrial(AFTER_S, QUOTA_HINT);
    console.log('\nRun again with a different --after to bracket it, or use --search.');
    return null;
  }

  let lo = LO_S;
  let hi = HI_S;
  console.log(`binary search for W in [${lo}, ${hi}]s, stopping within ${TOL_S}s.\n`);
  while (hi - lo > TOL_S) {
    const mid = Math.round((lo + hi) / 2);
    const t = await windowTrial(mid, QUOTA_HINT);
    if (t.refused === null) {
      console.log('\n>>> trial inconclusive; stopping rather than searching on bad data.');
      return null;
    }
    if (t.refused) lo = mid;
    else hi = mid;
    console.log(`\n>>> W is now bracketed to [${lo}, ${hi}]s.`);
    if (hi - lo > TOL_S) await settle(t.refused, hi);
  }
  console.log(`\n>>> W is between ${lo}s and ${hi}s.`);
  console.log(`    A limiter whose window is >= ${hi}s can never be surprised by this one.`);
  return null;
}

/**
 * Only worth running once something has already said no.
 *
 * The question it settles is not academic. If a block reaches only the login
 * entry point, an incident is "nobody can start a new login for five minutes".
 * If it also covers `echo_token.ashx` and `game_zone/`, it reaches users who are
 * already logged in — and `otp.ts` treats any HTML page where it expected the
 * long-polling key as a dead session, so a block would tell those users their
 * login expired and send them to the one path that is actually blocked.
 */
async function armScope(): Promise<void> {
  console.log('\n=== arm 3 — how wide is it? ===');
  console.log('A brand-new client, so nothing we are carrying can be the reason.');
  console.log('Every endpoint below answers without a session, so this costs no credentials.\n');

  const verdict = (p: Probe): string =>
    p.blocked
      ? `BLOCKED (the ${BLOCK_MARKER} page)`
      : p.healthy
        ? 'reachable'
        : `unclear — HTTP ${p.status}, ${p.note}`;

  const fresh = new BeanfunClient();
  const portal = await stepRoot(fresh, TW.portalBase, 'portal root');
  const login = await stepRoot(fresh, TW.loginBase, 'login root');
  const { probe: sk } = await stepSessionKey(new BeanfunClient());
  const echo = await stepPublic(new BeanfunClient(), TARGETS.echo!.url(), 'echo_token.ashx', TARGETS.echo!.healthyWhen);
  const step2 = await stepPublic(new BeanfunClient(), TARGETS.step2!.url(), 'game_start_step2', TARGETS.step2!.healthyWhen);
  const zone = await stepPublic(new BeanfunClient(), TARGETS.zone!.url(), 'game_zone/', TARGETS.zone!.healthyWhen);

  console.log(`  tw.beanfun.com front door        : ${verdict(portal)}`);
  console.log(`  login.beanfun.com front door     : ${verdict(login)}`);
  console.log(`  default.aspx      (login entry)  : ${verdict(sk)}`);
  console.log(`  echo_token.ashx   (keep-alive)   : ${verdict(echo)}`);
  console.log(`  game_start_step2  (account list) : ${verdict(step2)}`);
  console.log(`  game_zone/        (game menu)    : ${verdict(zone)}`);

  console.log('');
  if (echo.blocked || zone.blocked || step2.blocked) {
    console.log('  Reading: the block reaches PAST login into the session path. An incident is');
    console.log('  not just "no new logins" — users already signed in break too, and otp.ts will');
    console.log('  call it an expired session and send them to re-login, which is blocked.');
  } else if (sk.blocked) {
    console.log('  Reading: only the login entry point is blocked. Users already signed in keep');
    console.log('  working; an incident is confined to starting a NEW login.');
  } else {
    console.log('  Reading: mixed. Read the lines above directly rather than trusting this.');
  }
  console.log('  Either way this shows only what the CURRENT block covers, never that an');
  console.log('  endpoint has no counter of its own. Use --arm=hammer for that.');

  console.log('');
  console.log('  Still unanswered here, and only you can answer it: is this the IP or this');
  console.log('  machine? Open https://tw.beanfun.com/ on a phone with Wi-Fi OFF. If it works,');
  console.log('  it is the IP — which is the case that matters, because production shares one.');
  console.log('  (A phone that is ALSO blocked proves less: cellular is often CGNAT, so you may');
  console.log('  be sharing an address with whoever tripped it first.)');
}

async function armRecover(recheck: () => Promise<Probe>): Promise<void> {
  console.log(`\n=== arm 4 — how long does it last? (rechecking every ${RECHECK_S}s, giving up after ${Math.round(WAIT_S / 60)}min) ===`);
  console.log('Measured twice on 2026-08-19: a blocked request does NOT extend the penalty,');
  console.log('so rechecking is free — the clock runs regardless of what we do during it.\n');

  const t0 = Date.now();
  const deadline = t0 + WAIT_S * 1_000;
  let n = 0;
  while (Date.now() < deadline) {
    await sleep(RECHECK_S * 1_000);
    n++;
    const probe = await recheck();
    const mins = (Date.now() - t0) / 60_000;
    if (probe.healthy) {
      const lower = ((n - 1) * RECHECK_S) / 60;
      console.log(`\n>>> RECOVERED. The block lasted between ${lower.toFixed(1)} and ${mins.toFixed(1)} minutes.`);
      return;
    }
    console.log(`      +${mins.toFixed(1)}min — still refused (HTTP ${probe.status}${probe.blocked ? `, ${BLOCK_MARKER}` : ''})`);
  }
  console.log(`\n>>> still refused after ${Math.round(WAIT_S / 60)} minutes. That is itself the finding:`);
  console.log('    this is not a short penalty, and backing off is not a sufficient answer to it.');
}

// ---- main ------------------------------------------------------------------

function printPlan(): void {
  console.log('rateProbe — measure beanfun risk control from an IP you can afford to lose.');
  console.log('');
  console.log('This fires REAL requests deliberately intended to reach a refusal. Expect this');
  console.log('IP to be blocked from beanfun for an unknown period. Do not run it on the host');
  console.log('that serves users; run it where a re-dial gets you a new address.');
  console.log('');
  console.log('It needs no beanfun account — every endpoint it touches is pre-login.');
  console.log('');
  console.log(`  arm      : ${ARM}   (issue = mint QR sessions, poll = hammer one QR's poll)`);
  console.log(`  only     : ${ONLY}  (full = the whole /login chain, key = default.aspx alone)`);
  console.log(`  target   : ${TARGET}  (--arm=hammer only; one of ${Object.keys(TARGETS).join(', ')})`);
  console.log(`  accel    : ${ACCEL}${ACCEL < 1 ? ` — tighten the gap every ${STEP} survivals` : ' (no staircase)'}`);
  console.log(`  burst    : ${BURST}${BURST > 1 ? ' fired concurrently per round' : ' (sequential)'}`);
  console.log(
    `  window   : --arm=window fills ${QUOTA_HINT} then probes ` +
      (SEARCH ? `by binary search over [${LO_S}, ${HI_S}]s to within ${TOL_S}s` : `once at D=${AFTER_S}s`),
  );
  console.log(`  max      : ${MAX} rounds`);
  console.log(`  gap      : ${GAP_MS}ms between rounds`);
  console.log(`  recheck  : every ${RECHECK_S}s, for up to ${Math.round(WAIT_S / 60)}min, once blocked`);
  console.log(`  write    : ${WRITE ? 'capture/rate/' : 'off'}`);
  console.log('');
  console.log('Add --go to actually run it.');
}

async function main(): Promise<void> {
  if (!GO) {
    printPlan();
    return;
  }
  if (ARM !== 'issue' && ARM !== 'poll' && ARM !== 'hammer' && ARM !== 'window') {
    console.error(`unknown --arm=${ARM} (expected "issue", "poll", "hammer" or "window")`);
    process.exitCode = 2;
    return;
  }

  console.log(`rateProbe starting — arm=${ARM}, max=${MAX}, gap=${GAP_MS}ms, accel=${ACCEL}`);
  const blocked =
    ARM === 'issue'
      ? await armIssue()
      : ARM === 'poll'
        ? await armPoll()
        : ARM === 'window'
          ? await armWindow()
          : await armHammer();

  if (blocked) {
    reportSignature(blocked);
    await armScope();
    // Watch the endpoint that actually refused us. Watching `default.aspx` while
    // a different endpoint is in penalty would report a recovery that never
    // happened — and would burn this IP's login quota doing it.
    const t = TARGETS[TARGET];
    await armRecover(
      ARM === 'hammer' && t
        ? () => stepPublic(new BeanfunClient(), t.url(), t.label, t.healthyWhen)
        : async () => (await stepSessionKey(new BeanfunClient())).probe,
    );
  } else {
    console.log('\nNothing refused us, so there is no signature to capture and nothing to wait out.');
    console.log('A ceiling that was never reached is not the same as no ceiling: say "not found');
    console.log(`below ${MAX}", not "there is no limit".`);
  }

  if (WRITE) {
    const dir = join(process.cwd(), 'capture', 'rate');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${ARM}.json`);
    writeFileSync(file, JSON.stringify({ arm: ARM, max: MAX, gapMs: GAP_MS, probes: all }, null, 2));
    console.log(`\nraw probes -> ${file}`);
  }
}

void main().catch((e: unknown) => {
  console.error('rateProbe failed:', safeError(e));
  process.exitCode = 1;
});
