/**
 * The public IP beanfun actually sees us from.
 *
 * Why this exists: on 2026-08-26 two users' sessions were declared logged out in
 * the same minute. Two independent `BeanfunClient`s share exactly three things —
 * this process, this egress IP, and beanfun's own backend. The process is ruled
 * out (each user gets their own `CookieJar`, and a process-level fault produces a
 * connection error, not a parseable `"User is logged out."`), so the egress IP is
 * one of the two remaining suspects. We had never recorded it, so we could not
 * tell whether it had moved. Now we can.
 *
 * Deliberately fail-soft and off the hot path: one request, cached, errors
 * swallowed, never awaited by anything that has to make a decision. It is called
 * when a session is born and when one starts failing — a handful of requests a
 * day, not per ping.
 *
 * `EGRESS_IP_URL=` (empty) disables it entirely.
 */
import got from 'got';

const DEFAULT_URL = 'https://api.ipify.org';
const CACHE_MS = 5 * 60_000;
const TIMEOUT_MS = 5_000;

let cached: { ip: string; at: number } | undefined;

/** Best-effort public IP. Never throws; returns `undefined` when unavailable. */
export async function getEgressIp(): Promise<string | undefined> {
  const url = (process.env.EGRESS_IP_URL ?? DEFAULT_URL).trim();
  if (!url) return undefined;
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.ip;
  try {
    const res = await got.get(url, {
      timeout: { request: TIMEOUT_MS },
      retry: { limit: 0 },
      throwHttpErrors: true,
    });
    // Trim and sanity-check: a captive portal or an error page must not end up
    // in the log looking like an address.
    const ip = res.body.trim();
    if (!/^[0-9a-fA-F.:]{3,45}$/.test(ip)) return undefined;
    cached = { ip, at: Date.now() };
    return ip;
  } catch {
    return undefined;
  }
}

/** Drop the cache — for tests, and for asking again right after a suspected move. */
export function forgetEgressIp(): void {
  cached = undefined;
}
