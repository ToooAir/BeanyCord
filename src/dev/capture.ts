/**
 * Dev-only: capture what Beanfun REALLY returns on each endpoint, for a session
 * whose state you control. NOT part of the deployed bot (excluded from the build).
 *
 * Why this exists: every "session is dead" check in this codebase rests on an
 * assumption about the shape of the dead response, and each time that assumption
 * was left unverified it turned out to be wrong somewhere — `ping()` trusted the
 * status code and stayed blind for five weeks; `getAccounts` read an empty list
 * as "you have no accounts". The fix is not to test against a live session
 * forever, it is to capture the real bytes ONCE and turn them into offline
 * fixtures.
 *
 * Usage:
 *   1. `npm run m0 -- --persist`   (or just use the bot) to get a session on disk
 *   2. `npm run capture`           while the session is ALIVE   -> capture/alive/
 *   3. kill the session (log in on another device)
 *   4. `npm run capture`           while the session is DEAD    -> capture/dead/
 *
 * Then diff the two and promote the interesting bodies to test/fixtures/.
 * Output goes to `capture/` which is gitignored: raw bodies contain bfWebToken,
 * account ids and character names. NOTHING here is safe to commit unscrubbed.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import 'dotenv/config';
import { CookieJar } from 'tough-cookie';

import { BeanfunClient, isLoggedOutEcho, looksLikeSessionExpiredPage } from '../beanfun/client.js';
import { TW } from '../beanfun/endpoints.js';
import { redactText, redactUrl } from '../core/redact.js';
import { createStore } from '../core/store.js';
import type { Session } from '../beanfun/types.js';

/** Slot id `m0 --persist` writes to — keep in sync with `src/m0.ts`. */
const M0_SLOT = 'm0-capture';

interface Probe {
  name: string;
  url: string;
  searchParams?: Record<string, string>;
  /** Skipped (with a reason) when the persisted session lacks a game choice. */
  needsGame?: boolean;
}

function probes(session: Session, liveToken: string): Probe[] {
  const sc = session.serviceCode;
  const sr = session.serviceRegion;
  return [
    {
      name: 'echo_token.ashx',
      url: `${TW.portalBase}beanfun_block/generic_handlers/echo_token.ashx`,
      searchParams: { webtoken: '1' },
    },
    { name: 'game_zone', url: `${TW.portalBase}game_zone/` },
    {
      name: 'get_service_ini.ashx',
      url: `${TW.portalBase}beanfun_block/generic_handlers/get_service_ini.ashx`,
    },
    {
      name: 'auth.aspx',
      url: `${TW.portalBase}beanfun_block/auth.aspx`,
      searchParams: {
        channel: 'game_zone',
        page_and_query: `game_start.aspx?service_code_and_region=${sc}_${sr}`,
        web_token: liveToken,
      },
      needsGame: true,
    },
    {
      name: 'game_server_account_list.aspx',
      url: `${TW.portalBase}beanfun_block/game_zone/game_server_account_list.aspx`,
      searchParams: { sc, sr, dt: String(Date.now()) },
      needsGame: true,
    },
  ];
}

/** What each detector concludes about this body — the whole point of the run. */
function verdict(name: string, body: string): string {
  if (name === 'echo_token.ashx') {
    return isLoggedOutEcho(body) ? 'DEAD (isLoggedOutEcho)' : 'alive (isLoggedOutEcho)';
  }
  return looksLikeSessionExpiredPage(body)
    ? 'DEAD (looksLikeSessionExpiredPage)'
    : 'alive (looksLikeSessionExpiredPage)';
}

async function main(): Promise<void> {
  const state = process.argv[2];
  if (state !== 'alive' && state !== 'dead') {
    console.error('Usage: npm run capture -- <alive|dead>');
    process.exitCode = 1;
    return;
  }

  const store = createStore();
  if (!store) {
    console.error('No SESSION_ENCRYPTION_KEY — nothing is persisted, so there is nothing to load.');
    process.exitCode = 1;
    return;
  }

  const all = store.loadAll();
  if (all.size === 0) {
    console.error('No persisted sessions. Run `npm run m0 -- --persist` first.');
    process.exitCode = 1;
    return;
  }
  // Never guess when several slots exist: the DB normally also holds real users'
  // sessions, and picking one by row order would fire requests with the wrong
  // person's credentials. Prefer the explicit env var, then the dedicated m0
  // slot, then a lone session — otherwise refuse and list the choices.
  const wanted = process.env.CAPTURE_USER_ID?.trim() || (all.has(M0_SLOT) ? M0_SLOT : undefined);
  const userId = wanted ?? (all.size === 1 ? [...all.keys()][0]! : undefined);
  if (!userId) {
    console.error(
      `Several sessions are persisted — refusing to guess.\n` +
        `  Slots: ${[...all.keys()].join(', ')}\n` +
        `  Pick one with CAPTURE_USER_ID=<slot>, or create a dedicated one with ` +
        '`npm run m0 -- --persist`.',
    );
    process.exitCode = 1;
    return;
  }
  const payload = all.get(userId);
  if (!payload) {
    console.error(`No persisted session for ${userId}. Present: ${[...all.keys()].join(', ')}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[capture] using session slot "${userId}" (state: ${state})`);

  const jar = await CookieJar.deserialize(payload.cookies as never);
  const client = new BeanfunClient({ jar });
  const session = payload.session;
  const liveToken = (await client.readBfWebToken()) ?? session.webToken;

  const outDir = join(process.env.CAPTURE_OUT?.trim() || 'capture', state);
  mkdirSync(outDir, { recursive: true, mode: 0o700 });

  const rows: string[] = [];
  for (const p of probes(session, liveToken)) {
    if (p.needsGame && (!session.serviceCode || !session.serviceRegion)) {
      console.log(`  - ${p.name}: SKIPPED (persisted session has no game selected)`);
      continue;
    }
    try {
      const res = await client.http.get(p.url, p.searchParams ? { searchParams: p.searchParams } : {});
      const body = typeof res.body === 'string' ? res.body : String(res.body ?? '');
      writeFileSync(join(outDir, `${p.name}.txt`), body, { mode: 0o600 });
      const line = `${p.name}: HTTP ${res.statusCode}, ${Buffer.byteLength(body)} bytes -> ${verdict(p.name, body)}`;
      rows.push(line);
      console.log(`  - ${line}`);
      console.log(`      final url: ${redactUrl(String(res.url))}`);
      console.log(`      head:      ${redactText(body.slice(0, 160)).replace(/\s+/g, ' ')}`);
    } catch (e) {
      const line = `${p.name}: THREW ${e instanceof Error ? redactText(e.message) : String(e)}`;
      rows.push(line);
      console.log(`  - ${line}`);
    }
  }

  writeFileSync(join(outDir, 'summary.txt'), `${rows.join('\n')}\n`, { mode: 0o600 });
  store.close();
  console.log(
    `\n[capture] raw bodies written to ${outDir}/ — GITIGNORED, they contain bfWebToken,\n` +
      '          account ids and character names. Scrub before promoting to test/fixtures/.',
  );
}

main().catch((err: unknown) => {
  console.error('[capture] failed:', err instanceof Error ? redactText(err.message) : err);
  process.exitCode = 1;
});
