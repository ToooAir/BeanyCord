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
 * Measured from a home line, twice, with two experiments that each pin down what
 * the other cannot (full write-up in `docs/PROTOCOL-FLOW.md`):
 *
 *   - **quota 4** — a back-to-back fill is refused on the fifth request. Every
 *     request is inside any plausible window, so this reads the depth directly
 *     and assumes nothing about the width. Same answer on 2026-08-19 and -21.
 *   - **window ~80s** — two staircases of different shapes two days apart
 *     bracket it to [79.2, 83.6] and [71.5, 81.6]; the intersection is 2.4s wide.
 *     A staircase cannot measure the quota (a real 80s/4 reads as a perfectly
 *     self-consistent 57s/3), which is why the fill exists.
 *   - **penalty 4.5-4.8 minutes**, from intersecting three recovery intervals,
 *     and nothing we do during it makes it longer or shorter.
 *
 * The budget lives here rather than in the Discord layer so no future caller can
 * route around it: it belongs to the endpoint, not to one of its users. And it is
 * ONE SHARED QUEUE rather than a per-user throttle, because beanfun counts
 * addresses and cannot see users at all — rationing per person would refuse
 * someone the budget could have served while adding nothing to safety. Callers
 * wait their turn instead, and fairness is the order they arrived in.
 *
 * ## Why one every 30 seconds is safe, and not merely cautious
 *
 * Not "30 feels far enough". At a strict 30-second spacing, the requests that
 * are still inside beanfun's ~80s window when we send are the ones at -30s and
 * -60s — the one at -90s has already aged out. So beanfun **sees two**, and it
 * needs four to refuse. That is the same headroom the previous 3-per-120s budget
 * had, at a third more throughput.
 *
 * It holds at both ends of the measured bracket (79.2s and 83.6s), and the
 * window would have to widen by 50% before four of ours could fit — or by 12% if
 * the quota were really 3.
 *
 * ## Why an interval and not a burst budget
 *
 * Because of the restart. This state is in memory; beanfun's is not. A budget of
 * 3 hands three permits to whoever asks first, so three logins, a redeploy, and
 * three more put SIX requests inside one 80-second window and the fifth is
 * refused — simulated against the measured server, at essentially every restart
 * timing. An interval has no burst to hand back, so a restart can leak at most
 * one extra request, and seeding the window at boot (below) removes even that.
 *
 * The price is that a second person logging in at the same moment waits 30s
 * instead of nothing. Logins are rare in a bot whose users stay signed in for
 * days; a five-minute outage for everybody is not a fair trade for saving them.
 *
 * ## What this cannot defend against
 *
 * A neighbour. Production leaves through a shared egress, so somebody else's
 * pSKeys land in the same per-IP counter and no budget of ours can see them.
 * That is why a refusal is treated as the only trustworthy correction
 * (`penalise()`), with our own footprint logged beside it — the footprint is what
 * separates "a neighbour spent it" from "the quota here is smaller".
 *
 * (An earlier version of this comment cited a 2026-08-19 production refusal as
 * evidence that this address has a quota of 3 or a window past 90s. That is
 * withdrawn: the request ages behind it were reconstructed from what a user
 * remembered pressing, not read from a log — `footprint()` did not exist yet —
 * and the address had been hammered by testing that day. It is not evidence
 * strong enough to overturn two clean, instrumented measurements.)
 */
// Exported so the test suite checks THESE numbers against the measured server,
// rather than a copy of them that could drift apart silently.
export const QR_MIN_INTERVAL_MS = 30_000;

/** How long a caller may be queued before a refusal is the kinder answer. Well
 *  inside the 15 minutes a deferred Discord interaction stays editable, so a
 *  queued user always gets a real reply rather than a silent expiry. */
export const QR_QUEUE_MAX_WAIT_MS = 120_000;

/** What a refusal costs. Three recovery measurements each bound it to an
 *  interval, and those intervals intersect at 4.5-4.8 minutes; nothing we do
 *  during it makes any difference. Five covers that upper end — undershooting
 *  would spend the whole deployment's next attempt on a doomed call, which then
 *  starts the penalty over. */
export const IP_BLOCK_PENALTY_MS = 5 * 60_000;

/** A limit of one per interval IS a minimum interval — no separate mechanism. */
const qrWindow = new SlidingWindow(1, QR_MIN_INTERVAL_MS);

// Start as though a mint just happened. Without this, a process that restarts
// twice in quick succession (a crash loop, a rolled-back deploy) gets a free
// request each time, and those stack inside beanfun's window even though ours
// keeps looking empty. The cost is that the first login after a boot waits one
// interval, which is 30 seconds once per deploy.
qrWindow.take();

const qrGate = new RateGate(qrWindow, QR_QUEUE_MAX_WAIT_MS);

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
      `pSKey queue longer than ${QR_QUEUE_MAX_WAIT_MS / 1_000}s (one per ${QR_MIN_INTERVAL_MS / 1_000}s)`,
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
      `[login] refused by beanfun while pacing one per ${QR_MIN_INTERVAL_MS / 1_000}s — ${qrGate.footprint()}`,
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
