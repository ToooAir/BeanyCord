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
  ) {
    super(message ?? code);
    this.name = 'BeanfunError';
  }
}
