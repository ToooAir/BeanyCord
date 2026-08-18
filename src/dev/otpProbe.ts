/**
 * Dev-only: run the real OTP chain with instrumentation, to find out why the
 * server answers step 5 with `0;Secret codes do not match!`.
 *
 * That message is a *deliberate validation branch*: the server read our request
 * and rejected one of its values — unlike the `Query String Error` upstream
 * gets, which is a refusal to read it at all. So for this account the endpoint
 * is not simply retired, and the question is which input is wrong.
 *
 * Settled so far, by running this:
 *   - WebToken is NOT drifting (session copy and jar cookie are identical).
 *   - The page's `m_objData` decodes perfectly, but carries no `LaunchTicket` —
 *     it hands over the legacy parameters, including a per-request `ppppp`
 *     longer than the constant we had hardcoded.
 *
 * So the sweep at the end varies the two remaining suspects — the secret code's
 * source and `ppppp`'s source — over the legacy endpoint, and reports which
 * combination the server accepts.
 *
 * A second sweep follows it, with secret and `ppppp` pinned to the combination
 * the first one proved: it varies only the `CV`/`Hash`/`arch` launcher identity
 * — omitted, ours, deliberately wrong — to settle whether the legacy endpoint
 * reads that triple at all. We ship it on this route on an upstream note rather
 * than on a measurement, and if the endpoint validates a pair it is handed, then
 * sending one it does not require is us putting the fallback behind the same
 * expiring GGM pin as v2.
 *
 * A third sweep asks v2 the same question, which is the one that actually
 * matters: the whole "the GGM pin expires and everyone breaks together" risk
 * assumes `get_webstart_otp_v2.ashx` validates the pair, and that has never
 * been measured. Each arm gets a freshly fetched LaunchTicket so a spent ticket
 * cannot masquerade as a rejected identity, and the reading is withheld unless
 * the baseline arm succeeded.
 *
 * A fourth sweep follows from what the third one finds. If the gate is real,
 * an expiring pin breaks everyone at once and nothing detects it until a user
 * happens to take the v2 route — which a deployment sitting on legacy games may
 * not do for months. So it asks whether the gate answers a request carrying a
 * deliberately worthless ticket, with and without session cookies: if it does,
 * the pin can be watched by a scheduled request that burns no ticket, needs no
 * user, and produces no OTP.
 *
 * Usage:
 *   npm run probe:otp                        # the game the session last used
 *   npm run probe:otp -- --list-games        # what else this account can probe
 *   SERVICE_CODE=610074 SERVICE_REGION=T9 npm run probe:otp
 *   npm run probe:otp -- --write             # also dump raw bodies + headers
 *
 * Switching games needs no fresh login: a game is two fields on the session, and
 * the override runs the shipped `getAccounts`, whose `auth.aspx` call is what
 * actually moves the portal onto that game.
 *
 * Fires real requests with a real session and generates a real OTP. Raw output
 * goes to `capture/otp/`, which is gitignored: it contains bfWebToken, the
 * secret code, account ids and character names.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CookieJar } from 'tough-cookie';

import { getAccounts } from '../beanfun/account.js';
import { BeanfunClient, boundedText } from '../beanfun/client.js';
import { GGM_ARCH, GGM_CV, GGM_HASH } from '../beanfun/clientIntegrity.js';
import { TW } from '../beanfun/endpoints.js';
import { listGames } from '../beanfun/games.js';
import { decodeLaunchFields, decodeLaunchTicket } from '../beanfun/launchData.js';
import { getOtp } from '../beanfun/otp.js';
import {
  extractLaunchHandoff,
  extractLongPollingKey,
  extractSecretCode,
  extractServiceAccountCreateTime,
  extractUnkData,
} from '../beanfun/parser.js';
import { redactText, redactUrl } from '../core/redact.js';
import { loadPersistedSession } from './loadSession.js';

import type { Session } from '../beanfun/types.js';

/** Compare two secrets without printing either: equal inputs -> equal tags. */
function fp(v: string | undefined): string {
  if (!v) return '<none>';
  return `${createHash('sha256').update(v).digest('hex').slice(0, 10)}/${v.length}c`;
}

/** Cookie inventory for a host — names and scoping only, never values. */
async function cookieShape(jar: CookieJar, url: string): Promise<string> {
  const cookies = await jar.getCookies(url);
  if (cookies.length === 0) return '<no cookies sent>';
  return cookies
    .map((c) => {
      const scope = c.hostOnly ? `host:${c.domain}` : `domain:.${c.domain}`;
      return `${c.key}(${scope}${c.secure ? ',secure' : ''})`;
    })
    .join(' ');
}

