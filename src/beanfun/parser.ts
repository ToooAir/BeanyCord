/**
 * Pure HTML/URL parsers. Each mirrors a Rust `core/parser/*` regex or an
 * inline `login/*` / `otp.rs` / `games.rs` regex, kept byte-faithful.
 */
import he from 'he';

import type { GameIniEntry, GameService } from './types.js';

// ---- antiforgery token (core/parser/token.rs) ------------------------------
/** `__RequestVerificationToken[^>]+value="([^"]+)"` — first match, empty=miss. */
export function extractVerificationToken(html: string): string | null {
  const m = /__RequestVerificationToken[^>]+value="([^"]+)"/.exec(html);
  return m ? m[1]! : null;
}

// ---- hidden form inputs (core/parser/form.rs) ------------------------------
export type HiddenInput = [name: string, value: string];

/** Scrape every non-submit `<input>` with name + value, in document order. */
export function extractHiddenInputs(html: string): HiddenInput[] {
  const out: HiddenInput[] = [];
  const tagRe = /<input[^>]+>/gis;
  for (const tag of html.match(tagRe) ?? []) {
    if (/type\s*=\s*["']submit["']/i.test(tag)) continue;
    const nm = /name\s*=\s*['"]([^'"]+)['"]/i.exec(tag);
    const vl = /value\s*=\s*['"]([^'"]*)['"]/i.exec(tag); // * keeps empty values
    if (nm && vl) out.push([nm[1]!, vl[1]!]);
  }
  return out;
}

// ---- session key from TW redirect URL (login/session_key.rs) ---------------
/** `[sp][Ss]?[Kk]ey=([^&]+)` — matches `pSKey=`, `sKey=`, ... */
export function sessionKeyFromUrl(url: string): string | null {
  const m = /[sp][Ss]?[Kk]ey=([^&]+)/.exec(url);
  return m ? m[1]! : null;
}

// ---- deeplink normalisation (login/qr_init.rs) -----------------------------
export function normalizeDeeplink(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') return raw;
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return raw;
  }
  if (u.hostname.toLowerCase() !== 'play.games.gamania.com') return raw;
  if (!u.pathname.toLowerCase().includes('deeplink')) return raw;
  for (const [k, v] of u.searchParams) {
    if (k.toLowerCase() === 'url' && v !== '') return v;
  }
  return raw;
}

/**
 * The host that owns the Beanfun app's deep links, and the one path it claims.
 *
 * Not guessed — read off the app-link manifests, which is also how to re-check
 * it if tapping ever stops opening the app:
 *
 *   https://play.games.gamania.com/.well-known/apple-app-site-association
 *     -> appID 343573QVQ5.com.gamania.beanfun, components [{ "/": "/deeplink" }]
 *   https://play.games.gamania.com/.well-known/assetlinks.json
 *     -> handle_all_urls for android_app com.gamania.beanfun
 */
const APP_LINK_ORIGIN = 'https://play.games.gamania.com';
const APP_LINK_PATH = '/deeplink';

/**
 * The https form of the QR deep link, for somewhere that can only render http(s).
 *
 * Beanfun hands out `gameplapp://gameplhost/deeplink?type=1&action=web&code=…`.
 * A phone resolves that scheme fine — pasting it into Safari opens the app — but
 * Discord only turns http/https into something tappable: it does not autolink an
 * unknown scheme, rejects it in a masked link, and refuses it on a link button.
 * So the deep link reached the user as text they had to select and paste by hand,
 * on the one device where the deep link is the whole point (you cannot scan a QR
 * that is on the screen you are holding).
 *
 * Both manifests above claim `/deeplink` on that origin for the Beanfun app, so
 * the same query under https is a universal / app link: with the app installed a
 * tap opens it, and without it the URL is a real page rather than a dead scheme.
 *
 * Returns null rather than guessing when the input is not the shape we know —
 * a link that cannot open the app is worse than no button, because it looks like
 * one that can.
 */
export function appLinkFromDeeplink(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  // Already the https form (e.g. if beanfun goes back to handing that out).
  if (u.protocol === 'https:') {
    const sameTarget =
      `${u.protocol}//${u.host}` === APP_LINK_ORIGIN &&
      u.pathname.toLowerCase().replace(/\/$/, '') === APP_LINK_PATH;
    return sameTarget ? u.toString() : null;
  }
  if (u.protocol !== 'gameplapp:') return null;
  // `new URL` puts `gameplhost` in `hostname` and `/deeplink` in `pathname`.
  if (u.pathname.toLowerCase().replace(/\/$/, '') !== APP_LINK_PATH) return null;
  if (u.search === '') return null;
  return `${APP_LINK_ORIGIN}${APP_LINK_PATH}${u.search}`;
}

// ---- service-account rows (core/parser/account.rs) -------------------------
export interface ServiceAccountRow {
  isEnable: boolean;
  sid: string;
  ssn: string;
  sname: string;
}

/** `onclick="([^"]*)"><div id="(\w+)" sn="(\d+)" name="([^"]+)"` */
export function extractServiceAccounts(html: string): ServiceAccountRow[] {
  const re = /onclick="([^"]*)"><div id="(\w+)" sn="(\d+)" name="([^"]+)"/g;
  const out: ServiceAccountRow[] = [];
  for (const m of html.matchAll(re)) {
    const [, onclick, sid, ssn, snameRaw] = m;
    if (!sid || !ssn || !snameRaw) continue;
    out.push({
      isEnable: onclick !== '',
      sid,
      ssn,
      sname: he.decode(snameRaw),
    });
  }
  return out;
}

/** `<div id="divServiceAccountAmountLimitNotice" class="InnerContent">(.*)</div>` */
export function extractAccountLimitNotice(html: string): string | null {
  const m = /<div id="divServiceAccountAmountLimitNotice" class="InnerContent">(.*)<\/div>/.exec(html);
  return m ? m[1]! : null;
}

/** `ServiceAccountCreateTime: "([^"]+)"` */
export function extractServiceAccountCreateTime(html: string): string | null {
  const m = /ServiceAccountCreateTime: "([^"]+)"/.exec(html);
  return m ? m[1]! : null;
}

