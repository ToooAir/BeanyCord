/**
 * Ask beanfun directly: is the launcher identity we send still accepted?
 *
 * `clientIntegrity.ts` pins a `CV`/`Hash` describing a Gamania Games Manager
 * build. Measured on 2026-08-19 against `get_webstart_otp_v2.ashx`, that gate is
 * real and strict — a valid launch ticket is refused unless the pair is right:
 *
 *   ours (pinned pair)   -> OK
 *   omitted entirely     -> Client_Integrity_Failed
 *   both wrong           -> Client_Integrity_Failed
 *   wrong CV, our Hash   -> Client_Integrity_Failed
 *   our CV, wrong Hash   -> Client_Integrity_Failed
 *
 * So the pin will one day stop being accepted and every user breaks at once.
 * Detecting that used to be the hard part: it is only observable by sending a v2
 * request, and a deployment whose users all sit on legacy games sends none —
 * possibly for months, since the game a user picked is persisted and survives
 * restarts. The first sign would have been a confused user.
 *
 * The same run settled how to avoid that. The gate answers BEFORE the ticket is
 * looked at, and to an anonymous caller:
 *
 *   worthless ticket + our pair   + session cookies -> Invalid_Start_Ticket
 *   worthless ticket + wrong pair + session cookies -> Client_Integrity_Failed
 *   worthless ticket + our pair   + NO cookies      -> Invalid_Start_Ticket
 *   worthless ticket + wrong pair + NO cookies      -> Client_Integrity_Failed
 *
 * Which is exactly the canary this file is: one POST carrying a deliberately
 * worthless ticket, no session, no user, no OTP produced, and an answer that
 * distinguishes "our pair is dead" from "our pair is fine".
 *
 * THREE STATES, NOT TWO. `Invalid_Start_Ticket` is the only thing that proves
 * health; everything unrecognised is `inconclusive`, never healthy. A canary
 * that reads an unknown answer as "fine" reports success while measuring
 * nothing — the failure `isLoggedOutEcho` shipped with for weeks, keyed on a
 * field that was byte-identical in both states.
 */
import { randomBytes, randomUUID } from 'node:crypto';

import got from 'got';

import { redactText, safeError } from '../core/redact.js';
import { USER_AGENT } from './client.js';
import { GGM_ARCH, GGM_CV, GGM_HASH } from './clientIntegrity.js';
import { TW } from './endpoints.js';

/**
 * `healthy`      — beanfun accepted the identity and refused only the ticket.
 * `rejected`     — it refused the identity. Everyone on this pin is broken.
 * `inconclusive` — the answer was not one we recognise. NOT a synonym for healthy.
 */
export type CanaryStatus = 'healthy' | 'rejected' | 'inconclusive';

export interface CanaryResult {
  status: CanaryStatus;
  /** One line, ready to log. */
  line: string;
}

/**
 * The server's own token for "your launcher identity is not one we accept".
 * Exported because `otp.ts` has to recognise the same string in a real refusal —
 * two copies of it would drift apart on the day beanfun changes the wording,
 * and that is the day both readers matter.
 */
export const CLIENT_INTEGRITY_FAILED = 'Client_Integrity_Failed';
/** …and for "identity fine, but that ticket is worthless" — which is the point. */
export const INVALID_START_TICKET = 'Invalid_Start_Ticket';

const CANARY_TIMEOUT_MS = 10_000;

/**
 * A referer that carries no account: the anonymous arms were measured with a
 * real game-start URL, and whether the header matters at all was never tested,
 * so keep sending one — but not one with a service code and an `sotp` in it.
 */
const CANARY_REFERER = `${TW.portalBase}beanfun_block/game_zone/game_start_step2.aspx`;

/**
 * Decide what an answer means. Pure, so the interesting half is testable without
 * touching beanfun — and so the "unknown is not healthy" rule is pinned by a
 * test rather than by care.
 */
export function classifyCanary(httpStatus: number, body: string): CanaryResult {
  const pinned = `pinned cv=${GGM_CV} arch=${GGM_ARCH}`;

  if (httpStatus < 200 || httpStatus >= 300) {
    return { status: 'inconclusive', line: `${pinned}; canary got HTTP ${httpStatus}` };
  }

  let parsed: { result?: number; message?: string | null };
  try {
    parsed = JSON.parse(body) as { result?: number; message?: string | null };
  } catch {
    // A block page or a WAF interstitial lands here. Say what it looked like,
    // briefly, so the difference between "beanfun changed" and "we are being
    // filtered" is visible without opening a capture.
    return {
      status: 'inconclusive',
      line: `${pinned}; canary got a non-JSON reply: ${redactText(body.slice(0, 80)).replace(/\s+/g, ' ')}`,
    };
  }

  const message = String(parsed.message ?? '');

  // A random 32-byte ticket being ACCEPTED would mean the endpoint stopped
  // validating tickets, which says nothing about the identity — and would make
  // every future run of this canary meaningless. Loud, and not healthy.
  if (parsed.result === 1) {
    return {
      status: 'inconclusive',
      line: `${pinned}; canary's throwaway ticket was ACCEPTED — the endpoint's contract has changed and this check no longer measures anything`,
    };
  }

  if (message.includes(CLIENT_INTEGRITY_FAILED)) {
    return {
      status: 'rejected',
      line: `${pinned}; beanfun REFUSES this pair (${CLIENT_INTEGRITY_FAILED}) — every v2 OTP is failing for everyone until it is updated`,
    };
  }

  if (message.includes(INVALID_START_TICKET)) {
    return {
      status: 'healthy',
      line: `${pinned}; beanfun still accepts this pair (refused only the throwaway ticket)`,
    };
  }

  return {
    status: 'inconclusive',
    line: `${pinned}; canary got an unrecognised answer: result=${String(parsed.result)} message=${redactText(message).slice(0, 80)}`,
  };
}

/**
 * Fire the canary. Never throws: it runs on paths that are already reporting
 * something else, and a network hiccup here must not replace that with ours.
 *
 * Deliberately its own `got` call rather than a `BeanfunClient`: the measurement
 * says no session is needed, and sending one anyway would tie a check meant to
 * run with no user at all to whether some user happens to be logged in.
 */
export async function runGgmCanary(): Promise<CanaryResult> {
  try {
    const res = await got.post(
      `${TW.portalBase}beanfun_block/generic_handlers/get_webstart_otp_v2.ashx`,
      {
        headers: { 'user-agent': USER_AGENT, referer: CANARY_REFERER },
        json: {
          // Well-formed but worthless: a 36-char GUID and 64 hex characters, the
          // shapes the real values have. Obvious garbage risks a shape rejection
          // that would look like an answer without being one.
          SN: randomUUID(),
          LaunchTicket: randomBytes(32).toString('hex'),
          CV: GGM_CV,
          Hash: GGM_HASH,
          arch: GGM_ARCH,
        },
        timeout: { request: CANARY_TIMEOUT_MS },
        retry: { limit: 0 },
        throwHttpErrors: false,
      },
    );
    return classifyCanary(res.statusCode, typeof res.body === 'string' ? res.body : String(res.body));
  } catch (e) {
    return { status: 'inconclusive', line: `canary could not reach beanfun: ${safeError(e)}` };
  }
}
