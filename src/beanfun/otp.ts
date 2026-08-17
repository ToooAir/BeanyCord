/**
 * OTP retrieval. Two protocols live here.
 *
 * In 2026-08 TW game starts moved to the Gamania Games Manager, and for the
 * games that moved, credentials come from `POST get_webstart_otp_v2.ashx` with
 * a JSON body instead of `GET get_webstart_otp.ashx` with nine query params.
 *
 * The old endpoint is NOT dead everywhere, and the difference is legible in how
 * it refuses: `0;        Query String Error` is a refusal to read the request
 * at all (that game has migrated), while a message about a specific value means
 * it read the request and one input was wrong. (The blanked 8-character slot
 * before the message is the success envelope's key field, reused for errors.)
 *
 * `getOtp` picks between them on whether step 1's page hands the launcher a
 * `LaunchTicket` — the page's own shape, not the configured region — so a
 * region that migrates later needs no code change. Note the test is what the
 * handoff DECODES to, not that it exists: Mabinogi (600309_A2) carries an
 * `m_objData` whose payload is the legacy parameter set with no ticket in it,
 * while MapleStory (610074_T9) carries a real one.
 *
 *   legacy: 1 init -> 2 secret code -> 3 record -> 4 long poll -> 5 GET  -> decrypt
 *   v2:     1 init -> 3 record (best effort)                   -> 5 POST -> decrypt
 *
 * Ported from Rust `otp.rs` (pungin/Beanfun@fbb5b0f); that repo's
 * `docs/OTP-PROTOCOL-CHANGE.md` has the full derivation.
 *
 * GOTCHAS:
 * - Some handlers under `generic_handlers` check `Referer` and refuse without
 *   one ("The URL referrer is null or from a different domain!") — while
 *   answering HTTP 200, so a status-code check cannot see it. Measured on the
 *   legacy chain, only `get_result.ashx` cares, and its answer is one we do not
 *   want; `record_service_start.ashx` and the legacy step 5 both work without
 *   the header. Only the v2 POST sends it.
 * - The v2 path deliberately skips step 2 and step 4: the request carries no
 *   secret code, and the page's `GetResultByLongPolling` call is the launcher's
 *   installation check — unrelated to the password, and it holds the connection
 *   open.
 * - Legacy step 2 (`get_cookies.ashx`) is on the NEWLOGIN host (TW), not portal.
 * - Legacy step 5 URL is hand-built: screatetime spaces -> %20 (not `+`).
 * - `ppppp` was a fixed 64-hex constant of unknown provenance. Pages that carry
 *   a handoff supply their own, longer, per-request value under that name —
 *   prefer it, and keep the constant only for pages that supply nothing.
 */
import { safeError } from '../core/redact.js';
import {
  BeanfunClient,
  boundedText,
  ensureSuccess,
  looksLikeSessionExpiredPage,
} from './client.js';
import { GGM_ARCH, GGM_CV, GGM_HASH } from './clientIntegrity.js';
import { TW } from './endpoints.js';
import { BeanfunError } from './errors.js';
import { decodeLaunchFields, decodeLaunchTicket, type LaunchFields } from './launchData.js';
import {
  extractLaunchHandoff,
  extractLongPollingKey,
  extractSecretCode,
  extractServiceAccountCreateTime,
  extractUnkData,
  type LaunchHandoff,
} from './parser.js';
import { dtCompact, dtIso } from './time.js';
import type { ServiceAccount, Session } from './types.js';
import { decryptHex } from './wcdes.js';

/** Fallback `ppppp=` for pages that hand the launcher nothing. Do not edit. */
const PPPPP = '1F552AEAFF976018F942B13690C990F60ED01510DDF89165F1658CCE7BC21DBA';

interface Step1 {
  /** The v2 launcher handoff, when this page has migrated. */
  launch: LaunchHandoff | null;
  /** The handoff's decoded fields, when there was one and it decoded. */
  fields: LaunchFields | null;
  /** Step 1's own URL — every `generic_handlers` call names it as `Referer`. */
  pageUrl: string;
  /** Legacy-route literals; empty strings on a migrated page that dropped them. */
  longPollingKey: string;
  unkData: [string, string] | null;
  screatetime: string;
}

