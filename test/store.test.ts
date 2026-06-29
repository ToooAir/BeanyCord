/**
 * SessionStore round-trip + tamper-detection. Also smoke-tests that the
 * better-sqlite3 native module loads under the test runner.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SessionStore, type PersistedSession } from '../src/core/store.js';
import type { Session } from '../src/beanfun/types.js';

const SESSION: Session = {
  region: 'TW',
  skey: 'sess-key',
  webToken: 'web-token',
  accountId: '',
  serviceCode: '610074',
  serviceRegion: 'T9',
};

const PAYLOAD: PersistedSession = { session: SESSION, cookies: { version: 'tough-cookie@5', cookies: [] } };

describe('SessionStore', () => {
  let dir: string;
  let dbPath: string;
  const key = randomBytes(32);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'beanycord-store-'));
    dbPath = join(dir, 'sub', 'sessions.sqlite'); // sub/ exercises mkdir recursive
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips a saved session through encryption', () => {
    const store = new SessionStore(dbPath, key);
    store.save('user-1', PAYLOAD);
    const loaded = store.loadAll();
    store.close();
    expect(loaded.get('user-1')).toEqual(PAYLOAD);
  });

  it('upserts and removes by user id', () => {
    const store = new SessionStore(dbPath, key);
    store.save('u', PAYLOAD);
    store.save('u', { ...PAYLOAD, session: { ...SESSION, webToken: 'rotated' } });
    expect(store.loadAll().get('u')?.session.webToken).toBe('rotated');
    store.remove('u');
    expect(store.loadAll().size).toBe(0);
    store.close();
  });

  it('persists across reopen', () => {
    const a = new SessionStore(dbPath, key);
    a.save('user-2', PAYLOAD);
    a.close();
    const b = new SessionStore(dbPath, key);
    expect(b.loadAll().get('user-2')).toEqual(PAYLOAD);
    b.close();
  });

  it('drops a row that decrypts under the wrong key (GCM auth fails)', () => {
    const a = new SessionStore(dbPath, key);
    a.save('user-3', PAYLOAD);
    a.close();
    const b = new SessionStore(dbPath, randomBytes(32));
    expect(b.loadAll().size).toBe(0); // auth-tag mismatch -> dropped, not thrown
    b.close();
  });

  it('purges sessions older than maxAge on load', () => {
    const a = new SessionStore(dbPath, key);
    a.save('fresh', PAYLOAD);
    a.save('stale', PAYLOAD);
    a.close();
    // Backdate 'stale' to 40 days ago directly in the DB (a valid blob — we're
    // testing age-based purge, not decryption).
    const raw = new Database(dbPath);
    const old = Date.now() - 40 * 86_400_000;
    raw.prepare('UPDATE sessions SET updated_at = ? WHERE discord_user_id = ?').run(old, 'stale');
    raw.close();

    const store = new SessionStore(dbPath, key, 30 * 86_400_000);
    const loaded = store.loadAll();
    expect(loaded.has('fresh')).toBe(true);
    expect(loaded.has('stale')).toBe(false);
    store.close();
  });

  it('enrolls users idempotently and survives reopen', () => {
    const a = new SessionStore(dbPath, key);
    a.enroll('friend-1');
    a.enroll('friend-1'); // idempotent
    a.enroll('friend-2');
    a.close();
    const b = new SessionStore(dbPath, key);
    expect(new Set(b.loadEnrolledIds())).toEqual(new Set(['friend-1', 'friend-2']));
    b.close();
  });

  it('keeps enrollment when the session is removed (logout)', () => {
    const store = new SessionStore(dbPath, key);
    store.save('u', PAYLOAD);
    store.enroll('u');
    store.remove('u'); // logout clears the session, not the enrollment
    expect(store.loadAll().size).toBe(0);
    expect(store.loadEnrolledIds()).toEqual(['u']);
    store.close();
  });

  it('rejects a tampered blob', () => {
    const store = new SessionStore(dbPath, key);
    store.save('user-4', PAYLOAD);
    store.close();
    // Flip a byte deep in the ciphertext directly in the DB.
    const raw = new Database(dbPath);
    const row = raw.prepare('SELECT blob FROM sessions WHERE discord_user_id = ?').get('user-4') as {
      blob: Buffer;
    };
    const last = row.blob.length - 1;
    row.blob[last] = (row.blob[last] ?? 0) ^ 0xff;
    raw.prepare('UPDATE sessions SET blob = ? WHERE discord_user_id = ?').run(row.blob, 'user-4');
    raw.close();
    const store2 = new SessionStore(dbPath, key);
    expect(store2.loadAll().size).toBe(0);
    store2.close();
  });
});
