/**
 * QR finalize. Mirrors Rust `login/qr_finalize.rs` (+ shared `send_login`,
 * `return_aspx`, `completed`). Four steps after a poll returns Approved:
 *
 *   1. GET QRLogin/QRLogin (handshake; body discarded).
 *   2. GET Login/SendLogin (QR-specific Accept) -> scrape hidden form inputs.
 *   3. POST return.aspx (NO redirect) with that form. Capture bfWebToken from
 *      Set-Cookie, then DISCARD it; tolerate a missing cookie (WPF parity).
 *   4. POST return.aspx (follow redirects) with the fixed 5-field form
 *      (AuthKey="OK") -> read the canonical bfWebToken from the cookie jar.
 */
import { BeanfunClient, boundedText, ensureSuccess } from '../client.js';
import { DEFAULT_SERVICE_CODE, DEFAULT_SERVICE_REGION, TW } from '../endpoints.js';
import { BeanfunError } from '../errors.js';
import { extractHiddenInputs, type HiddenInput } from '../parser.js';
import type { QrLoginInit, Session } from '../types.js';

const QR_SEND_LOGIN_ACCEPT =
  'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8';

export async function finalizeQrLogin(
  client: BeanfunClient,
  init: QrLoginInit,
): Promise<Session> {
  const indexUrl = `${TW.loginBase}Login/Index?pSKey=${encodeURIComponent(init.skey)}`;

  // Step 1 — handshake (discard body).
  const hs = await client.http.get(`${TW.loginBase}QRLogin/QRLogin`, {
    headers: { accept: 'application/json, text/plain, */*', referer: indexUrl },
  });
  ensureSuccess(hs, 'QRLogin/QRLogin');

  // Step 2 — SendLogin, scrape hidden inputs.
  const slRes = await client.http.get(`${TW.loginBase}Login/SendLogin`, {
    headers: { accept: QR_SEND_LOGIN_ACCEPT, referer: indexUrl },
  });
  ensureSuccess(slRes, 'Login/SendLogin');
  const form = extractHiddenInputs(boundedText(slRes));
  if (form.length === 0) throw new BeanfunError('login.send_login_no_form', 'SendLogin had no inputs');

  // Step 3 — return.aspx (no redirect). Capture+discard token; tolerate miss.
  await postReturnAspxNoRedirect(client, form).catch((e: unknown) => {
    if (e instanceof BeanfunError && e.code === 'login.missing_web_token') return;
    throw e;
  });

  // Step 4 — shared LoginCompleted tail (AuthKey="OK").
  return loginCompleted(client, init.skey, 'OK', '');
}

/** Step 3: no-redirect POST, scrape bfWebToken from the 302 Set-Cookie. */
async function postReturnAspxNoRedirect(client: BeanfunClient, form: HiddenInput[]): Promise<string> {
  const res = await client.httpNoRedirect.post(`${TW.portalBase}beanfun_block/bflogin/return.aspx`, {
    headers: { referer: TW.loginBase },
    form: Object.fromEntries(form),
  });
  if (!(res.statusCode >= 200 && res.statusCode < 400)) {
    throw new BeanfunError('http.non_success', `return.aspx returned HTTP ${res.statusCode}`);
  }
  const setCookie = res.headers['set-cookie'] ?? [];
  for (const h of setCookie) {
    const m = /bfWebToken=([^;]+)/i.exec(h);
    if (m) return m[1]!;
  }
  throw new BeanfunError('login.missing_web_token', 'no bfWebToken in return.aspx Set-Cookie');
}

/** Step 4: redirect-following 5-field POST, read bfWebToken from the jar. */
async function loginCompleted(
  client: BeanfunClient,
  sessionKey: string,
  akey: string,
  accountId: string,
): Promise<Session> {
  const res = await client.http.post(`${TW.portalBase}beanfun_block/bflogin/return.aspx`, {
    headers: { referer: TW.loginBase },
    form: {
      SessionKey: sessionKey,
      AuthKey: akey,
      ServiceCode: '',
      ServiceRegion: '',
      ServiceAccountSN: '0',
    },
  });
  ensureSuccess(res, 'return.aspx (LoginCompleted)');

  const webToken = await client.readBfWebToken();
  if (!webToken) throw new BeanfunError('login.missing_web_token', 'no bfWebToken after LoginCompleted');

  return {
    region: 'TW',
    skey: sessionKey,
    webToken,
    accountId,
    serviceCode: DEFAULT_SERVICE_CODE,
    serviceRegion: DEFAULT_SERVICE_REGION,
  };
}
