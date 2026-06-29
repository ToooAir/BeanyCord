/**
 * Service-account listing. Mirrors Rust `account.rs::get_accounts`:
 *   1. GET auth.aspx (cookie side-effect; body discarded).
 *   2. GET game_server_account_list.aspx -> parse rows + quota notice.
 *   3. Per row, GET game_start_step2.aspx -> scrape create-time (best-effort,
 *      5s timeout, failures degrade to null), concurrently.
 *   4. Sort by ascending ssn.
 */
import { BeanfunClient, boundedText, ensureSuccess } from './client.js';
import { TW } from './endpoints.js';
import {
  extractAccountLimitNotice,
  extractServiceAccountCreateTime,
  extractServiceAccounts,
} from './parser.js';
import { dtCompact } from './time.js';
import type { ServiceAccount, Session } from './types.js';

export type AmountLimitNotice =
  | { kind: 'none' }
  | { kind: 'authReLoginRequired' }
  | { kind: 'other'; text: string };

export interface AccountListResult {
  accounts: ServiceAccount[];
  amountLimitNotice: AmountLimitNotice;
}

export async function getAccounts(
  client: BeanfunClient,
  session: Session,
  serviceCode: string,
  serviceRegion: string,
): Promise<AccountListResult> {
  await authAspx(client, session, serviceCode, serviceRegion);
  const body = await fetchAccountListHtml(client, serviceCode, serviceRegion);

  const rows = extractServiceAccounts(body);
  const createTimes = await Promise.all(
    rows.map((r) => getCreateTime(client, serviceCode, serviceRegion, r.ssn)),
  );

  const accounts: ServiceAccount[] = rows.map((r, i) => ({
    isEnable: r.isEnable,
    sid: r.sid,
    ssn: r.ssn,
    sname: r.sname,
    screatetime: createTimes[i] ?? null,
  }));
  accounts.sort((a, b) => (a.ssn < b.ssn ? -1 : a.ssn > b.ssn ? 1 : 0));

  return { accounts, amountLimitNotice: classifyNotice(body) };
}

/** GET auth.aspx — cookie side-effect only. Prefer the live jar bfWebToken. */
async function authAspx(
  client: BeanfunClient,
  session: Session,
  serviceCode: string,
  serviceRegion: string,
): Promise<void> {
  const inner = `game_start.aspx?service_code_and_region=${serviceCode}_${serviceRegion}`;
  const liveToken = (await client.readBfWebToken()) ?? session.webToken;
  const res = await client.http.get(`${TW.portalBase}beanfun_block/auth.aspx`, {
    searchParams: {
      channel: 'game_zone',
      page_and_query: inner,
      web_token: liveToken,
    },
  });
  ensureSuccess(res, 'auth.aspx');
}

async function fetchAccountListHtml(
  client: BeanfunClient,
  serviceCode: string,
  serviceRegion: string,
): Promise<string> {
  const res = await client.http.get(
    `${TW.portalBase}beanfun_block/game_zone/game_server_account_list.aspx`,
    { searchParams: { sc: serviceCode, sr: serviceRegion, dt: dtCompact() } },
  );
  ensureSuccess(res, 'game_server_account_list.aspx');
  return boundedText(res);
}

/** Best-effort per-account create-time; any failure -> null. 5s budget. */
async function getCreateTime(
  client: BeanfunClient,
  serviceCode: string,
  serviceRegion: string,
  sn: string,
): Promise<string | null> {
  try {
    const res = await client.http.get(
      `${TW.portalBase}beanfun_block/game_zone/game_start_step2.aspx`,
      {
        searchParams: { service_code: serviceCode, service_region: serviceRegion, sotp: sn, dt: dtCompact() },
        timeout: { request: 5_000 },
      },
    );
    if (res.statusCode < 200 || res.statusCode >= 300) return null;
    return extractServiceAccountCreateTime(boundedText(res));
  } catch {
    return null;
  }
}

function classifyNotice(body: string): AmountLimitNotice {
  const text = extractAccountLimitNotice(body);
  if (text === null) return { kind: 'none' };
  if (text.includes('進階認證')) return { kind: 'authReLoginRequired' };
  return { kind: 'other', text };
}
