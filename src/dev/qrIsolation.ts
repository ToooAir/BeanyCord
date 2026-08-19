/**
 * Dev-only: prove that two logins in flight at the same time cannot be mixed up.
 *
 * The worry is specific to how this bot is deployed. Every user's traffic leaves
 * through one egress IP, and the shared pSKey budget means up to four QR
 * challenges can legitimately be waiting for a scan at once. If beanfun keyed a
 * QR challenge by source address rather than by the caller's own session, one
 * person scanning would be reported to somebody else's poll — and the failure
 * would be the worst kind this project can ship, since it hands one user's
 * account to another.
 *
 * The code side of that is already settled by construction: `resetClient` gives
 * each user a fresh `BeanfunClient` with its own `CookieJar`, every step of the
 * login chain takes that client explicitly, and every module-level map in
 * `flow.ts` is keyed by user id. Measured alongside it, two clients on one IP
 * get distinct pSKeys, distinct QR images and distinct `GamaLoginSession`
 * cookies — so the identifiers are distinct.
 *
 * Distinct identifiers are not the same as the server ROUTING by them, and that
 * is what this script tests, which needs a real scan and cannot be asserted from
 * a unit test. It opens two challenges, asks for exactly ONE of them to be
 * approved, and watches both:
 *
 *   1. only the approved one may reach Success — the other must stay waiting;
 *   2. finalising the approved one must yield a session carrying ITS pSKey;
 *   3. finalising the untouched one must FAIL, which is the second line of
 *      defence: even a poll that lied would leave the victim with a refused
 *      login rather than someone else's account.
 *
 * Run 2026-08-19 with a real scan, and all three held: only the approved
 * challenge reached Success while the untouched one stayed waiting, the session
 * came back carrying its own pSKey, and the untouched challenge was refused.
 * Note WHERE it was refused — `Login/SendLogin` serves no form at all for an
 * unapproved session, so the refusal lands two steps before `return.aspx` is
 * ever posted, earlier than the missing-token failure that was predicted.
 *
 * Costs two pSKeys from the shared budget and one real login on the account
 * whose app does the approving. Nothing is written that could identify it: the
 * web token is reported as a hash prefix.
 *
 * Usage:
 *   npm run probe:isolation
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { BeanfunClient } from '../beanfun/client.js';
import { BeanfunError } from '../beanfun/errors.js';
import { finalizeQrLogin } from '../beanfun/login/qrFinalize.js';
import { initQrLogin } from '../beanfun/login/qrInit.js';
import { pollQrLogin } from '../beanfun/login/qrPoll.js';
import { getSessionKey } from '../beanfun/login/sessionKey.js';
import type { QrLoginInit, QrPollOutcome } from '../beanfun/types.js';
import { safeError } from '../core/redact.js';

const POLL_INTERVAL_MS = 2_000;
const TTL_MS = 150_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const fp = (v: string): string => createHash('sha256').update(v).digest('hex').slice(0, 12);

interface Challenge {
  label: string;
  client: BeanfunClient;
  init: QrLoginInit;
  outcome: QrPollOutcome | 'error';
}

async function openChallenge(label: string): Promise<Challenge> {
  const client = new BeanfunClient();
  const init = await initQrLogin(client, await getSessionKey(client));
  return { label, client, init, outcome: 'WaitLogin' };
}

/** One poll that reports rather than throws — a challenge failing to answer is
 *  itself a result here, and must not abort the other one's observation. */
async function pollOnce(c: Challenge): Promise<QrPollOutcome | 'error'> {
  try {
    return await pollQrLogin(c.client, c.init);
  } catch (e) {
    console.log(`  ${c.label}: poll failed — ${safeError(e)}`);
    return 'error';
  }
}

