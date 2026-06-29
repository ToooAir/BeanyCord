export type Region = 'TW' | 'HK';

/**
 * Successful-login handle. Mirrors Rust `services/beanfun/session.rs::Session`.
 * `webToken` / `skey` are session secrets — never send them to Discord.
 */
export interface Session {
  region: Region;
  skey: string;
  webToken: string;
  /** Empty after QR login (the scan resolves it); filled by getAccounts UX. */
  accountId: string;
  serviceCode: string;
  serviceRegion: string;
  /** Selected game's display name — UI-only, set by the Discord flow so OTP /
   *  account messages stay self-explanatory. Optional (older persisted sessions
   *  won't have it). */
  serviceName?: string;
}

/** One row of the user's service-account list. Mirrors Rust `ServiceAccount`. */
export interface ServiceAccount {
  isEnable: boolean;
  sid: string;
  ssn: string;
  sname: string;
  /** null when the per-account create-time scrape failed (tolerated by OTP). */
  screatetime: string | null;
}

/** One game from `game_zone/`'s `Services.ServiceList`. Mirrors `GameService`. */
export interface GameService {
  name: string;
  serviceCode: string;
  serviceRegion: string;
  websiteUrl: string;
  xlargeImageName: string;
  largeImageName: string;
  smallImageName: string;
  downloadUrl: string;
}

/** One INI section from `get_service_ini.ashx`. Mirrors `GameIniEntry`. */
export interface GameIniEntry {
  exe: string;
  loginActionType: string;
  winClassName: string;
  dirValueName: string;
  dirReg: string;
}

/** QR bootstrap payload. Mirrors Rust `QrLoginInit`. */
export interface QrLoginInit {
  skey: string;
  /** Full `data:image/png;base64,...` data URL — the server-provided PNG. */
  bitmapBase64: string;
  deeplink: string | null;
  /** `__RequestVerificationToken` replayed by the poll step. */
  verificationToken: string;
}

/** QR poll outcome. Mirrors Rust `QrPollOutcome`. */
export type QrPollOutcome = 'WaitLogin' | 'Failed' | 'TokenExpired' | 'Approved';
