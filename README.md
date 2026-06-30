<p align="center">
  <img src="avatar.jpg" alt="BeanyCord mascot" width="200">
</p>

<h1 align="center">BeanyCord</h1>

<p align="center">
  <em>A Discord bot that reverse-engineers a Windows game launcher's QR-login / OTP
  protocol and re-implements it as a 24/7 TypeScript service.</em>
</p>

<p align="center">
  <a href="./README.zh-TW.md">繁體中文</a> · English
</p>

---

> **What this is, in one line:** Beanfun (now "Gama Play") game OTPs are normally
> only obtainable from a Windows desktop client. BeanyCord ports that proprietary
> auth/OTP protocol to Node.js so the flow — QR login → pick game → pick account →
> one-time password — runs as a long-lived Linux service and answers in your
> Discord DMs.

This README is written for engineers reading the code. **If you actually want to
run or use the bot, read the Traditional Chinese guide —
[`README.zh-TW.md`](./README.zh-TW.md)** — which has the full setup, the Discord
app configuration, the command walkthrough, and the deployment steps. (The users
are Taiwanese, so that guide is the operational source of truth; this page is the
engineering overview.)

## Why it's interesting

Most of the work here is not "wire up a Discord bot." It's three harder problems:

1. **Protocol reverse-engineering.** The Beanfun login/OTP flow only existed as a
   C#/WPF desktop client (and a Rust/Tauri port). There is no API. Reproducing it
   meant reading the reference implementations, mapping an undocumented sequence
   of `.aspx`/`.ashx` calls, and matching their exact quirks byte-for-byte.
2. **Legacy cryptography.** The OTP envelope is encrypted with **single-DES in
   ECB mode with no padding** — a cipher OpenSSL 3 / Node 18+ disable by default.
   Getting a correct, test-verified decryption out of a modern runtime is a real
   constraint, not a footnote.
3. **A credential-bearing multi-tenant service.** The moment a one-machine desktop
   tool becomes a hosted bot, you inherit a threat model: per-user isolation,
   secrets at rest, access control, and leak-blast-radius all have to be designed,
   not assumed.

## Architecture

Three layers, deliberately decoupled so the protocol core never imports Discord:

```
src/
├── beanfun/        Protocol core — pure HTTP + crypto, no Discord, no Node-only deps
│   ├── client.ts       per-user HTTP client: one cookie jar shared by two got
│   │                   instances (redirect / no-redirect), bounded response bodies
│   ├── login/          QR login state machine: init → poll → finalize → session key
│   ├── otp.ts          5-step OTP retrieval pipeline + WCDES decrypt
│   ├── wcdes.ts        DES-ECB-NoPadding, byte-compatible with the WPF/Rust reference
│   ├── games.ts        service catalog
│   ├── account.ts      service-account listing
│   └── parser.ts       HTML/JSON scraping that mirrors WPF parsing exactly
│
├── core/           Transport-agnostic state & persistence (no discord.js)
│   ├── sessionManager.ts   per-user state, async mutex, 60s keep-alive ping
│   ├── store.ts            AES-256-GCM encrypted SQLite session store
│   └── redact.ts           secret redaction for logs
│
└── discord/        The only layer that knows about Discord
    ├── bot.ts          client wiring, interaction dispatch, access control
    ├── flow.ts         the interaction flow (QR → menus → OTP, single control surface)
    ├── commands.ts     slash command defs (global, DM-capable, user-installable)
    └── presence.ts     status rotation
```

The `core/` ↔ `discord/` split is intentional: `core/` has no `discord.js`
dependency, so the session/lifecycle logic could be driven by a different
front-end (CLI, web, another chat platform) without change. `npm run m0` exercises
the entire protocol core from the command line, with Discord never loaded.

## Security design / threat model

The bot hands out live OTPs for other people's game accounts, so the security
model is the point, not an afterthought.

**Per-user isolation.** Every Discord user gets their own `BeanfunClient` with its
own cookie jar. All state is keyed by the Discord-authenticated `interaction.user.id`.
There is no code path where supplying someone else's account id (`sid`) yields their
OTP — cross-user theft is structurally impossible, not merely access-checked.

