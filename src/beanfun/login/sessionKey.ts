/**
 * Obtain the TW portal session key (`pSKey`). Mirrors Rust
 * `login/session_key.rs::get_session_key_tw`: GET default.aspx, follow the
 * redirect chain, scrape `pSKey` from the FINAL URL.
 */
import { RateGate, SlidingWindow } from '../../core/guard.js';
import { assertNotIpBlocked, BeanfunClient, ensureSuccess, finalUrl } from '../client.js';
import { TW } from '../endpoints.js';
import { BeanfunError } from '../errors.js';
import { sessionKeyFromUrl } from '../parser.js';

/**
 * The one request beanfun rations, and the budget that keeps us under it.
 *
 * Measured 2026-08-19 by tripping it repeatedly: `default.aspx` serves at most
 * **4 pSKey issuances per IP in any ~80-second sliding window** (bracketed to
 * 79.2s <= W < 83.6s from a run of 27 successes and one refusal), and answers
 * the one that breaks the rule with `/TW/BlockIPMessage.htm` for a **fixed 4-5
 * minutes** — measured three times, and further requests during it neither
 * extend nor shorten the wait. It counts requests, not rate: five were refused
 * whether they took 12s, 35s or 76s.
 *
 * Those numbers were measured from a home line, and 2026-08-19 production
 * refused a mint that the model said was safe: four mints inside 35s, then a
 * fifth sent at t1+90s. At that moment our earlier mints were 55s, 67s, 79s and
 * 90s old, so either the 90s-old one had already aged out and beanfun refused us
 * with only THREE inside its window — a quota of 3 here, not 4 — or the window
 * is at least 90s wide rather than the 83.6s measured. The observation cannot
 * separate those two, and both are ways of saying the home numbers do not
 * transfer to this address. A shared datacentre egress spending the same budget
 * would look identical again.
 *
 * 3 per 120s is the intersection: at most 3 land in any 80s or 90s window, so at
 * most 2 precede a request, which clears a quota of 3 and a quota of 4 alike. It
 * is not a guess at the real limit, it is the strongest claim still consistent
 * with everything observed. Sustained that is one login every 40s, which is far
 * more than the login rate of a bot whose users stay signed in for days, while
 * being wrong the other way costs every user a five-minute outage at once.
 *
 * It lives here rather than in the Discord layer so no future caller can route
 * around it: the budget belongs to the endpoint, not to one of its users. And
 * it is ONE SHARED QUEUE rather than a per-user throttle: beanfun counts
 * addresses and cannot see users at all, so rationing per person would refuse
 * someone the budget could have served while adding nothing to safety. Callers
 * wait their turn instead, and fairness is the order they arrived in.
 */
// Exported so the test suite checks THESE numbers against the measured server,
// rather than a copy of them that could drift apart silently.
export const QR_BUDGET_LIMIT = 3;
export const QR_BUDGET_WINDOW_MS = 120_000;

/** How long a caller may be queued before a refusal is the kinder answer. Well
 *  inside the 15 minutes a deferred Discord interaction stays editable, so a
 *  queued user always gets a real reply rather than a silent expiry. */
export const QR_QUEUE_MAX_WAIT_MS = 120_000;

/** What a refusal costs, measured three times as 4.0-4.9 minutes and unaffected
 *  by anything we do during it. Rounded up: overshooting delays a login,
 *  undershooting spends the whole deployment's next attempt on a doomed call. */
export const IP_BLOCK_PENALTY_MS = 5 * 60_000;

const qrGate = new RateGate(
  new SlidingWindow(QR_BUDGET_LIMIT, QR_BUDGET_WINDOW_MS),
  QR_QUEUE_MAX_WAIT_MS,
);

/** Roughly how long the next `getSessionKey` would spend queued, and how many
 *  callers are already waiting — for deciding whether to warn a human first. */
export function projectedQrWait(): { waitMs: number; ahead: number } {
  return { waitMs: qrGate.projectedWaitMs(), ahead: qrGate.queued };
}

export async function getSessionKey(client: BeanfunClient): Promise<string> {
  // Logged on the way IN as well as out. Only the exit line existed, and it
  // reports a wait that already happened — so a queued login looked like a
  // minute of silence followed by a line whose timestamp contradicted it.
  const projected = qrGate.projectedWaitMs();
  if (projected > 0) {
    console.log(
      `[login] pSKey budget spent; joining the queue, roughly ${(projected / 1_000).toFixed(1)}s out`,
    );
  }
  const turn = await qrGate.acquire();
  if (!turn.ok) {
    // Two different refusals. `blocked` means beanfun is already serving us a
    // penalty, so this is not a queue we are managing and the honest answer is
    // the block message with the real remaining time.
    if (turn.reason === 'blocked') {
      throw new BeanfunError(
        'http.ip_blocked',
        `beanfun is still rate-limiting this IP for ${Math.ceil(turn.retryAfterMs / 1_000)}s`,
        turn.retryAfterMs,
      );
    }
    throw new BeanfunError(
      'login.rate_budget',
      `pSKey queue longer than ${QR_QUEUE_MAX_WAIT_MS / 1_000}s (${QR_BUDGET_LIMIT} per ${QR_BUDGET_WINDOW_MS / 1_000}s)`,
      turn.retryAfterMs,
    );
  }
  if (turn.waitedMs > 0) {
    console.log(
      // `queued` already excludes us: acquire() decrements before it resolves.
      `[login] waited ${(turn.waitedMs / 1_000).toFixed(1)}s for a pSKey slot; ${qrGate.queued} still queued`,
    );
  }

  const res = await client.http.get(
    `${TW.portalBase}beanfun_block/bflogin/default.aspx?service=999999_T0`,
  );
  ensureSuccess(res, 'default.aspx');
  // This is the one endpoint measured to have a quota, and a refusal here is an
  // HTTP 200 whose only tell is the redirect target. Name it before the missing
  // pSKey below reports a rate limit as a parse failure.
  try {
    assertNotIpBlocked(res, 'default.aspx');
  } catch (e) {
    // Feed it back: our window is only a model of the server's counter, and it
    // resets whenever the process does while the server's does not. Being
    // refused is the one moment we learn the model was wrong, so the next caller
    // waits out the real penalty instead of queueing into the same wall.
    qrGate.penalise(IP_BLOCK_PENALTY_MS);
    // ...and print what we had actually sent, because a refusal that arrives
    // while our own budget says we are comfortably inside it is the interesting
    // case, and the counts are the only thing that separates "the quota is
    // smaller here", "the window is a different shape" and "this address is
    // shared with someone else spending it".
    console.error(
      `[login] refused by beanfun with budget ${QR_BUDGET_LIMIT}/${QR_BUDGET_WINDOW_MS / 1_000}s — ${qrGate.footprint()}`,
    );
    throw e;
  }

  // The key is on the final redirected URL's query. Scan the final URL first,
  // then any redirect hop, defensively.
  const candidates = [finalUrl(res), res.url, ...(res.redirectUrls ?? []).map(String)];
  for (const u of candidates) {
    const key = sessionKeyFromUrl(u);
    if (key) return key;
  }
  throw new BeanfunError('login.missing_session_key', `no pSKey in: ${finalUrl(res)}`);
}
