/**
 * M0 — protocol-validation CLI. NO Discord yet.
 *
 * Drives the full chain against the REAL Beanfun server:
 *   QR login -> select game -> select account -> print OTP.
 *
 * Success here validates the three highest-risk unknowns in one run:
 * WCDES decrypt fidelity, the QR 3-step state machine, and whether this
 * host's outbound IP is accepted by Beanfun TW risk control.
 *
 * Run: `npm run m0`
 */
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import 'dotenv/config';

import { getAccounts } from './beanfun/account.js';
import { BeanfunClient } from './beanfun/client.js';
import { listGames } from './beanfun/games.js';
import { finalizeQrLogin } from './beanfun/login/qrFinalize.js';
import { initQrLogin } from './beanfun/login/qrInit.js';
import { pollQrLogin } from './beanfun/login/qrPoll.js';
import { getSessionKey } from './beanfun/login/sessionKey.js';
import { getOtp } from './beanfun/otp.js';
import type { Session } from './beanfun/types.js';

const QR_POLL_INTERVAL_MS = 2_000;
const QR_MAX_WAIT_MS = 150_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function pickIndex(label: string, count: number): Promise<number> {
  for (;;) {
    const ans = await prompt(`\n選擇${label} (1-${count}): `);
    const n = Number(ans);
    if (Number.isInteger(n) && n >= 1 && n <= count) return n - 1;
    console.log('輸入無效,請再試一次。');
  }
}

async function main(): Promise<void> {
  const client = new BeanfunClient();
  if (process.env.BEANFUN_PROXY) console.log(`[proxy] 經由 ${process.env.BEANFUN_PROXY}`);

  // 1) QR login
  console.log('\n=== 步驟 1/4：QR 登入 ===');
  const skey = await getSessionKey(client);
  const qr = await initQrLogin(client, skey);

  const b64 = qr.bitmapBase64.replace(/^data:image\/png;base64,/, '');
  writeFileSync('qr.png', Buffer.from(b64, 'base64'));
  console.log('已將 QR 圖存成 qr.png — 用 Beanfun App 掃描它。');
  if (qr.deeplink) console.log(`(或開啟 deeplink) ${qr.deeplink}`);
  console.log('等待掃描核准中...');

  const session = await waitForQrApproval(client, qr);
  console.log('✅ 登入成功。');

  // 2) select game
  console.log('\n=== 步驟 2/4：選擇遊戲 ===');
  const games = await listGames(client);
  games.services.forEach((g, i) =>
    console.log(`  ${i + 1}. ${g.name}  [${g.serviceCode}_${g.serviceRegion}]`),
  );
  const game = games.services[await pickIndex('遊戲', games.services.length)]!;
  session.serviceCode = game.serviceCode;
  session.serviceRegion = game.serviceRegion;

  // 3) select account
  console.log('\n=== 步驟 3/4：選擇帳號 ===');
  const { accounts, amountLimitNotice } = await getAccounts(
    client,
    session,
    session.serviceCode,
    session.serviceRegion,
  );
  if (amountLimitNotice.kind !== 'none') console.log(`(額度通知) ${JSON.stringify(amountLimitNotice)}`);
  if (accounts.length === 0) {
    console.log('此遊戲沒有任何服務帳號(或 cookie 失效)。');
    return;
  }
  accounts.forEach((a, i) =>
    console.log(`  ${i + 1}. ${a.sname}  (sid=${a.sid}, ssn=${a.ssn})`),
  );
  const account = accounts[await pickIndex('帳號', accounts.length)]!;

  // 4) OTP
  console.log('\n=== 步驟 4/4：取得 OTP ===');
  const otp = await getOtp(client, session, account, session.serviceCode, session.serviceRegion);
  console.log(`\n🔑 OTP: ${otp}\n`);
  console.log('M0 成功 — 協定鏈、WCDES、與此主機 IP 全部通過驗證。');
}

async function waitForQrApproval(
  client: BeanfunClient,
  qr: Awaited<ReturnType<typeof initQrLogin>>,
): Promise<Session> {
  const deadline = Date.now() + QR_MAX_WAIT_MS;
  for (;;) {
    if (Date.now() > deadline) throw new Error('QR 等待逾時(150 秒)。');
    const outcome = await pollQrLogin(client, qr);
    if (outcome === 'Approved') return finalizeQrLogin(client, qr);
    if (outcome === 'TokenExpired') throw new Error('QR 已過期,請重跑 M0。');
    // WaitLogin / Failed -> keep polling
    await sleep(QR_POLL_INTERVAL_MS);
  }
}

main().catch((err: unknown) => {
  console.error('\n❌ M0 失敗:', err instanceof Error ? `${err.message}` : err);
  process.exitCode = 1;
});
