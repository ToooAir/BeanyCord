/**
 * Encrypted, on-disk persistence for per-Discord-user Beanfun sessions (M2).
 *
 * Why: the bot must survive a restart/redeploy without forcing every friend to
 * re-scan a QR. We persist just enough to resume — the `Session` handle plus the
 * serialized cookie jar (which holds `bfWebToken` and friends). Accounts/game
 * menus are NOT persisted; they're cheap to re-fetch.
 *
 * Secrets at rest: the blob is AES-256-GCM encrypted under a key from
 * `SESSION_ENCRYPTION_KEY` (32 bytes, 64 hex chars — `openssl rand -hex 32`).
 * If the key is absent the store is disabled and the bot runs memory-only.
 *
 * Layout per row: `iv(12) || authTag(16) || ciphertext`.
 */
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import Database from 'better-sqlite3';

import type { Session } from '../beanfun/types.js';

/** What we persist per user. `cookies` is a tough-cookie serialized jar. */
export interface PersistedSession {
  session: Session;
  cookies: unknown;
}

const IV_BYTES = 12;
const TAG_BYTES = 16;

export class SessionStore {
  private readonly db: Database.Database;
  private readonly key: Buffer;
  /** Drop persisted sessions older than this on load (0 = never expire). */
  private readonly maxAgeMs: number;

  constructor(dbPath: string, key: Buffer, maxAgeMs = 0) {
    this.key = key;
    this.maxAgeMs = maxAgeMs;
    // 0o700 dir / 0o600 file: the ciphertext sits next to the key on the same
    // host, so the only at-rest protection that buys anything is keeping the DB
    // unreadable by other local users. Fail-soft if chmod isn't supported.
    mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS sessions (
         discord_user_id TEXT PRIMARY KEY,
         blob            BLOB NOT NULL,
         updated_at      INTEGER NOT NULL
       )`,
    );
    // Access-control enrollment (plain Discord IDs — not secret). A user who has
    // redeemed the ACCESS_CODE once is recorded here so they never re-enter it.
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS enrolled_users (
         discord_user_id TEXT PRIMARY KEY,
         enrolled_at     INTEGER NOT NULL
       )`,
    );
    // WAL/SHM are created alongside the main file; lock all three down.
    for (const suffix of ['', '-wal', '-shm']) {
      const p = `${dbPath}${suffix}`;
      try {
        if (existsSync(p)) chmodSync(p, 0o600);
      } catch {
        /* non-POSIX fs (e.g. some Windows/CI) — best effort */
      }
    }
  }

  save(userId: string, payload: PersistedSession): void {
    const blob = this.encrypt(Buffer.from(JSON.stringify(payload), 'utf8'));
    this.db
      .prepare(
        `INSERT INTO sessions (discord_user_id, blob, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(discord_user_id) DO UPDATE SET blob = excluded.blob, updated_at = excluded.updated_at`,
      )
      .run(userId, blob, Date.now());
  }

  remove(userId: string): void {
    this.db.prepare(`DELETE FROM sessions WHERE discord_user_id = ?`).run(userId);
  }

  /** Record that a user has redeemed the access code (idempotent). Enrollment is
   *  independent of the session — /logout clears the session but NOT enrollment,
   *  so a returning user doesn't have to re-enter the code. */
  enroll(userId: string): void {
    this.db
      .prepare(
        `INSERT INTO enrolled_users (discord_user_id, enrolled_at) VALUES (?, ?)
         ON CONFLICT(discord_user_id) DO NOTHING`,
      )
      .run(userId, Date.now());
  }

  /** All enrolled Discord user IDs (loaded into an in-memory set at startup). */
  loadEnrolledIds(): string[] {
    const rows = this.db
      .prepare(`SELECT discord_user_id AS id FROM enrolled_users`)
      .all() as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  /** Load every persisted session. A row that fails to decrypt/parse is dropped
   *  (logged, not fatal) so one corrupt blob can't block startup. */
  loadAll(): Map<string, PersistedSession> {
    // Purge stale rows first so a leaked DB can't yield indefinitely-live
    // sessions: anything not refreshed within maxAgeMs is dropped on load.
    if (this.maxAgeMs > 0) {
      const cutoff = Date.now() - this.maxAgeMs;
      const purged = this.db.prepare(`DELETE FROM sessions WHERE updated_at < ?`).run(cutoff);
      if (purged.changes > 0) console.log(`[store] expired ${purged.changes} stale session(s)`);
    }

    const out = new Map<string, PersistedSession>();
    const rows = this.db
      .prepare(`SELECT discord_user_id AS id, blob FROM sessions`)
      .all() as Array<{ id: string; blob: Buffer }>;
    for (const row of rows) {
      try {
        const json = this.decrypt(row.blob).toString('utf8');
        out.set(row.id, JSON.parse(json) as PersistedSession);
      } catch (e) {
        console.error(`[store] dropping unreadable session for ${row.id}:`, errText(e));
      }
    }
    return out;
  }

  close(): void {
    this.db.close();
  }

  private encrypt(plain: Buffer): Buffer {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
  }

  private decrypt(blob: Buffer): Buffer {
    const iv = blob.subarray(0, IV_BYTES);
    const tag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const ciphertext = blob.subarray(IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }
}

/**
 * Build the store from env, or return `null` to run memory-only.
 * `SESSION_ENCRYPTION_KEY` must be 64 hex chars (32 bytes). A malformed key is a
 * hard error — failing closed beats silently writing under a wrong-length key.
 */
export function createStore(): SessionStore | null {
  const raw = process.env.SESSION_ENCRYPTION_KEY?.trim();
  if (!raw) {
    console.warn(
      '[store] SESSION_ENCRYPTION_KEY not set — running memory-only; sessions are lost on restart. ' +
        'Generate one with `openssl rand -hex 32`.',
    );
    return null;
  }
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error('SESSION_ENCRYPTION_KEY must be 64 hex chars (32 bytes); see `openssl rand -hex 32`.');
  }
  const dbPath = process.env.SESSION_DB_PATH?.trim() || 'data/beanycord.sqlite';
  const maxAgeMs = parseMaxAgeMs(process.env.SESSION_MAX_AGE_DAYS);
  return new SessionStore(dbPath, Buffer.from(raw, 'hex'), maxAgeMs);
}

/** Parse `SESSION_MAX_AGE_DAYS` (positive number of days) → ms. Default 30 days;
 *  `0` disables expiry. A malformed value falls back to the default. */
function parseMaxAgeMs(raw: string | undefined): number {
  const DEFAULT_DAYS = 30;
  const days = raw?.trim() ? Number(raw.trim()) : DEFAULT_DAYS;
  if (!Number.isFinite(days) || days < 0) return DEFAULT_DAYS * 86_400_000;
  return days * 86_400_000;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
