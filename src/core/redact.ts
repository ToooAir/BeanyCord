/**
 * Secret redaction for logs and user-facing error text (M3 hardening).
 *
 * Beanfun puts session secrets in URL query strings (`WebToken`, `SecretCode`,
 * `skey`, the `ppppp` constant, the long-polling `key`/`SN`, etc.), so the
 * `BEANFUN_DEBUG` request log and any error message that embeds a URL or a
 * server body fragment can leak them. Everything that reaches a log sink or a
 * Discord message about an *error* must pass through here first. (OTP values
 * intentionally sent to the user's DM never go through error paths.)
 */

/** Query-param names whose values are sensitive (matched case-insensitively). */
const SENSITIVE_PARAMS = [
  'webtoken',
  'web_token',
  'secretcode',
  'ppppp',
  'skey',
  'sessionkey',
  'bfwebtoken',
  'pskey',
  'akey',
  'token',
  'key',
  'sn',
  'sotp',
  'verify_code',
  'password',
];

const PARAM_RE = new RegExp(`\\b(${SENSITIVE_PARAMS.join('|')})=([^&\\s"'<>]+)`, 'gi');
const MAX_LEN = 300;

/** Redact sensitive `key=value` pairs anywhere in a string, then cap length. */
export function redactText(s: string): string {
  const out = s.replace(PARAM_RE, (_, k: string) => `${k}=***`);
  return out.length > MAX_LEN ? `${out.slice(0, MAX_LEN)}…` : out;
}

/** Redact sensitive query params in a URL; falls back to text redaction. */
export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    for (const k of [...u.searchParams.keys()]) {
      if (SENSITIVE_PARAMS.includes(k.toLowerCase())) u.searchParams.set(k, '***');
    }
    return `${u.origin}${u.pathname}${u.search}`;
  } catch {
    return redactText(raw);
  }
}

/** A log/display-safe string for any thrown value. */
export function safeError(e: unknown): string {
  return redactText(e instanceof Error ? e.message : String(e));
}