let outDir = '';
function dump(name: string, text: string): void {
  if (!outDir) return;
  writeFileSync(join(outDir, name), text, { mode: 0o600 });
}

async function main(): Promise<void> {
  const loaded = await loadPersistedSession();
  if (!loaded) {
    process.exitCode = 1;
    return;
  }
  const { userId, jar, client, session, store } = loaded;

  if (process.argv.includes('--write')) {
    outDir = join(process.env.CAPTURE_OUT?.trim() || 'capture', 'otp');
    mkdirSync(outDir, { recursive: true, mode: 0o700 });
  }
  console.log(`[probe] session slot "${userId}"\n`);

  // --- H1 check: does step 5's WebToken parameter still match the jar? --------
  const jarToken = await client.readBfWebToken();
  console.log('== token alignment ==');
  console.log(`  session.webToken (sent as WebToken= on step 5): ${fp(session.webToken)}`);
  console.log(`  jar bfWebToken   (sent as a cookie everywhere): ${fp(jarToken)}`);
  const tokenMismatch = !!jarToken && jarToken !== session.webToken;
  console.log(`  -> ${tokenMismatch ? 'TOKEN MISMATCH (H1 confirmed)' : 'aligned'}\n`);

  // --- Which game? -----------------------------------------------------------
  // The persisted session carries whichever game was last picked, but a game is
  // just two fields — switching does NOT need a fresh login. `--list-games`
  // prints the catalogue; SERVICE_CODE/SERVICE_REGION probe any of them.
  if (process.argv.includes('--list-games')) {
    const { services } = await listGames(client);
    console.log(`${services.length} services:\n`);
    for (const g of services) {
      const here = g.serviceCode === session.serviceCode && g.serviceRegion === session.serviceRegion;
      console.log(`  ${`${g.serviceCode}_${g.serviceRegion}`.padEnd(14)} ${g.name}${here ? '   <- session' : ''}`);
    }
    console.log('\nProbe one with:  SERVICE_CODE=610074 SERVICE_REGION=T9 npm run probe:otp');
    store.close();
    return;
  }

  const sc = process.env.SERVICE_CODE?.trim() || session.serviceCode;
  const sr = process.env.SERVICE_REGION?.trim() || session.serviceRegion;
  if (!sc || !sr) {
    console.error('No game: the session has none and SERVICE_CODE/SERVICE_REGION are unset.');
    store.close();
    process.exitCode = 1;
    return;
  }
  const overridden = sc !== session.serviceCode || sr !== session.serviceRegion;
  console.log(`== game ${sc}_${sr}${overridden ? ' (override — session holds ' + `${session.serviceCode}_${session.serviceRegion})` : ''} ==`);

  // Go through the shipped `getAccounts`, not a hand-rolled list fetch: it fires
  // `auth.aspx` first, which is what actually switches the portal to this game.
  // Skipping it works only while the session already sits on the game you want.
  const probeSession: Session = { ...session, serviceCode: sc, serviceRegion: sr };
  const { accounts } = await getAccounts(client, probeSession, sc, sr);
  const account = accounts[0];
  if (!account) {
    console.error('No service accounts for this game — you may not own one on it.');
    store.close();
    process.exitCode = 1;
    return;
  }
  console.log(`== using account ssn=${fp(account.ssn)} (of ${accounts.length}) ==\n`);

  // --- Step 1 ----------------------------------------------------------------
  const s1 = await client.http.get(`${TW.portalBase}beanfun_block/game_zone/game_start_step2.aspx`, {
    searchParams: { service_code: sc, service_region: sr, sotp: account.ssn, dt: String(Date.now()) },
  });
  const s1Body = boundedText(s1);
  dump('1_game_start_step2.txt', s1Body);
  const longPollingKey = extractLongPollingKey(s1Body);
  const unkData = extractUnkData(s1Body);
  // The account list carries no create-time, so use step 1's fallback — the
  // same path the bot takes for accounts whose per-account fetch came back empty.
  const screatetime = extractServiceAccountCreateTime(s1Body);
  console.log('== step 1: game_start_step2.aspx ==');
  console.log(`  HTTP ${s1.statusCode}, ${Buffer.byteLength(s1Body)} bytes`);
  console.log(`  longPollingKey: ${longPollingKey ? fp(longPollingKey) : 'MISSING'}`);
  console.log(`  unkData: ${unkData ? `${unkData[0]}=<set>` : 'MISSING'}   screatetime: ${screatetime ?? 'MISSING'}`);

  // The routing question, per pungin/Beanfun@fbb5b0f: a page carrying the
  // `m_objData` launcher handoff is one whose OTP now comes from
  // get_webstart_otp_v2.ashx, and the endpoint we still call is retired.
  const block = /var m_objData\s*=\s*\{([\s\S]*?)\}/.exec(s1Body)?.[1];
  const handoffSn = block ? /"sn"\s*:\s*"([^"]*)"/.exec(block)?.[1] : undefined;
  const handoffData = block ? /"data"\s*:\s*"([^"]*)"/.exec(block)?.[1] : undefined;
  console.log('  --- v2 handoff ---');
  if (!handoffSn || !handoffData) {
    console.log(`  m_objData: ${block ? 'present but sn/data missing' : 'ABSENT — page is still on the legacy route'}`);
  } else {
    // len - 1 selector - 8 key chars must be an even number of hex chars
    // forming whole 8-byte DES blocks; two upstream captures land exactly here.
    const hexLen = handoffData.length - 1 - 8;
    const blocks = hexLen / 2 / 8;
    console.log(`  m_objData: PRESENT — sn=${handoffSn.length}c, data=${handoffData.length}c`);
    dump('1_launch_data.txt', handoffData);
    console.log(`  block arithmetic: (${handoffData.length}-1-8)/2 = ${hexLen / 2} bytes = ${blocks} DES blocks ${Number.isInteger(blocks) ? '✓' : '✗ (format not as understood)'}`);
    // Presence of the handoff does not settle the route — what it decodes to
    // does. A payload with no LaunchTicket belongs on the legacy endpoint.
    try {
      const fields = decodeLaunchFields(handoffData);
      const names = Object.keys(fields);
      console.log(`  decoded fields: ${names.join(', ') || '<none>'}`);
      console.log(
        fields['LaunchTicket']
          ? '  -> v2 ROUTE (LaunchTicket present)'
          : '  -> LEGACY ROUTE (no LaunchTicket; this page hands over the legacy parameters)',
      );
    } catch (e) {
      console.log(`  decode FAILED: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log('');
  if (!longPollingKey || !unkData || !screatetime) {
    console.error('Step 1 did not yield what step 5 needs — stopping.');
    store.close();
    process.exitCode = 1;
    return;
  }

  // --- Step 2: the H2 check --------------------------------------------------
  const newloginUrl = `${TW.newloginBase}generic_handlers/get_cookies.ashx`;
  console.log('== step 2: get_cookies.ashx (tw.newlogin — the only step on this host) ==');
  console.log(`  cookies WE SEND to newlogin: ${await cookieShape(jar, newloginUrl)}`);
  const portalBefore = await cookieShape(jar, TW.portalBase);

  const s2 = await client.http.get(newloginUrl);
  const s2Body = boundedText(s2);
  dump('2_get_cookies.txt', s2Body);
  const rawSetCookie = s2.headers['set-cookie'] ?? [];
  dump('2_get_cookies.headers.txt', JSON.stringify(s2.headers, null, 2));

  console.log(`  HTTP ${s2.statusCode}, ${Buffer.byteLength(s2Body)} bytes`);
  console.log(`  Set-Cookie count: ${rawSetCookie.length}`);
  for (const raw of rawSetCookie) {
    // Name + attributes are the diagnosis; the value is the secret itself.
    const [pair, ...attrs] = raw.split(';');
    const eq = pair!.indexOf('=');
    const name = pair!.slice(0, eq);
    console.log(`    - ${name} = ${fp(pair!.slice(eq + 1))}  [${attrs.map((a) => a.trim()).join('; ')}]`);
  }

  const secretCode = extractSecretCode(s2Body);
  console.log(`  m_strSecretCode parsed: ${secretCode ? fp(secretCode) : 'MISSING'}`);
  if (!secretCode) {
    console.error('  No secret code in the body — step 5 cannot possibly match. Stopping.');
    store.close();
    process.exitCode = 1;
    return;
  }

  // The decisive question for H2: after step 2, can the PORTAL see a cookie
  // carrying this secret? If the secret only lives on the newlogin host (or
  // nowhere), step 5's portal request has nothing to be compared against.
  const portalAfter = await cookieShape(jar, TW.portalBase);
  const portalCookies = await jar.getCookies(TW.portalBase);
  const carrier = portalCookies.find((c) => c.value === secretCode);
  console.log(`  portal cookies before step 2: ${portalBefore}`);
  console.log(`  portal cookies after  step 2: ${portalAfter}`);
  // Expected to differ, and that IS the finding: this handler answers for the
  // newlogin host's session, while step 5 is validated against the portal's own
  // bfSecretCode cookie. Reading this as a fault sent a whole round of
  // investigation at the cookie jar.
  console.log(
    `  -> page value ${carrier ? 'matches' : 'differs from'} the portal's cookie` +
      `${carrier ? ` (${carrier.key})` : ' — normal; step 5 must use the COOKIE'}\n`,
  );

  // --- Steps 3 & 4 -----------------------------------------------------------
  const form: Record<string, string> = {
    service_code: sc,
    service_region: sr,
    service_account_id: account.sid,
    sotp: account.ssn,
    service_account_display_name: account.sname,
    service_account_create_time: screatetime,
  };
  form[unkData[0]] = unkData[1];
  const s3 = await client.http.post(
    `${TW.portalBase}beanfun_block/generic_handlers/record_service_start.ashx`,
    { form },
  );
  const s3Body = boundedText(s3);
  dump('3_record_service_start.txt', s3Body);
  console.log(`== step 3: record_service_start.ashx == HTTP ${s3.statusCode}, ${Buffer.byteLength(s3Body)} bytes`);
  console.log(`  body: ${redactText(s3Body.slice(0, 200)).replace(/\s+/g, ' ')}`);

  const s4 = await client.http.get(`${TW.portalBase}generic_handlers/get_result.ashx`, {
    searchParams: {
      meth: 'GetResultByLongPolling',
      key: longPollingKey,
      _: new Date().toISOString(),
    },
  });
  const s4Body = boundedText(s4);
  dump('4_get_result.txt', s4Body);
  console.log(`== step 4: get_result.ashx == HTTP ${s4.statusCode}, ${Buffer.byteLength(s4Body)} bytes`);
  console.log(`  body: ${redactText(s4Body.slice(0, 200)).replace(/\s+/g, ' ')}\n`);

  // --- Step 5, twice: once as the bot sends it, once with the live token -----
  // The legacy endpoint answers us `Secret codes do not match!` rather than the
  // `Query String Error` upstream sees, so it is reading our request rather than
  // refusing it outright — one of its inputs is simply wrong. Two are suspect:
  // the secret code (the page's differs from the portal's own cookie) and
  // `ppppp` (a page that supplies its own is not being served by a constant).
  // Sweep both instead of arguing about which.
  const CONST_PPPPP = '1F552AEAFF976018F942B13690C990F60ED01510DDF89165F1658CCE7BC21DBA';
  const createTime = screatetime.replace(/ /g, '%20');

  const blobFields = handoffData ? decodeLaunchFields(handoffData) : undefined;
  const blobPpppp = blobFields?.['ppppp'];
  /** A migrated page's legacy door is bricked whatever we send it — see below. */
  const onV2 = blobFields?.['LaunchTicket'] !== undefined;
  const cookieSecret = (await jar.getCookies(TW.portalBase)).find(
    (c) => c.key === 'bfSecretCode',
  )?.value;

  const secretSources: { label: string; value: string | undefined }[] = [
    { label: 'page m_strSecretCode', value: secretCode },
    { label: 'portal bfSecretCode cookie', value: cookieSecret },
  ];
  const pppppSources: { label: string; value: string | undefined }[] = [
    { label: 'hardcoded constant', value: CONST_PPPPP },
    { label: 'blob-supplied', value: blobPpppp },
  ];

  console.log('== step 5 sweep (legacy endpoint) ==');
  console.log(`  page secret ${fp(secretCode)} vs portal cookie ${fp(cookieSecret)} — ${
    cookieSecret === secretCode ? 'SAME' : 'DIFFERENT'
  }`);
  console.log(`  blob ppppp: ${blobPpppp ? `${blobPpppp.length} chars` : 'absent'}\n`);

  for (const s of secretSources) {
    for (const p of pppppSources) {
      if (!s.value || !p.value) continue;
      const url =
        `${TW.portalBase}beanfun_block/generic_handlers/get_webstart_otp.ashx` +
        `?SN=${longPollingKey}&WebToken=${session.webToken}&SecretCode=${s.value}&ppppp=${p.value}` +
        `&ServiceCode=${sc}&ServiceRegion=${sr}&ServiceAccount=${account.sid}` +
        `&CreateTime=${createTime}&d=${Math.trunc(Date.now()) | 0}`;
      const res = await client.http.get(url);
      const body = boundedText(res);
      dump(`5_${s.label}_${p.label}.txt`.replace(/\s+/g, '-'), body);
      const ok = body.split(';')[0] === '1';
      console.log(`  secret=${s.label.padEnd(26)} ppppp=${p.label.padEnd(18)} -> ${
        ok ? '*** OK — ENVELOPE RETURNED ***' : redactText(body.slice(0, 120)).trim()
      }`);
    }
  }

  // --- Step 5 again: does the legacy endpoint read the launcher identity? -----
  // `CV`/`Hash`/`arch` went onto the legacy GET in d446e32, alongside the secret
  // fix, on upstream's note that GGM 1.5.x appends them and the server "now
  // rejects requests that omit it". The sweep above already disproves the second
  // half — it sent none of the three and got an envelope back — but nobody has
  // asked the question the other way: is the triple ignored, required, or
  // validated when present?
  //
  // That is not idle. `clientIntegrity.ts` pins a GGM build Gamania rotates a
  // few times a year, and everyone compiling it in breaks together. If the
  // legacy endpoint validates a pair it is given, then sending one it does not
  // require puts the fallback route behind the same expiring pin as v2 — a
  // failure mode we added ourselves.
  //
  // One variable at a time: secret and `ppppp` are pinned to the combination
  // the sweep above already proved works.
  //
  // Only meaningful on a game still ON the legacy endpoint. A migrated one
  // answers `Query String Error` to everything, so all three arms refuse for a
  // reason that has nothing to do with the identity — and the reading printed
  // below would then say the opposite of the truth. Refuse to run rather than
  // produce three rows someone could read as an answer.
  if (onV2) {
    console.log('\n== step 5 launcher-identity arms — SKIPPED ==');
    console.log(
      `  ${sc}_${sr} is on v2, so its legacy door is bricked for every input and\n` +
        '  these arms could not distinguish the identity from the migration.\n' +
        '  Re-run against a legacy game (SERVICE_CODE=600309 SERVICE_REGION=A2).',
    );
  } else if (cookieSecret) {
    console.log('\n== step 5 launcher-identity arms (legacy endpoint) ==');
    const arms = [
      { label: 'omitted', suffix: '' },
      { label: 'ours (pinned pair)', suffix: `&CV=${GGM_CV}&Hash=${GGM_HASH}&arch=${GGM_ARCH}` },
      // Well-formed but certainly not a build beanfun ships, so a refusal here
      // means the values are read rather than merely tolerated.
      { label: 'deliberately wrong', suffix: `&CV=9.9.9.9&Hash=${'0'.repeat(64)}&arch=${GGM_ARCH}` },
    ];
    for (const arm of arms) {
      const url =
        `${TW.portalBase}beanfun_block/generic_handlers/get_webstart_otp.ashx` +
        `?SN=${longPollingKey}&WebToken=${session.webToken}&SecretCode=${cookieSecret}` +
        `&ppppp=${blobPpppp ?? CONST_PPPPP}` +
        `&ServiceCode=${sc}&ServiceRegion=${sr}&ServiceAccount=${account.sid}` +
        `&CreateTime=${createTime}&d=${Math.trunc(Date.now()) | 0}` +
        arm.suffix;
      const res = await client.http.get(url);
      const body = boundedText(res);
      dump(`5_identity_${arm.label}.txt`.replace(/[\s()]+/g, '-'), body);
      const ok = body.split(';')[0] === '1';
      console.log(`  identity=${arm.label.padEnd(20)} -> ${
        ok ? '*** OK — ENVELOPE RETURNED ***' : redactText(body.slice(0, 120)).trim()
      }`);
    }
    console.log(
      '  reading: all three OK -> the triple is ignored on this route, and sending\n' +
        '           it buys nothing; wrong-only refused -> validated when present, so\n' +
        '           we put the fallback behind the GGM pin ourselves; omitted refused\n' +
        '           -> the comment in otp.ts is right and the sweep above got lucky.',
    );
  }

  // --- v2: is the launcher identity validated THERE? -------------------------
  // The arms above settled the legacy GET: that endpoint does not read the
  // triple. v2 is the one that matters, and nobody has asked it the same
  // question — we ship `CV`/`Hash` there on upstream's account, and the whole
  // "the pin expires and everyone breaks together" risk rests on the assumption
  // that this endpoint validates them. That assumption has never been measured.
  //
  // It is worth measuring because every outcome is actionable, and one of them
  // deletes the risk outright:
  //   - all arms OK          -> v2 ignores the triple too. The pin is cosmetic,
  //                             `ggmVerdict()` beside a v2 refusal is pointing at
  //                             an innocent party, and there is nothing to expire.
  //   - omitted OK, wrong refused
  //                          -> validated only when present, so NOT sending it is
  //                             strictly safer than sending a pair that will age.
  //   - only ours OK         -> the gate is real. The refusal wording printed here
  //                             is then the signature we currently do not have, and
  //                             without it a future expiry is unrecognisable.
  // Splitting CV from Hash answers the follow-up in the same run: a version bump
  // alone breaks us only if CV is read on its own.
  //
  // Only meaningful on a game that HANDS OVER a ticket. A legacy page has none,
  // so every arm would be refused for a reason unrelated to the identity — the
  // same trap the legacy arms above sidestep, in the opposite direction.
  // Set by the sweep below when the pair we actually ship is confirmed good
  // right now — which is the premise the bogus-ticket sweep after it needs.
  let pinnedPairGoodNow: boolean | null = null;
  if (!onV2) {
    console.log('\n== v2 launcher-identity arms — SKIPPED ==');
    console.log(
      `  ${sc}_${sr} hands over no LaunchTicket, so get_webstart_otp_v2.ashx has\n` +
        '  nothing to trade and would refuse every arm for an unrelated reason.\n' +
        '  Re-run against a v2 game (SERVICE_CODE=610074 SERVICE_REGION=T9).',
    );
  } else {
    console.log('\n== v2 launcher-identity arms (get_webstart_otp_v2.ashx) ==');
    const WRONG_CV = '9.9.9.9';
    const WRONG_HASH = '0'.repeat(64);
    const v2Arms: { label: string; cv?: string; hash?: string }[] = [
      { label: 'ours (pinned pair)', cv: GGM_CV, hash: GGM_HASH },
      { label: 'omitted entirely' },
      { label: 'both wrong', cv: WRONG_CV, hash: WRONG_HASH },
      { label: 'wrong CV, our Hash', cv: WRONG_CV, hash: GGM_HASH },
      { label: 'our CV, wrong Hash', cv: GGM_CV, hash: WRONG_HASH },
    ];

    // A ticket may well be single-use. Re-fetching step 1 per arm makes every
    // arm's ticket fresh, so a later refusal cannot be a spent ticket wearing
    // the identity's clothes — and fingerprinting them makes that visible
    // instead of assumed: if the tags repeat, the pages are handing out the
    // same ticket and replay is back on the table as an explanation.
    const ticketTags: string[] = [];
    const armOk: boolean[] = [];
    for (const arm of v2Arms) {
      const fresh = await client.http.get(
        `${TW.portalBase}beanfun_block/game_zone/game_start_step2.aspx`,
        { searchParams: { service_code: sc, service_region: sr, sotp: account.ssn, dt: String(Date.now()) } },
      );
      const handoff = extractLaunchHandoff(boundedText(fresh));
      if (!handoff) {
        console.log(`  identity=${arm.label.padEnd(20)} -> SKIPPED (step 1 returned no handoff this time)`);
        armOk.push(false);
        continue;
      }
      let ticket: string;
      try {
        ticket = decodeLaunchTicket(handoff.data);
      } catch (e) {
        console.log(`  identity=${arm.label.padEnd(20)} -> SKIPPED (ticket would not decode: ${
          e instanceof Error ? e.message : String(e)
        })`);
        armOk.push(false);
        continue;
      }
      ticketTags.push(fp(ticket));

      const payload: Record<string, string> = { SN: handoff.sn, LaunchTicket: ticket };
      if (arm.cv !== undefined) payload['CV'] = arm.cv;
      if (arm.hash !== undefined) payload['Hash'] = arm.hash;
      if (arm.cv !== undefined || arm.hash !== undefined) payload['arch'] = GGM_ARCH;

      const res = await client.http.post(
        `${TW.portalBase}beanfun_block/generic_handlers/get_webstart_otp_v2.ashx`,
        // The page that produced THIS ticket, which is what the shipped path sends.
        { headers: { referer: fresh.url }, json: payload },
      );
      const body = boundedText(res);
      dump(`5_v2_identity_${arm.label}.txt`.replace(/[\s(),]+/g, '-'), body);

      // Report the shape, not the OTP. `result` is the server's own verdict; a
      // body that is not JSON at all is itself a finding, so say that rather
      // than letting a parse error surface as a probe crash.
      let ok = false;
      let note: string;
      try {
        const parsed = JSON.parse(body) as { result?: number; data?: string | null; message?: string | null };
        ok = parsed.result === 1;
        note = ok
          ? `*** OK — data ${parsed.data?.length ?? 0}c ***`
          : `result=${String(parsed.result)} message=${redactText(String(parsed.message ?? '')).slice(0, 90)}`;
      } catch {
        note = `NON-JSON (HTTP ${res.statusCode}): ${redactText(body.slice(0, 90)).replace(/\s+/g, ' ')}`;
      }
      armOk.push(ok);
      console.log(`  identity=${arm.label.padEnd(20)} ticket=${fp(ticket)} -> ${note}`);
    }

    const distinctTickets = new Set(ticketTags).size;
    console.log(
      `  tickets: ${ticketTags.length} fetched, ${distinctTickets} distinct` +
        (distinctTickets === ticketTags.length
          ? ' — each arm had a fresh one, so replay cannot explain a refusal'
          : ' — REPEATED: a refusal below may be a spent ticket, not the identity'),
    );

    // Refuse to interpret when the control failed. If the pair we actually ship
    // cannot get an OTP right now, every other arm is measuring that outage
    // instead of the identity, and a reading printed here would be worse than
    // none — the failure mode the legacy arms were rewritten to avoid.
    pinnedPairGoodNow = armOk[0] === true;
    if (armOk[0] !== true) {
      console.log(
        '  reading: WITHHELD — the baseline arm (our pinned pair) did not succeed,\n' +
          '           so nothing below it isolates the launcher identity. Fix or\n' +
          '           explain the baseline first, then re-run.',
      );
    } else {
      const allOk = armOk.every((v) => v);
      const omittedOk = armOk[1] === true;
      const anyWrongOk = armOk[2] === true || armOk[3] === true || armOk[4] === true;
      console.log(
        `  reading: ${
          allOk
            ? 'ALL arms accepted -> v2 does NOT read the triple either. The pin cannot\n' +
              '           expire, and ggmVerdict() beside a v2 refusal is accusing the wrong thing.'
            : !anyWrongOk && omittedOk
              ? 'wrong pairs refused, omitting accepted -> validated only when present.\n' +
                '           Sending nothing is then strictly safer than sending a pair that ages.'
              : !anyWrongOk && !omittedOk
                ? 'only our pair accepted -> the gate is real and required. The refusal\n' +
                  '           text above is the signature to key an error message off.'
                : 'mixed -> read the rows: whichever field a wrong value survives is\n' +
                  '           the one beanfun does not check.'
        }`,
      );
    }
  }

  // --- Can the pin be checked WITHOUT a ticket, or a session at all? ---------
  // The sweep above proved the gate is real, which means the pin will one day
  // stop being accepted and every user breaks together. Detecting that is the
  // open problem: it is only observable by sending a v2 request, and a
  // deployment whose users all sit on legacy games sends none — possibly for
  // months, since the game a user picked is persisted and survives restarts.
  //
  // But every arm above carried a VALID ticket and still failed on integrity,
  // so integrity is at least decided independently of what the ticket is worth.
  // If it is also decided BEFORE the ticket is looked at, then a request
  // carrying a deliberately worthless ticket still exercises the gate — and
  // that would be a canary needing no real ticket, generating no OTP, and
  // costing a user nothing.
  //
  // 2x2, because both halves have to hold for that to be true:
  //   identity  ours vs wrong   — does the answer still distinguish them?
  //   cookies   session vs none — is a login needed to reach the gate at all?
  //
  // The SN and ticket are random but WELL-FORMED (36-char GUID, 64 hex chars).
  // Sending obvious garbage risks a shape rejection that would look like an
  // answer to the ordering question without being one.
  console.log('\n== v2 with a worthless ticket: is the gate reachable without one? ==');
  {
    const WRONG_CV = '9.9.9.9';
    const WRONG_HASH = '0'.repeat(64);
    const bogusSn = randomUUID();
    const bogusTicket = randomBytes(32).toString('hex');
    // A jar of its own, so nothing this client does can touch the real session's
    // cookies — and so "no cookies" really means none, not merely unsent.
    const anonClient = new BeanfunClient({ jar: new CookieJar() });

    const bogusArms = [
      { label: 'ours + session', cv: GGM_CV, hash: GGM_HASH, anon: false },
      { label: 'wrong + session', cv: WRONG_CV, hash: WRONG_HASH, anon: false },
      { label: 'ours + no cookies', cv: GGM_CV, hash: GGM_HASH, anon: true },
      { label: 'wrong + no cookies', cv: WRONG_CV, hash: WRONG_HASH, anon: true },
    ];

    /** `Client_Integrity_Failed` or not — the only distinction that matters here. */
    const integrityFailed: (boolean | null)[] = [];
    for (const arm of bogusArms) {
      const res = await (arm.anon ? anonClient : client).http.post(
        `${TW.portalBase}beanfun_block/generic_handlers/get_webstart_otp_v2.ashx`,
        {
          headers: { referer: s1.url },
          json: { SN: bogusSn, LaunchTicket: bogusTicket, CV: arm.cv, Hash: arm.hash, arch: GGM_ARCH },
        },
      );
      const body = boundedText(res);
      dump(`5_v2_bogus_${arm.label}.txt`.replace(/[\s+]+/g, '-'), body);
      let note: string;
      let flagged: boolean | null = null;
      try {
        const parsed = JSON.parse(body) as { result?: number; message?: string | null };
        const message = String(parsed.message ?? '');
        flagged = /Client_Integrity_Failed/i.test(message);
        note = `result=${String(parsed.result)} message=${redactText(message).slice(0, 90)}`;
      } catch {
        note = `NON-JSON (HTTP ${res.statusCode}): ${redactText(body.slice(0, 90)).replace(/\s+/g, ' ')}`;
      }
      integrityFailed.push(flagged);
      console.log(`  ${arm.label.padEnd(20)} -> ${note}`);
    }

    // Interpreting any of this assumes the pair we ship is good RIGHT NOW. If
    // that was never established (legacy game, or the baseline arm failed),
    // `ours` refusing here says nothing about ordering — it could simply be a
    // pin that has already expired, which is the very thing we are building a
    // detector for.
    if (pinnedPairGoodNow !== true) {
      console.log(
        '  reading: WITHHELD — this run never confirmed the shipped pair is currently\n' +
          '           accepted, so a refusal here cannot be told apart from an expired pin.\n' +
          '           Re-run on a v2 game (SERVICE_CODE=610074 SERVICE_REGION=T9).',
      );
    } else {
      const [oursSession, wrongSession, oursAnon, wrongAnon] = integrityFailed;
      const sessionDistinguishes = oursSession === false && wrongSession === true;
      const anonDistinguishes = oursAnon === false && wrongAnon === true;
      if (sessionDistinguishes && anonDistinguishes) {
        console.log(
          '  reading: CANARY VIABLE, CREDENTIAL-FREE — the gate answers before the ticket\n' +
            '           and without a login. A scheduled POST with a worthless ticket can ask\n' +
            '           "is our pair still accepted?" without any user, session, or OTP.',
        );
      } else if (sessionDistinguishes) {
        console.log(
          '  reading: CANARY VIABLE, NEEDS A SESSION — the gate answers before the ticket,\n' +
            '           but not to an anonymous caller. Usable from a live session without\n' +
            '           burning a real ticket or generating an OTP.',
        );
      } else if (oursSession === true) {
        console.log(
          '  reading: NOT USABLE — a known-good pair is reported as Client_Integrity_Failed\n' +
            '           once the ticket is worthless, so that message is a catch-all here and\n' +
            '           cannot signal an expired pin. Detection has to stay on real traffic.',
        );
      } else {
        console.log(
          '  reading: INCONCLUSIVE — read the rows. The arms did not split the way either\n' +
            '           hypothesis predicts; whatever distinguishes them is the next question.',
        );
      }
    }
  }

  // The shipped code path, end to end. The one assumption the v2 port inherits
  // from upstream is that the reply's `data` is the same {8-char key}{cipher
  // hex} envelope the pre-v2 protocol used — never confirmed against a live
  // server. If it is wrong the symptom is a decrypt failure or mojibake here,
  // which is why this prints the shape of the result.
  console.log('\n== real getOtp() — the shipped v2 path ==');
  try {
    const otp = await getOtp(client, probeSession, account, sc, sr);
    const printable = /^[\x20-\x7e]+$/.test(otp);
    console.log(`  OK — decrypted ${otp.length} characters, ${printable ? 'all printable ASCII ✓' : 'NOT printable ASCII ✗ (decrypt assumption wrong)'}`);
    console.log('  (value withheld — request it through the bot to verify it actually logs in)');
  } catch (e) {
    console.log(`  FAILED: ${e instanceof Error ? redactText(e.message) : String(e)}`);
  }

  store.close();
  console.log(
    outDir
      ? `\n[probe] raw bodies written to ${outDir}/ — GITIGNORED, they contain the secret code.`
      : '\n[probe] no files written (pass --write to dump raw bodies).',
  );
}

main().catch((err: unknown) => {
  console.error('[probe] failed:', err instanceof Error ? redactText(err.message) : err);
  process.exitCode = 1;
});
