# BeanyCord

A Discord bot that ports the Beanfun **QR-login → OTP** path to Node.js/
TypeScript, running on a 24/7 Linux host so the OTP flow no longer depends on
an offline Windows machine. DM the bot, scan a QR, pick a game + account, and
get your game OTP back — all in your DMs.

Re-implements the same protocol (URLs, headers, regexes, and the WCDES
(DES-ECB) OTP decryption) as the existing community clients — see
[Attribution](#attribution) for the MIT-licensed lineage.

## ⚠️ Disclaimer & intended use

- **Not official, not affiliated.** BeanyCord is **not** developed, endorsed by,
  or affiliated with 遊戲橘子 (Gamania) or Beanfun. "Beanfun" and game names are
  trademarks of their respective owners.
- **Unofficial third-party access.** It automates a login/OTP flow against
  Beanfun and therefore likely **violates Beanfun's Terms of Service**. Using it
  may put your account at risk (suspension, risk-control blocks). **Use at your
  own risk.**
- **Educational / personal self-hosting only.** This repository is published for
  learning and for individuals to **self-host for their own account**. It is not
  intended to be run as a public/shared service, and the authors do not operate
  a hosted instance.
- **No warranty.** Provided "AS IS" under the MIT License (see `LICENSE`).

> This disclaimer documents intent and is **not** a legal shield. You are
> responsible for your own use and for complying with all applicable terms and
> laws in your jurisdiction.

## Attribution

BeanyCord is a derivative work whose Beanfun protocol logic descends from the
**MIT-licensed** original C#/WPF client by **Kai Hao**
([`kevin940726/BeanfunLogin`](https://github.com/kevin940726/BeanfunLogin), MIT,
© 2015), and was cross-checked against the Rust/Tauri re-implementation
[`pungin/Beanfun`](https://github.com/pungin/Beanfun). The full lineage and the
required upstream MIT notice are in
[`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md). This project itself is
MIT-licensed (`LICENSE`).

## Scope (M0)

QR login → list games → list accounts → print OTP. Single user, no persistence,
no Discord. The goal is to validate three high-risk unknowns in one run:

1. **WCDES** decryption fidelity (unit-tested against the Rust fixtures).
2. The **QR 3-step** state machine against the live server.
3. Whether **this host's outbound IP** is accepted by Beanfun TW risk control
   (overseas datacenter IPs may be blocked — if so, set `BEANFUN_PROXY`).

## Setup

```sh
npm install
cp .env.example .env   # optional: set BEANFUN_PROXY / BEANFUN_DEBUG
npm test               # WCDES + time + parser parity tests (offline)
npm run typecheck
```

> **DES note:** OTP decryption uses single-DES (`des-ecb`), a legacy cipher
> OpenSSL 3 disables by default. The npm scripts already set
> `NODE_OPTIONS=--openssl-legacy-provider`. When you run the app any other way
> (systemd/pm2/Docker), set that env var too, or OTP decrypt throws
> `wcdes.legacy_provider_required`.

## Run the M0 flow (hits the real Beanfun server)

```sh
npm run m0
```

It saves the QR code to `qr.png` — scan it with the Beanfun mobile app, then
follow the prompts to pick a game and account. On success it prints the OTP.

## Layout

```
src/beanfun/
  client.ts      # got + tough-cookie jar; redirect / no-redirect variants; proxy
  endpoints.ts   # TW hosts + MapleStory defaults
  types.ts       # Session, ServiceAccount, GameService, ...
  wcdes.ts       # DES-ECB/NoPadding (OTP decrypt)
  time.ts        # dt cache-buster formatters (0-indexed month quirk)
  parser.ts      # all HTML/URL regexes (token, hidden inputs, rows, INI, ...)
  login/         # sessionKey, qrInit, qrPoll, qrFinalize
  games.ts       # listGames
  account.ts     # getAccounts
  otp.ts         # 5-step OTP + decrypt
src/m0.ts        # the CLI driver
test/            # offline parity tests
```

## Notes / gotchas (kept 1:1 with the Rust reference)

- QR poll **must** send an empty body with `Content-Length: 0` (else HTTP 411).
- `return.aspx` runs twice: a no-redirect Set-Cookie scrape (discarded, may be
  absent) then a redirect-following POST whose `bfWebToken` is read from the jar.
- OTP step-5 URL is hand-built: screatetime spaces → `%20`, `ppppp` verbatim.
- `dtCompact` month is **0-indexed and not zero-padded**.
- `bfWebToken` is read scoped to `tw.beanfun.com`.

## Discord bot (M1/M2)

One Beanfun account per Discord user, full happy path entirely in DMs:
`/login` → QR embed → background poll → game menu → account menu → OTP.

**M2 adds:** sessions are encrypted (AES-256-GCM) and persisted to SQLite, so a
restart/redeploy resumes everyone without re-scanning a QR. A 60s keep-alive
ping (mirrors the WPF `pingWorker`) keeps each logged-in session warm server-side.
Set `SESSION_ENCRYPTION_KEY` (`openssl rand -hex 32`) to enable persistence;
leave it blank to run memory-only.

### One-time Discord setup

1. https://discord.com/developers/applications → **New Application**.
2. **Bot** tab → **Reset Token** → copy the token → `DISCORD_TOKEN` in `.env`.
   (No privileged intents needed — leave them off.)
3. **General Information** → copy **Application ID** → `DISCORD_CLIENT_ID`.
4. **Install** (or OAuth2 → URL Generator): scope `bot` + `applications.commands`,
   invite the bot to a server you share with your friends.

### Using the commands in DMs

Slash commands only show up in a DM when they are registered **globally** —
**guild-scoped commands never appear in DMs.** So:

- Leave **`DISCORD_GUILD_ID` blank** (global registration). The first global
  registration can take up to ~1h to propagate.
- The commands declare the `BotDM` context, so once global they appear when you
  DM the bot (you must share a server with it, which the invite above gives you).

Optional — **User Install** (use `/login` in any DM without sharing a server):

1. Developer Portal → **Installation** → enable **User Install** under
   *Installation Contexts*; under *Default Install Settings → User Install* add
   the `applications.commands` scope.
2. Set `DISCORD_USER_INSTALL=1` in `.env` and re-run `npm run register`.
3. Open the portal **Install Link** to add the app to your own account.

### Run

```sh
npm run register   # publish /login /logout /status (after editing commands.ts OR changing the flags above)
npm run bot        # start the bot
```

Then DM the bot and run `/login`. The QR and OTP are delivered in your DM.

## Security model & hardening

The bot delivers Beanfun game OTPs, so the two things to protect are **other
people's persisted sessions** and **other people's OTPs**.

**What's already enforced in code:**

- **Per-user isolation by Discord identity.** Every action is keyed to the
  Discord-authenticated `interaction.user.id`; the `sid` carried in a button is
  only ever resolved against *that same user's* own session. Forging a button
  with someone else's `sid` cannot yield their OTP.
- **DM-only delivery.** QR codes and OTPs are only ever sent to a 1:1 DM. A
  `/login` from a guild — or a group DM (user-install) — redirects to the user's
  1:1 DM rather than posting the QR where others can read it.
- **Encryption at rest.** Sessions are AES-256-GCM encrypted in SQLite; the GCM
  auth tag means a tampered/foreign-key blob is dropped, not used.
- **Log redaction.** Secret URL params and error text pass through `core/redact`;
  cookie values, `webToken`, and OTP plaintext are never logged.

**What you must configure on the host:**

- **Access gate.** The gate only stops strangers using your host/IP to run their
  own logins (each user only ever sees their own OTP). It's DM-first — it does
  **not** force a shared server. A user is authorized if any of these holds:
  - **`ACCESS_CODE`** (recommended): a shared invite code. A new friend runs
    `/login code:<碼>` **once**; the bot enrolls their Discord ID (persisted in
    the DB) and they never re-enter it. Adding a friend = handing them the code
    once — no `.env` edit, no restart, no server to join. (Enrollment persists
    only when `SESSION_ENCRYPTION_KEY` is set; otherwise it's in-memory.)
  - **`REQUIRED_GUILD_ID`** (optional): members of that server auto-pass — for
    users who do share a server. Uses a single by-ID member fetch (no privileged
    Members intent; the bot just has to be in that server).
  - **`ALLOWED_DISCORD_IDS`** (optional): a static allow set.

  Leaving all three blank opens the bot to anyone who can reach it.
- **File permissions.** The encryption key lives in `.env` on the *same host* as
  the DB, so at-rest encryption only protects the DB if it leaks **alone** — it
  does **not** protect against host compromise. The store now creates `data/`
  `0700` and the DB files `0600`; also `chmod 600 .env`, keep both owned by one
  user, and never back `.env` up together with the DB.
- **`SESSION_MAX_AGE_DAYS`** (default 30) — sessions not refreshed within this
  window are purged on load, capping how long a leaked DB stays useful.
- **Protect `DISCORD_TOKEN`.** It controls the bot identity (though not the
  session-encryption key).

OTP messages and their "重新產生 OTP" button persist in the user's DM history, so
a compromised *Discord account* can replay them while the session is alive — the
message carries a reminder to delete it when done.

## Deploy to Fly.io

The bot is a long-running **worker** (outbound Discord gateway + Beanfun HTTP
only — no inbound port). It runs as a **single machine** with a Fly **volume**
for the encrypted SQLite DB. Files: `Dockerfile`, `.dockerignore`, `fly.toml`.

```sh
# 0) one-time
brew install flyctl && fly auth login
npm run build              # sanity-check the TS compiles to dist/

# 1) create the app + a volume for the DB (name must be globally unique)
fly apps create beanycord          # if taken, pick another and edit `app` in fly.toml
fly volumes create beanycord_data --region nrt --size 1

# 2) secrets (NEVER put these in fly.toml — it's committed)
fly secrets set \
  DISCORD_TOKEN=xxxxx \
  SESSION_ENCRYPTION_KEY=$(openssl rand -hex 32) \
  ACCESS_CODE=your-shared-invite-code
#   optional: BEANFUN_PROXY=http://user:pass@tw-proxy:8080
#   optional non-secret access knobs can go in fly.toml [env] instead:
#   REQUIRED_GUILD_ID / ALLOWED_DISCORD_IDS

# 3) ship it
fly deploy
fly logs                    # watch for "🤖 logged in as ..."
fly scale count 1           # make sure it stays single-instance
```

**Register the slash commands once** (and after any `commands.ts` change). This
is a control-plane action — easiest from your laptop with a local `.env`
containing `DISCORD_TOKEN` + `DISCORD_CLIENT_ID`:

```sh
npm run register            # global registration; first time can take ~1h to appear
```

### Critical deploy notes

- **Keep it single-instance.** Discord allows one gateway connection per token,
  one volume attaches to one machine, and session state is in-memory. Never
  `fly scale count > 1` or enable autoscaling. The volume forces
  `deploy.strategy = "immediate"` (recreate in place) so two machines never run.
- **`SESSION_ENCRYPTION_KEY` must stay stable.** Lose/rotate it and every stored
  session becomes undecryptable (silently dropped) — everyone re-scans a QR.
  Store it only in `fly secrets`; back it up somewhere safe.
- **Beanfun risk control on Fly's IP is unvalidated.** The original overseas host
  was accepted, but Fly's Tokyo (`nrt`) datacenter IP is a *different* IP and TW
  risk control may treat it differently. If logins start failing from Fly, set
  `BEANFUN_PROXY` to a Taiwan proxy (config-only — the client already supports
  it) and redeploy. Picking `nrt`/`sin` (Asia-Pacific) over a US region helps
  latency and may help acceptance.
- **DES legacy provider** is baked into the image (`NODE_OPTIONS` in the
  Dockerfile), so OTP decrypt works without extra setup.
- **`fly ssh console`** lets you inspect `/data/beanycord.sqlite` if needed; the
  volume persists across deploys but a `fly volumes destroy` wipes all sessions.

## Roadmap

- **M0** ✅ protocol-validation CLI (done, validated live).
- **M1** ✅ single-user Discord DM bot, in-memory (done, validated live).
- **M2** ✅ encrypted session persistence (survives restart) + 60s keep-alive
  ping + per-user lock.
- **M3** ← *here*: hardening — QR retry button, one-tap re-login on expiry,
  secret redaction in logs/errors, logout.