async function main(): Promise<void> {
  console.log('Opening two independent QR challenges from this one IP...\n');
  const a = await openChallenge('A');
  const b = await openChallenge('B');

  console.log('--- the two identities ---');
  console.log(`  pSKey            : A=${fp(a.init.skey)}  B=${fp(b.init.skey)}  distinct=${a.init.skey !== b.init.skey}`);
  console.log(`  QR image         : distinct=${a.init.bitmapBase64 !== b.init.bitmapBase64}`);
  const cookie = async (c: Challenge): Promise<string> =>
    (await c.client.jar.getCookies('https://login.beanfun.com/')).find((x) => x.key === 'GamaLoginSession')
      ?.value ?? '';
  const [ca, cb] = [await cookie(a), await cookie(b)];
  console.log(`  GamaLoginSession : A=${fp(ca)}  B=${fp(cb)}  distinct=${ca !== cb && ca !== ''}`);

  const dir = join(process.cwd(), 'capture', 'isolation');
  mkdirSync(dir, { recursive: true });
  const qrPath = join(dir, 'challenge-A.png');
  writeFileSync(qrPath, Buffer.from(a.init.bitmapBase64.split(',')[1] ?? '', 'base64'));

  console.log('\n=== approve ONLY challenge A ===');
  console.log(`  scan this QR : ${qrPath}   (open ${qrPath})`);
  if (a.init.appLink) console.log(`  or tap this on your phone : ${a.init.appLink}`);
  console.log("\n  Challenge B is deliberately not shown. Do NOT approve anything else while");
  console.log('  this runs — a second approval would make the reading meaningless.\n');

  const deadline = Date.now() + TTL_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    [a.outcome, b.outcome] = await Promise.all([pollOnce(a), pollOnce(b)]);
    const left = Math.round((deadline - Date.now()) / 1_000);
    process.stdout.write(`\r  A=${a.outcome.padEnd(12)} B=${b.outcome.padEnd(12)} (${left}s left)   `);
    if (a.outcome === 'Approved' || b.outcome === 'Approved') break;
  }
  console.log('\n');

  console.log('--- did the approval land on the right challenge? ---');
  console.log(`  A (the one approved) : ${a.outcome}`);
  console.log(`  B (never touched)    : ${b.outcome}`);

  if (b.outcome === 'Approved') {
    console.error('\n>>> CROSS-TALK. B was never approved and its poll says otherwise.');
    console.error('    Stop here: concurrent logins are not safe on a shared IP.');
    process.exitCode = 1;
    return;
  }
  if (a.outcome !== 'Approved') {
    console.log('\n>>> Nothing was approved in time, so nothing was measured.');
    console.log('    Re-run and approve challenge A within the QR lifetime.');
    return;
  }
  console.log('\n>>> Only the approved challenge flipped. The server routes by session, not by IP.');

  console.log('\n--- and the second line of defence ---');
  const session = await finalizeQrLogin(a.client, a.init);
  console.log(`  A finalises      : ok, webToken=${fp(session.webToken)}`);
  console.log(`  ...carrying A's pSKey : ${session.skey === a.init.skey}`);

  // The load-bearing half. Even a poll that lied would leave the victim with a
  // refused login rather than another person's account, because finalising
  // re-asserts the caller's OWN pSKey — one that was never approved.
  try {
    const stolen = await finalizeQrLogin(b.client, b.init);
    console.error(`\n>>> B FINALISED WITHOUT EVER BEING APPROVED (webToken=${fp(stolen.webToken)}).`);
    console.error('    An unapproved challenge must not produce a session.');
    process.exitCode = 1;
  } catch (e) {
    console.log(`  B finalises      : refused, as it must — ${safeError(e)}`);
    console.log('\n>>> Both layers hold: the poll is isolated, and finalising is bound to the');
    console.log('    caller\'s own pSKey, so a lying poll still could not hand over a session.');
  }
}

void main().catch((e: unknown) => {
  if (e instanceof BeanfunError && e.code === 'http.ip_blocked') {
    // Easy to hit: this needs two pSKeys, and anything else probing beanfun
    // recently has been spending from the same budget.
    console.error('This IP is currently rate-limited by beanfun. Wait ~5 minutes and re-run.');
    process.exitCode = 1;
    return;
  }
  console.error('qrIsolation failed:', safeError(e));
  process.exitCode = 1;
});
