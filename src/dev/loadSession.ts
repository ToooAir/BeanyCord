/**
 * Dev-only: load one persisted session off disk for a probe to use.
 *
 * Lifted out of `capture.ts` so the "never guess which slot" rule lives in one
 * place. That rule is safety-critical, not ergonomics: the DB normally also
 * holds real users' sessions, and picking one by row order would fire requests
 * with the wrong person's credentials.
 */
import 'dotenv/config';
import { CookieJar } from 'tough-cookie';

import { BeanfunClient } from '../beanfun/client.js';
import { createStore } from '../core/store.js';
import type { Session } from '../beanfun/types.js';
import type { SessionStore } from '../core/store.js';

/** Slot id `m0 --persist` writes to — keep in sync with `src/m0.ts`. */
export const M0_SLOT = 'm0-capture';

export interface LoadedSession {
  userId: string;
  jar: CookieJar;
  client: BeanfunClient;
  session: Session;
  store: SessionStore;
}

/** Returns null (after printing why) when there is nothing safe to load. */
export async function loadPersistedSession(): Promise<LoadedSession | null> {
  const store = createStore();
  if (!store) {
    console.error('No SESSION_ENCRYPTION_KEY — nothing is persisted, so there is nothing to load.');
    return null;
  }

  const all = store.loadAll();
  if (all.size === 0) {
    console.error('No persisted sessions. Run `npm run m0 -- --persist` first.');
    store.close();
    return null;
  }

  // Explicit env var first, then the dedicated m0 slot, then a lone session —
  // otherwise refuse and list the choices.
  const wanted = process.env.CAPTURE_USER_ID?.trim() || (all.has(M0_SLOT) ? M0_SLOT : undefined);
  const userId = wanted ?? (all.size === 1 ? [...all.keys()][0]! : undefined);
  if (!userId) {
    console.error(
      `Several sessions are persisted — refusing to guess.\n` +
        `  Slots: ${[...all.keys()].join(', ')}\n` +
        `  Pick one with CAPTURE_USER_ID=<slot>, or create a dedicated one with ` +
        '`npm run m0 -- --persist`.',
    );
    store.close();
    return null;
  }

  const payload = all.get(userId);
  if (!payload) {
    console.error(`No persisted session for ${userId}. Present: ${[...all.keys()].join(', ')}`);
    store.close();
    return null;
  }

  const jar = await CookieJar.deserialize(payload.cookies as never);
  return { userId, jar, client: new BeanfunClient({ jar }), session: payload.session, store };
}
