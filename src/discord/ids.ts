/** customId routing constants for buttons / select menus. */
export const CID = {
  /** StringSelectMenu; value = `${serviceCode}_${serviceRegion}`. */
  gameSelect: 'bf:game',
  /** StringSelectMenu; value = sid. */
  accountSelect: 'bf:account',
  /** Button; re-issue a fresh QR. */
  loginRefresh: 'bf:login:refresh',
  /** Button; cancel the in-flight login. */
  loginCancel: 'bf:login:cancel',
} as const;

/** Button to re-generate an OTP for a specific account: `bf:otp:<sid>`. */
export const otpRefreshId = (sid: string): string => `bf:otp:${sid}`;
export const parseOtpRefresh = (customId: string): string | null =>
  customId.startsWith('bf:otp:') ? customId.slice('bf:otp:'.length) : null;
