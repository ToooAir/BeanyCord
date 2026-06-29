/**
 * QR init. Mirrors Rust `login/qr_init.rs`:
 *   1. GET Login/Index?pSKey -> scrape __RequestVerificationToken (lenient).
 *   2. GET Login/InitLogin?pSKey -> JSON { Result, ResultData:{QRImage,DeepLink} }.
 * QRImage is a server-provided base64 PNG (we just prepend the data-URL prefix).
 */
import { BeanfunClient, boundedText, ensureSuccess } from '../client.js';
import { TW } from '../endpoints.js';
import { BeanfunError } from '../errors.js';
import { extractVerificationToken, normalizeDeeplink } from '../parser.js';
import type { QrLoginInit } from '../types.js';

interface InitLoginResponse {
  Result?: number;
  ResultData?: { QRImage?: string; DeepLink?: string };
}

export async function initQrLogin(client: BeanfunClient, skey: string): Promise<QrLoginInit> {
  const indexUrl = `${TW.loginBase}Login/Index?pSKey=${encodeURIComponent(skey)}`;

  // Step 1 — lenient: continue with empty token if the input is absent.
  const indexRes = await client.http.get(indexUrl, { headers: { accept: 'text/html' } });
  ensureSuccess(indexRes, 'Login/Index');
  const verificationToken = extractVerificationToken(boundedText(indexRes)) ?? '';

  // Step 2 — JSON.
  const initUrl = `${TW.loginBase}Login/InitLogin?pSKey=${encodeURIComponent(skey)}`;
  const initRes = await client.http.get(initUrl, {
    headers: {
      accept: 'application/json, text/plain, */*',
      referer: indexUrl,
      'x-requested-with': 'XMLHttpRequest',
      origin: 'https://login.beanfun.com',
    },
  });
  ensureSuccess(initRes, 'Login/InitLogin');

  let parsed: InitLoginResponse;
  try {
    parsed = JSON.parse(boundedText(initRes)) as InitLoginResponse;
  } catch {
    throw new BeanfunError('login.qr_init_json', 'InitLogin response was not JSON');
  }

  if (parsed.Result == null || parsed.Result !== 0) {
    throw new BeanfunError('login.qr_init_result', `InitLogin Result=${String(parsed.Result)}`);
  }
  const data = parsed.ResultData;
  const raw = data?.QRImage;
  if (!raw) throw new BeanfunError('login.qr_init_result', 'InitLogin missing QRImage');

  const deepRaw = data?.DeepLink ?? '';
  const deeplink = deepRaw ? normalizeDeeplink(deepRaw) || null : null;

  return {
    skey,
    bitmapBase64: `data:image/png;base64,${raw}`,
    deeplink: deeplink && deeplink !== '' ? deeplink : null,
    verificationToken,
  };
}
