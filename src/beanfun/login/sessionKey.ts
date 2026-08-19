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
 * 90s is deliberately wider than the measured 83.6s ceiling. Because our window
 * is the wider one, beanfun's window is always a subset of one of ours, so it
 * can never hold more than 4 — the safety is provable rather than tuned. The 7%
 * of headroom costs a slightly slower login queue; spending it would cost every
 * user a five-minute outage, and this deployment shares one egress IP, so a
 * single trip refuses everybody at once.
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
export const QR_BUDGET_LIMIT = 4;
export const QR_BUDGET_WINDOW_MS = 90_000;

/** How long a caller may be queued before a refusal is the kinder answer. Well
 *  inside the 15 minutes a deferred Discord interaction stays editable, so a
 *  queued user always gets a real reply rather than a silent expiry. */
export const QR_QUEUE_MAX_WAIT_MS = 120_000;

const qrGate = new RateGate(
  new SlidingWindow(QR_BUDGET_LIMIT, QR_BUDGET_WINDOW_MS),
  QR_QUEUE_MAX_WAIT_MS,
);

export async function getSessionKey(client: BeanfunClient): Promise<string> {
  const turn = await qrGate.acquire();
  if (!turn.ok) {
    throw new BeanfunError(
      'login.rate_budget',
      `pSKey queue longer than ${QR_QUEUE_MAX_WAIT_MS / 1_000}s (${QR_BUDGET_LIMIT} per ${QR_BUDGET_WINDOW_MS / 1_000}s)`,
      turn.retryAfterMs,
    );
  }
  if (turn.waitedMs > 0) {
    console.log(
      `[login] queued ${(turn.waitedMs / 1_000).toFixed(1)}s for a pSKey slot; ${qrGate.queued - 1} still waiting`,
    );
  }

  const res = await client.http.get(
    `${TW.portalBase}beanfun_block/bflogin/default.aspx?service=999999_T0`,
  );
  ensureSuccess(res, 'default.aspx');
  // This is the one endpoint measured to have a quota, and a refusal here is an
  // HTTP 200 whose only tell is the redirect target. Name it before the missing
  // pSKey below reports a rate limit as a parse failure.
  assertNotIpBlocked(res, 'default.aspx');

  // The key is on the final redirected URL's query. Scan the final URL first,
  // then any redirect hop, defensively.
  const candidates = [finalUrl(res), res.url, ...(res.redirectUrls ?? []).map(String)];
  for (const u of candidates) {
    const key = sessionKeyFromUrl(u);
    if (key) return key;
  }
  throw new BeanfunError('login.missing_session_key', `no pSKey in: ${finalUrl(res)}`);
}