export async function getOtp(
  client: BeanfunClient,
  session: Session,
  account: ServiceAccount,
  serviceCode: string,
  serviceRegion: string,
): Promise<string> {
  const step1 = await step1Init(client, account, serviceCode, serviceRegion);

  // Route on what the handoff DECODED to, not on it being present. A page can
  // carry `m_objData` and still hand the launcher the legacy parameter set
  // (`ppppp`, ServiceCode, …) with no LaunchTicket in it — observed on
  // Mabinogi (600309_A2) — and for those the v2 endpoint has nothing to trade.
  // MapleStory (610074_T9), our default game, does carry one and takes v2.
  if (step1.launch && step1.fields?.['LaunchTicket']) {
    // Recording the start is what the page does alongside opening the launcher,
    // and nothing downstream depends on it — so a migrated page missing a field
    // it no longer has to carry must not cost the user their OTP.
    try {
      await step3RecordStart(client, account, step1, serviceCode, serviceRegion);
    } catch {
      /* best effort on this route */
    }
    return step5PostOtpV2(client, step1.launch, step1.pageUrl);
  }

  const secretCode = await step2GetSecretCode(client);
  await step3RecordStart(client, account, step1, serviceCode, serviceRegion);
  await step4LongPoll(client, step1.longPollingKey);
  const envelope = await step5GetOtp(client, session, account, step1, secretCode, serviceCode, serviceRegion);
  return decryptEnvelope(envelope);
}

async function step1Init(
  client: BeanfunClient,
  account: ServiceAccount,
  sc: string,
  sr: string,
): Promise<Step1> {
  // Built as a URL rather than passed as `searchParams` because the same string
  // is replayed as the `Referer` on every later handler.
  const url = new URL(`${TW.portalBase}beanfun_block/game_zone/game_start_step2.aspx`);
  url.searchParams.set('service_code', sc);
  url.searchParams.set('service_region', sr);
  url.searchParams.set('sotp', account.ssn);
  url.searchParams.set('dt', dtCompact());
  const pageUrl = url.toString();

  const res = await client.http.get(pageUrl);
  ensureSuccess(res, 'game_start_step2.aspx');
  const body = boundedText(res);

  // Read the handoff FIRST: it decides which route this page is on, and
  // therefore which of the literals below are required at all. A migrated page
  // has dropped some of them, so demanding them up front would fail the
  // retrieval over a literal that is meant to be gone.
  //
  // Decoding is best-effort: a blob we cannot read must not cost the user the
  // legacy route, which may still work for this game.
  const launch = extractLaunchHandoff(body);
  let fields: LaunchFields | null = null;
  if (launch) {
    try {
      fields = decodeLaunchFields(launch.data);
    } catch (e) {
      // Loud, because this is the signature of the obfuscation having changed
      // under us — the substitution tables live inside a launcher DLL Gamania
      // can rebuild at any time. Swallowing it silently would drop the page into
      // the legacy route, where a migrated game answers `Query String Error`,
      // and the real cause would never appear anywhere.
      console.warn(
        `[otp] ${sc}_${sr}: launcher handoff present (${launch.data.length} chars) but could ` +
          `NOT be decoded — falling back to the legacy route, which may not work for this ` +
          `game. If this game used to work, the decode tables likely changed: ${safeError(e)}`,
      );
    }
    if (fields?.['LaunchTicket']) {
      console.log(`[otp] ${sc}_${sr} -> v2 (LaunchTicket present)`);
      return { launch, fields, pageUrl, longPollingKey: '', unkData: null, screatetime: '' };
    }
  }
  // One line per fetch, deliberately: "which route did this game take, and why"
  // is the single question a whole day of investigation came down to, and the
  // answer was nowhere in the logs. Field names only — never their values.
  console.log(
    `[otp] ${sc}_${sr} -> legacy (${
      fields ? `no LaunchTicket; fields: ${Object.keys(fields).join(', ')}` : launch ? 'handoff undecodable' : 'no handoff'
    })`,
  );

  const longPollingKey = extractLongPollingKey(body);
  if (!longPollingKey) {
    // A successful response is *also* HTML (the key is embedded in the page), so
    // only treat this as an expired session once extraction has already failed:
    // a killed session gets a login page rather than a 4xx, and dumping that raw
    // page into the user's DM is what we're avoiding here.
    if (looksLikeSessionExpiredPage(body)) {
      throw new BeanfunError('otp.session_expired', 'login session no longer valid');
    }
    throw new BeanfunError('otp.missing_long_polling_key', body.slice(0, 256));
  }

  // TW always parses the unk-data fragment.
  const unkData = extractUnkData(body);
  if (!unkData) throw new BeanfunError('otp.missing_unk_data', 'missing TW unk-data fragment');

  const screatetime = account.screatetime ?? extractServiceAccountCreateTime(body);
  if (!screatetime) throw new BeanfunError('otp.missing_create_time', 'no service-account create time');

  return { launch, fields, pageUrl, longPollingKey, unkData, screatetime };
}

