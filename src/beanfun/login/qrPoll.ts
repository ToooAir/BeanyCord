/**
 * QR poll. Mirrors Rust `login/qr_poll.rs`: a single
 * `POST QRLogin/CheckLoginStatus` with an EMPTY body.
 *
 * GOTCHA (from the Rust 2026-04-18 live note): the endpoint rejects a body
 * with `Transfer-Encoding: chunked` / no length with HTTP 411. We send an
 * explicit empty form body so a `Content-Length: 0` framing is emitted, and
 * deliberately do NOT send `X-Requested-With` (WPF clears all headers first).
 */
import { BeanfunClient, boundedText, ensureSuccess } from '../client.js';
import { TW } from '../endpoints.js';
import { BeanfunError } from '../errors.js';
import type { QrLoginInit, QrPollOutcome } from '../types.js';

export async function pollQrLogin(
  client: BeanfunClient,
  init: QrLoginInit,
): Promise<QrPollOutcome> {
  const refererUrl = `${TW.loginBase}Login/Index?pSKey=${encodeURIComponent(init.skey)}`;
  const headers: Record<string, string> = {
    accept: 'application/json, text/plain, */*',
    referer: refererUrl,
    origin: 'https://login.beanfun.com',
    'content-type': 'application/x-www-form-urlencoded',
    'content-length': '0',
  };
  if (init.verificationToken !== '') {
    headers['requestverificationtoken'] = init.verificationToken;
  }

  const res = await client.http.post(`${TW.loginBase}QRLogin/CheckLoginStatus`, {
    headers,
    body: '',
  });
  ensureSuccess(res, 'QRLogin/CheckLoginStatus');

  let parsed: { ResultMessage?: string };
  try {
    parsed = JSON.parse(boundedText(res)) as { ResultMessage?: string };
  } catch {
    throw new BeanfunError('login.qr_json_parse_failed', 'QR poll response was not JSON');
  }

  switch (parsed.ResultMessage) {
    case 'Failed':
      return 'Failed';
    case 'Wait Login':
      return 'WaitLogin';
    case 'Token Expired':
      return 'TokenExpired';
    case 'Success':
      return 'Approved';
    default:
      throw new BeanfunError('login.server_message', `unknown ResultMessage: ${String(parsed.ResultMessage)}`);
  }
}
