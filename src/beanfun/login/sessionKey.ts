/**
 * Obtain the TW portal session key (`pSKey`). Mirrors Rust
 * `login/session_key.rs::get_session_key_tw`: GET default.aspx, follow the
 * redirect chain, scrape `pSKey` from the FINAL URL.
 */
import { BeanfunClient, ensureSuccess, finalUrl } from '../client.js';
import { TW } from '../endpoints.js';
import { BeanfunError } from '../errors.js';
import { sessionKeyFromUrl } from '../parser.js';

export async function getSessionKey(client: BeanfunClient): Promise<string> {
  const res = await client.http.get(
    `${TW.portalBase}beanfun_block/bflogin/default.aspx?service=999999_T0`,
  );
  ensureSuccess(res, 'default.aspx');

  // The key is on the final redirected URL's query. Scan the final URL first,
  // then any redirect hop, defensively.
  const candidates = [finalUrl(res), res.url, ...(res.redirectUrls ?? []).map(String)];
  for (const u of candidates) {
    const key = sessionKeyFromUrl(u);
    if (key) return key;
  }
  throw new BeanfunError('login.missing_session_key', `no pSKey in: ${finalUrl(res)}`);
}