/**
 * The `SecretCode` step 5 has to present.
 *
 * WPF reads `m_strSecretCode` off `get_cookies.ashx` and sends that. Measured
 * against the live server, that value does NOT match what the portal validates:
 * `get_cookies.ashx` is on the newlogin host and answers for that host's
 * session, while step 5 is checked against the portal's own `bfSecretCode`
 * cookie — a different value. Sending the page's gets `Secret codes do not
 * match!`; sending the cookie's returns the OTP envelope. Both were tried side
 * by side, same session, seconds apart.
 *
 * The request is still made: it sets no cookies and we no longer read its
 * result, but it is what the official flow does at this point and we have no
 * evidence about what else it primes. The page value stays as a fallback for a
 * jar that somehow has no cookie.
 */
async function step2GetSecretCode(client: BeanfunClient): Promise<string> {
  // TW: newlogin host (region-asymmetric — see otp.rs).
  const res = await client.http.get(`${TW.newloginBase}generic_handlers/get_cookies.ashx`);
  ensureSuccess(res, 'get_cookies.ashx');
  const pageCode = extractSecretCode(boundedText(res));
  const code = (await client.readSecretCode()) ?? pageCode;
  if (!code) throw new BeanfunError('otp.missing_secret_code', 'no bfSecretCode cookie and no m_strSecretCode');
  return code;
}

async function step3RecordStart(
  client: BeanfunClient,
  account: ServiceAccount,
  step1: Step1,
  sc: string,
  sr: string,
): Promise<void> {
  const form: Record<string, string> = {
    service_code: sc,
    service_region: sr,
    service_account_id: account.sid,
    sotp: account.ssn,
    service_account_display_name: account.sname,
    service_account_create_time: step1.screatetime,
  };
  if (step1.unkData) form[step1.unkData[0]] = step1.unkData[1];

  // No `Referer`: measured, this handler answers
  // `{'intResult': 1, 'strOutstring': 'Success'}` without one.
  const res = await client.http.post(
    `${TW.portalBase}beanfun_block/generic_handlers/record_service_start.ashx`,
    { form },
  );
  ensureSuccess(res, 'record_service_start.ashx');
}

/** How long we are willing to hold the long poll open before walking away. */
const LONG_POLL_BUDGET_MS = 5_000;

/**
 * Step 4 — the `GetResultByLongPolling` trigger, fired and abandoned.
 *
 * This is the launcher's installation check, not part of credential retrieval:
 * step 5 returns an OTP envelope whether or not this succeeded, verified
 * directly — the sweep that found the secret-code fix had this step failing and
 * still got the envelope.
 *
 * Deliberately sent WITHOUT a `Referer`, which reads backwards until you see
 * what each choice costs. Without one the server rejects it immediately and we
 * move on; with one it does what it says and holds the connection open, which
 * put a multi-second stall on every OTP fetch. Since we do not want its answer,
 * the version that fails fast is the better one. Adding the header here was a
 * change made on upstream's authority rather than on a measurement, and the
 * measurement says it bought nothing.
 *
 * The budget below is left as a safety net, not as containment for that.
 */
async function step4LongPoll(client: BeanfunClient, longPollingKey: string): Promise<void> {
  try {
    await client.http.get(`${TW.portalBase}generic_handlers/get_result.ashx`, {
      searchParams: { meth: 'GetResultByLongPolling', key: longPollingKey, _: dtIso() },
      timeout: { request: LONG_POLL_BUDGET_MS },
    });
  } catch {
    /* by design — see above */
  }
}

async function step5GetOtp(
  client: BeanfunClient,
  session: Session,
  account: ServiceAccount,
  step1: Step1,
  secretCode: string,
  sc: string,
  sr: string,
): Promise<string> {
  // Hand-built URL: WPF replaces only spaces with %20; every other char in the
  // fixed-shape values is already URL-safe. Do NOT use a query builder here
  // (it would emit `+` for spaces and re-encode `ppppp`).
  const createTime = step1.screatetime.replace(/ /g, '%20');
  const tick = Math.trunc(Date.now()) | 0; // i32 cache buster, value unused by server
  const url =
    `${TW.portalBase}beanfun_block/generic_handlers/get_webstart_otp.ashx` +
    `?SN=${step1.longPollingKey}` +
    `&WebToken=${session.webToken}` +
    `&SecretCode=${secretCode}` +
    // The page's own value when it has one: it is per-request and longer than
    // the historical constant, so a page that supplies it is not being served
    // by the constant.
    `&ppppp=${step1.fields?.['ppppp'] ?? PPPPP}` +
    `&ServiceCode=${sc}` +
    `&ServiceRegion=${sr}` +
    `&ServiceAccount=${account.sid}` +
    `&CreateTime=${createTime}` +
    `&d=${tick}` +
    // The legacy GET grew this suffix in Game Manager 1.5.x and now rejects
    // requests that omit it. Sending it keeps this fallback genuinely usable
    // rather than doomed the moment it is reached.
    `&CV=${GGM_CV}&Hash=${GGM_HASH}&arch=${GGM_ARCH}`;

  const res = await client.http.get(url);
  ensureSuccess(res, 'get_webstart_otp.ashx');
  return boundedText(res);
}