**Secrets at rest.** Sessions (cookie jar + handle, which include the Beanfun web
token) are persisted **AES-256-GCM** encrypted in SQLite, layout
`iv(12) ‖ authTag(16) ‖ ciphertext`, under a 32-byte key from
`SESSION_ENCRYPTION_KEY`. No key → the store disables itself and runs memory-only
rather than writing plaintext. DB + WAL/SHM files are `chmod 600`, the dir `700`.
This is honestly scoped: the key lives on the same host, so encryption protects a
**DB-alone leak**, not a full host compromise — and the README says so.

**Bounded blast radius.** `SESSION_MAX_AGE_DAYS` (default 30) purges stale sessions
on load, so a leaked DB can't yield indefinitely-live credentials. Logs are run
through a redactor. OTPs and QR codes are sent **only** in 1:1 DMs, never a channel.

**Access gating without forcing a shared server.** The gate exists only to stop
strangers using *this host/IP* to run their own logins. It's DM-first by design: a
shared `ACCESS_CODE` is redeemed once via `/login code:<code>`, after which the
user's id is **enrolled** (persisted) so they never re-enter it. Adding a friend is
"hand them the code once" — no config edit, no restart, no mandatory guild
membership. The code is compared in **constant time** (`crypto.timingSafeEqual`) to
avoid leaking its length/prefix by timing. Optional `REQUIRED_GUILD_ID` and
`ALLOWED_DISCORD_IDS` gates exist for other deployment shapes.

## Engineering details worth calling out

- **Async mutex per user.** Rapid button/menu clicks could race the same session
  mid-mutation. A minimal FIFO `Mutex` serialises each user's actions (mirrors the
  Rust backend's single-slot guard) while keeping different users fully parallel.
- **Single active control surface.** The DM flow guarantees exactly one "currently
  actionable" message: each step retires the previous menu (and strips spent
  buttons), tracked by message id so an in-place edit isn't mistaken for a new
  surface. This came directly from a real bug — component follow-ups render as
  *replies* to a message the next step deletes, producing "original message
  deleted." Fixed by sending plain DMs instead of interaction follow-ups.
- **Byte-exact legacy crypto.** `wcdes.ts` uses Node's `des-ecb` with
  `setAutoPadding(false)` because it's byte-equal to .NET `DES + ECB +
  PaddingMode.None`, validated against fixtures generated from the reference port.
  A pure-JS DES was rejected — it only does PKCS padding, not NoPadding.
- **Faithful protocol quirks.** The OTP step-5 URL is hand-built rather than passed
  through a query builder, because the server expects spaces as `%20` (not `+`) and
  a fixed 64-hex protocol constant left verbatim. Small infidelities here just fail.
- **Crash-safe persistence.** A single corrupt/undecryptable session row is logged
  and dropped on load, never fatal — one bad blob can't block startup.

## Tech stack

TypeScript (ESM, Node ≥20) · discord.js v14 · got + tough-cookie · better-sqlite3 ·
Node `crypto` (AES-256-GCM, legacy DES) · vitest · deployed as a single-instance
Fly.io worker with a volume-mounted encrypted DB.

## Running it

See [`README.zh-TW.md`](./README.zh-TW.md) for full setup. The short version:

```sh
npm install
cp .env.example .env        # DISCORD_TOKEN, SESSION_ENCRYPTION_KEY, ACCESS_CODE, …
npm test                    # offline parity tests
npm run register            # publish slash commands (once)
npm run bot                 # start (sets NODE_OPTIONS=--openssl-legacy-provider)
```

`npm run m0` runs the whole protocol core — QR login → game → account → OTP —
against the live host **without Discord**, the fastest way to confirm the protocol
still works after a host/IP change.

## License & attribution

MIT (see [`LICENSE`](./LICENSE)). This is a derivative work: the Beanfun protocol
logic descends from **Kai Hao**'s MIT-licensed C#/WPF client
([`kevin940726/BeanfunLogin`](https://github.com/kevin940726/BeanfunLogin), © 2015),
cross-referenced with [`pungin/Beanfun`](https://github.com/pungin/Beanfun). The full
derivation chain and upstream MIT notices are in
[`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md).

## Disclaimer

Not affiliated with, endorsed by, or connected to Gamania / Beanfun. It automates an
unofficial third-party login/OTP flow and therefore **very likely violates Beanfun's
Terms of Service**; using it may put your account at risk. Built as a
**reverse-engineering and security-engineering exercise** for personal,
self-hosted use only — there is no hosted instance, and this is not a service.
Provided "as is" under MIT, with no warranty. Use at your own risk.
