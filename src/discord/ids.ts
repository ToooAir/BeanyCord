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
  /** Button (on the OTP message); re-open the game menu for the current session. */
  gameAgain: 'bf:game:again',
  /** Button (on the OTP message); re-open the account menu for the current game. */
  accountAgain: 'bf:account:again',
} as const;

/** Button to re-generate an OTP for a specific account: `bf:otp:<sid>`. */
export const otpRefreshId = (sid: string): string => `bf:otp:${sid}`;
export const parseOtpRefresh = (customId: string): string | null =>
  customId.startsWith('bf:otp:') ? customId.slice('bf:otp:'.length) : null;
