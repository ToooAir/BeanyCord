/**
 * Typed error for the Beanfun protocol layer.
 *
 * Mirrors the role of the Rust `LoginError` enum: a single error type whose
 * `code` lets callers branch (e.g. QR `TokenExpired`, `MissingWebToken`)
 * without string-matching the message. We use a `code` string instead of a
 * full discriminated union to keep the M0 port small; promote to a union if
 * the Discord layer needs exhaustive matching.
 */
export class BeanfunError extends Error {
  constructor(
    public readonly code: string,
    message?: string,
    /** For refusals that will lift on their own: how long until a retry is
     *  worth making. The Discord layer turns this into a concrete instruction,
     *  which is the difference between "try again later" and "try again in 12
     *  seconds" — only one of those stops a user from immediately retrying. */
    public readonly retryAfterMs?: number,
  ) {
    super(message ?? code);
    this.name = 'BeanfunError';
  }
}
