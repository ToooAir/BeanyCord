/**
 * Region endpoints. M0 is TW-only (QR login is TW-only in the original
 * client — `login/qr_init.rs` refuses HK), so we only define TW here.
 *
 * Mirrors Rust `services/beanfun/client.rs::Endpoints::tw()`.
 */
export const TW = {
  /** `https://login.beanfun.com/` — every `/Login/...` path joins here. */
  loginBase: 'https://login.beanfun.com/',
  /** `https://tw.beanfun.com/` — portal: `beanfun_block/...`, return.aspx. */
  portalBase: 'https://tw.beanfun.com/',
  /** `https://tw.newlogin.beanfun.com/` — OTP step-2 host + device poll. */
  newloginBase: 'https://tw.newlogin.beanfun.com/',
} as const;

/** WPF-parity defaults (MapleStory). Used as the initial Session service. */
export const DEFAULT_SERVICE_CODE = '610074';
export const DEFAULT_SERVICE_REGION = 'T9';
