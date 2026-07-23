/**
 * OTP retrieval. Mirrors Rust `otp.rs::get_otp` — 5 HTTP steps + WCDES decrypt.
 *
 * GOTCHAS (1:1 with the Rust port):
 * - Step 2 (`get_cookies.ashx`) is on the NEWLOGIN host (TW), not portal.
 * - Step 5 URL is hand-built: screatetime spaces -> %20 (not `+`); `ppppp`
 *   is a fixed 64-hex protocol constant copied verbatim.
 * - Step 6 splits `1;<key8><cipherHex>`, DES-decrypts, trims trailing NULs.
 */
import { BeanfunClient, boundedText, ensureSuccess } from './client.js';
import { TW } from './endpoints.js';
import { BeanfunError } from './errors.js';
import { extractLongPollingKey, extractSecretCode, extractServiceAccountCreateTime, extractUnkData } from './parser.js';
import { dtCompact, dtIso } from './time.js';
import type { ServiceAccount, Session } from './types.js';
import { decryptHex } from './wcdes.js';

/** Fixed protocol constant on step 5 (`ppppp=`). Provenance unknown; do not edit. */
const PPPPP = '1F552AEAFF976018F942B13690C990F60ED01510DDF89165F1658CCE7BC21DBA';

/**
 * A dead/hijacked session (e.g. someone re-logged in on another device and stole
 * this session) makes the portal serve a full HTML login/error page — HTTP 200,
 * so `ensureSuccess` passes — instead of the expected fragment. Detect that so
 * callers can report "session expired" cleanly instead of dumping the raw page.
 */
export function looksLikeSessionExpiredPage(body: string): boolean {
  const head = body.replace(/^﻿/, '').trimStart().slice(0, 512).toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html') || head.includes('<html');
}

interface Step1 {
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
  const res = await client.http.get(`${TW.portalBase}beanfun_block/game_zone/game_start_step2.aspx`, {
    searchParams: { service_code: sc, service_region: sr, sotp: account.ssn, dt: dtCompact() },
  });
  ensureSuccess(res, 'game_start_step2.aspx');
  const body = boundedText(res);

  // The portal answers a killed session with a login page rather than a 4xx, so
  // check before parsing — otherwise the HTML would surface as a parse error and
  // leak the whole page into the user's DM.
  if (looksLikeSessionExpiredPage(body)) {
    throw new BeanfunError('otp.session_expired', 'login session no longer valid');
  }

  const longPollingKey = extractLongPollingKey(body);
  if (!longPollingKey) throw new BeanfunError('otp.missing_long_polling_key', body.slice(0, 256));

  // TW always parses the unk-data fragment.
  const unkData = extractUnkData(body);
  if (!unkData) throw new BeanfunError('otp.missing_unk_data', 'missing TW unk-data fragment');

  const screatetime = account.screatetime ?? extractServiceAccountCreateTime(body);
  if (!screatetime) throw new BeanfunError('otp.missing_create_time', 'no service-account create time');

  return { longPollingKey, unkData, screatetime };
}

async function step2GetSecretCode(client: BeanfunClient): Promise<string> {
  // TW: newlogin host (region-asymmetric — see otp.rs).
  const res = await client.http.get(`${TW.newloginBase}generic_handlers/get_cookies.ashx`);
  ensureSuccess(res, 'get_cookies.ashx');
  const code = extractSecretCode(boundedText(res));
  if (!code) throw new BeanfunError('otp.missing_secret_code', 'missing m_strSecretCode');
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

  const res = await client.http.post(
    `${TW.portalBase}beanfun_block/generic_handlers/record_service_start.ashx`,
    { form },
  );
  ensureSuccess(res, 'record_service_start.ashx');
}

async function step4LongPoll(client: BeanfunClient, longPollingKey: string): Promise<void> {
  const res = await client.http.get(`${TW.portalBase}generic_handlers/get_result.ashx`, {
    searchParams: { meth: 'GetResultByLongPolling', key: longPollingKey, _: dtIso() },
  });
  ensureSuccess(res, 'get_result.ashx');
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
    `&ppppp=${PPPPP}` +
    `&ServiceCode=${sc}` +
    `&ServiceRegion=${sr}` +
    `&ServiceAccount=${account.sid}` +
    `&CreateTime=${createTime}` +
    `&d=${tick}`;

  const res = await client.http.get(url);
  ensureSuccess(res, 'get_webstart_otp.ashx');
  return boundedText(res);
}

/** Step 6 — `1;<key8><cipherHex>` -> DES decrypt -> trim NULs. */
export function decryptEnvelope(envelope: string): string {
  if (envelope === '') throw new BeanfunError('otp.empty_response', 'empty OTP envelope');
  const parts = envelope.split(';');
  if (parts.length < 2) throw new BeanfunError('otp.empty_response', 'unparseable OTP envelope');
  if (parts[0] !== '1') throw new BeanfunError('otp.server_rejected', parts[1] ?? '');
  const payload = parts[1]!;
  if (payload.length < 8) throw new BeanfunError('otp.decryption_failed', 'payload too short for 8-byte key');
  const key = payload.slice(0, 8);
  const cipherHex = payload.slice(8);
  const plain = decryptHex(cipherHex, key);
  return plain.replace(/^\0+/, '').replace(/\0+$/, '');
}
