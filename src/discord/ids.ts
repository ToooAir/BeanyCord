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
  /** Button (on the OTP message); delete it (the bot removes its own message —
   *  users can't delete a bot's DM message themselves). NOT under `bf:otp:` so
   *  it doesn't collide with the otp-refresh prefix. */
  otpDelete: 'bf:delete',
} as const;

/** Button to re-generate an OTP for a specific account: `bf:otp:<sid>`. */
export const otpRefreshId = (sid: string): string => `bf:otp:${sid}`;
export const parseOtpRefresh = (customId: string): string | null =>
  customId.startsWith('bf:otp:') ? customId.slice('bf:otp:'.length) : null;
