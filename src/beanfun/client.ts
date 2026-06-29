/**
 * HTTP client wrapper. Mirrors Rust `services/beanfun/client.rs::BeanfunClient`:
 * one cookie jar shared by two `got` instances — `http` (follows redirects)
 * and `httpNoRedirect` (captures `Set-Cookie` off the return.aspx 302 before
 * a redirect swallows it).
 *
 * Proxy support is wired from day 1 (env `BEANFUN_PROXY`) so that, if the
 * 24/7 host's overseas IP gets blocked by Beanfun TW risk control, pointing at
 * a Taiwan proxy is a config change, not a code change.
 */
import got, { type Got, type Response } from 'got';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { CookieJar } from 'tough-cookie';

import { redactUrl } from '../core/redact.js';
import { TW } from './endpoints.js';
import { BeanfunError } from './errors.js';

/** Chrome-on-Windows UA — the HK portal rejects non-browser UAs; we keep it
 *  uniform for TW too. Matches Rust `DEFAULT_USER_AGENT`. */
export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 16 * 1024 * 1024;

export interface ClientOptions {
  /** Proxy URL (http/https). Defaults to env `BEANFUN_PROXY`. */
  proxy?: string;
  debug?: boolean;
  /** Restore an existing cookie jar (session resume). Defaults to a fresh jar. */
  jar?: CookieJar;
}

export class BeanfunClient {
  readonly jar: CookieJar;
  /** Follows redirects (default for every call). */
  readonly http: Got;
  /** Does NOT follow redirects — for the return.aspx Set-Cookie scrape. */
  readonly httpNoRedirect: Got;

  constructor(opts: ClientOptions = {}) {
    this.jar = opts.jar ?? new CookieJar();
    const proxy = opts.proxy ?? process.env.BEANFUN_PROXY ?? '';
    const debug = opts.debug ?? process.env.BEANFUN_DEBUG === '1';

    const agent = proxy
      ? { https: new HttpsProxyAgent(proxy), http: new HttpsProxyAgent(proxy) }
      : undefined;

    const base = got.extend({
      cookieJar: this.jar,
      timeout: { request: TIMEOUT_MS },
      headers: { 'user-agent': USER_AGENT },
      // We check status manually via ensureSuccess (mirrors Rust), and the
      // no-redirect 302 must NOT throw.
      throwHttpErrors: false,
      decompress: true,
      retry: { limit: 0 },
      maxRedirects: 10,
      ...(agent ? { agent } : {}),
      hooks: debug
        ? {
            beforeRequest: [
              (o) => {
                // Never log cookie values / bodies, and redact secret query
                // params (WebToken/SecretCode/skey/...) that ride in the URL.
                process.stderr.write(`[http] ${o.method} ${redactUrl(String(o.url))}\n`);
              },
            ],
          }
        : undefined,
    });

    this.http = base.extend({ followRedirect: true });
    this.httpNoRedirect = base.extend({ followRedirect: false });
  }

  /** Read `bfWebToken` from the jar, scoped to the TW portal host (RFC 6265
   *  domain-match), mirroring Rust `read_bfwebtoken_from_jar`. */
  async readBfWebToken(): Promise<string | undefined> {
    const cookies = await this.jar.getCookies('https://tw.beanfun.com/');
    const hit = cookies.find((c) => c.key.toLowerCase() === 'bfwebtoken');
    return hit?.value;
  }

  /** Session keep-alive. Mirrors Rust `BeanfunClient::ping` (WPF pingWorker):
   *  GET `echo_token.ashx?webtoken=1` on the portal host. Throws on non-2xx;
   *  the caller's 60s loop swallows failures and retries next tick. */
  async ping(): Promise<void> {
    const res = await this.http.get(
      `${TW.portalBase}beanfun_block/generic_handlers/echo_token.ashx`,
      { searchParams: { webtoken: '1' } },
    );
    ensureSuccess(res, 'echo_token.ashx');
  }
}

/** Throw on non-2xx, mirroring Rust `ensure_success`. */
export function ensureSuccess(res: Response, step: string): void {
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new BeanfunError('http.non_success', `${step} returned HTTP ${res.statusCode}`);
  }
}

/** Guard against oversized bodies (got buffers fully; we check after). */
export function boundedText(res: Response): string {
  const body = typeof res.body === 'string' ? res.body : String(res.body ?? '');
  if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
    throw new BeanfunError('http.body_too_large', 'response body exceeded 16 MiB');
  }
  return body;
}

/** Final URL of a (possibly redirected) response. */
export function finalUrl(res: Response): string {
  const redirects = res.redirectUrls ?? [];
  const last = redirects.length > 0 ? redirects[redirects.length - 1] : undefined;
  return last ? String(last) : res.url;
}