/** Reply shape of `get_webstart_otp_v2.ashx`. */
interface OtpV2Response {
  result?: number;
  data?: string | null;
  message?: string | null;
}

/**
 * Step 5 (v2) — POST the launch ticket and decrypt the OTP out of the JSON
 * reply. Field names are PascalCase on the wire except `arch`, matching the
 * launcher verbatim.
 */
async function step5PostOtpV2(
  client: BeanfunClient,
  handoff: LaunchHandoff,
  referer: string,
): Promise<string> {
  const launchTicket = decodeLaunchTicket(handoff.data);

  const res = await client.http.post(
    `${TW.portalBase}beanfun_block/generic_handlers/get_webstart_otp_v2.ashx`,
    {
      headers: { referer },
      json: {
        SN: handoff.sn,
        LaunchTicket: launchTicket,
        CV: GGM_CV,
        Hash: GGM_HASH,
        arch: GGM_ARCH,
      },
    },
  );
  ensureSuccess(res, 'get_webstart_otp_v2.ashx');
  const body = boundedText(res);

  let parsed: OtpV2Response;
  try {
    parsed = JSON.parse(body) as OtpV2Response;
  } catch {
    // Keep the body out of it — same reasoning as `rejectionReason` below.
    throw new BeanfunError(
      'otp.empty_response',
      'get_webstart_otp_v2.ashx returned a body that is not the expected JSON',
    );
  }

  if (parsed.result !== 1) {
    // Prefer the server's own wording; fall back to the code so the failure is
    // never reported as an empty string.
    const reason = parsed.message?.trim();
    throw new BeanfunError(
      'otp.server_rejected',
      reason ? rejectionReason(reason) : `result=${String(parsed.result)}`,
    );
  }

  const payload = parsed.data?.trim();
  if (!payload) throw new BeanfunError('otp.empty_response', 'v2 reply carried no data');
  return decryptOtpPayload(payload);
}

/** Longest server rejection text we're willing to relay to the user verbatim. */
const MAX_REJECTION_CHARS = 120;

/**
 * Step 5 has a defined success shape, so anything else is a rejection — and the
 * slot that normally holds a short reason ("帳號狀態異常" and friends) can just
 * as well hold a whole error page, which is how raw markup ended up in a user's
 * DM. That is the half of the `889a820` fix that was left undone: step 1 stopped
 * leaking its body, step 5 never did.
 *
 * So relay a reason only when it still looks like one — short, single-line, no
 * markup. Otherwise report the shape violation and keep the body out of it.
 * Nothing is lost: the real reason was never in an error page anyway.
 */
function rejectionReason(raw: string): string {
  const msg = raw.trim();
  const unusable = msg === '' || msg.length > MAX_REJECTION_CHARS || /[<>\r\n]/.test(msg);
  return unusable ? 'get_webstart_otp.ashx returned an unexpected response shape' : msg;
}

/**
 * `<8-char ASCII key><cipher hex>` -> DES decrypt -> trim NULs.
 *
 * Shared by both protocol versions: the legacy envelope puts this after `1;`,
 * and the v2 reply returns the same shape in its JSON `data` member.
 */
function decryptOtpPayload(payload: string): string {
  if (payload.length < 8) {
    throw new BeanfunError('otp.decryption_failed', 'payload too short for 8-byte key');
  }
  const key = payload.slice(0, 8);
  const cipherHex = payload.slice(8);
  const plain = decryptHex(cipherHex, key);
  return plain.replace(/^\0+/, '').replace(/\0+$/, '');
}

/** Legacy step 6 — `1;<key8><cipherHex>`. */
export function decryptEnvelope(envelope: string): string {
  if (envelope === '') throw new BeanfunError('otp.empty_response', 'empty OTP envelope');
  const parts = envelope.split(';');
  if (parts.length < 2) throw new BeanfunError('otp.empty_response', 'unparseable OTP envelope');
  if (parts[0] !== '1') throw new BeanfunError('otp.server_rejected', rejectionReason(parts[1] ?? ''));
  return decryptOtpPayload(parts[1]!);
}