// ---- OTP step-1/2 literals (otp.rs) ----------------------------------------
/** `GetResultByLongPolling&key=(.*)"` */
export function extractLongPollingKey(html: string): string | null {
  const m = /GetResultByLongPolling&key=(.*)"/.exec(html);
  return m ? m[1]! : null;
}

/** TW-only `MyAccountData.ServiceAccountCreateTime + "(.*)=(.*)";` (percent-decoded). */
export function extractUnkData(html: string): [string, string] | null {
  const m = /MyAccountData.ServiceAccountCreateTime \+ "(.*)=(.*)";/.exec(html);
  if (!m) return null;
  try {
    return [decodeURIComponent(m[1]!), decodeURIComponent(m[2]!)];
  } catch {
    return null;
  }
}

/** `var m_strSecretCode = '(.*)';` */
export function extractSecretCode(html: string): string | null {
  const m = /var m_strSecretCode = '(.*)';/.exec(html);
  return m ? m[1]! : null;
}

/** The `m_objData` launcher handoff — the marker that a page is on the v2 route. */
export interface LaunchHandoff {
  /** 36-character GUID, sent as `SN` on the v2 OTP request. */
  sn: string;
  /** Obfuscated blob carrying the LaunchTicket; see `launchData.ts`. */
  data: string;
}

/**
 * Extract `m_objData` from step 1's response.
 *
 * Returns null when the literal is absent or either member is empty: the page
 * shape differs by region and only the v2 OTP path needs this, so a miss is not
 * an error at scrape time — it selects the legacy route instead.
 *
 * `sn`/`data` are matched inside the captured block rather than against the
 * whole page, so those generic key names cannot match something else.
 */
export function extractLaunchHandoff(html: string): LaunchHandoff | null {
  const block = /var m_objData\s*=\s*\{([\s\S]*?)\}/.exec(html)?.[1];
  if (!block) return null;
  const sn = /"sn"\s*:\s*"([^"]*)"/.exec(block)?.[1];
  const data = /"data"\s*:\s*"([^"]*)"/.exec(block)?.[1];
  if (!sn || !data) return null;
  return { sn, data };
}

// ---- game catalogue (games.rs) ---------------------------------------------
const INI_KEYS: Record<string, keyof GameIniEntry> = {
  exe: 'exe',
  login_action_type: 'loginActionType',
  win_class_name: 'winClassName',
  dir_value_name: 'dirValueName',
  dir_reg: 'dirReg',
};

const emptyIniEntry = (): GameIniEntry => ({
  exe: '',
  loginActionType: '',
  winClassName: '',
  dirValueName: '',
  dirReg: '',
});

/** Parse `get_service_ini.ashx` into a `section -> entry` map. */
export function parseServiceIni(text: string): Record<string, GameIniEntry> {
  const out: Record<string, GameIniEntry> = {};
  let section: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith(';') || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      if (line.endsWith(']')) {
        section = line.slice(1, -1).trim();
        out[section] ??= emptyIniEntry();
      }
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0 || section === null) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    const field = INI_KEYS[key];
    if (field) (out[section] ??= emptyIniEntry())[field] = value;
  }
  return out;
}

/** Parse `game_zone/` HTML into the ordered service list. */
export function parseServiceList(html: string): GameService[] {
  const m = /Services\.ServiceList = (.*);/.exec(html);
  if (!m) throw new Error('GameListServiceListMissing');
  const literal = m[1]!.trim();
  let items: unknown[];
  if (literal.startsWith('[') && literal.endsWith(']')) {
    items = JSON.parse(literal);
  } else {
    const outer = JSON.parse(literal) as { Rows?: unknown };
    items = Array.isArray(outer.Rows) ? outer.Rows : [];
  }
  return items.map(toGameService);
}

function str(o: Record<string, unknown>, k: string): string {
  const v = o[k];
  return typeof v === 'string' ? v : '';
}

function toGameService(raw: unknown): GameService {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    name: str(o, 'ServiceFamilyName'),
    serviceCode: str(o, 'ServiceCode'),
    serviceRegion: str(o, 'ServiceRegion'),
    websiteUrl: str(o, 'ServiceWebsiteURL'),
    xlargeImageName: str(o, 'ServiceXLargeImageName'),
    largeImageName: str(o, 'ServiceLargeImageName'),
    smallImageName: str(o, 'ServiceSmallImageName'),
    downloadUrl: str(o, 'ServiceDownloadURL'),
  };
}
