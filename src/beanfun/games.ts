/**
 * Game catalogue. Mirrors Rust `games.rs::list_games`: two GETs
 * (`get_service_ini.ashx` + `game_zone/`) parsed atomically.
 */
import { assertSessionAlive, BeanfunClient, boundedText, ensureSuccess } from './client.js';
import { TW } from './endpoints.js';
import { BeanfunError } from './errors.js';
import { parseServiceIni, parseServiceList } from './parser.js';
import type { GameIniEntry, GameService } from './types.js';

export interface GameInfoBundle {
  ini: Record<string, GameIniEntry>;
  services: GameService[];
}

export async function listGames(client: BeanfunClient): Promise<GameInfoBundle> {
  const iniRes = await client.http.get(
    `${TW.portalBase}beanfun_block/generic_handlers/get_service_ini.ashx`,
  );
  ensureSuccess(iniRes, 'get_service_ini.ashx');
  const ini = parseServiceIni(boundedText(iniRes));

  const zoneRes = await client.http.get(`${TW.portalBase}game_zone/`);
  ensureSuccess(zoneRes, 'game_zone/');
  const zoneBody = boundedText(zoneRes);
  // `parseServiceList` throws GameListServiceListMissing when the marker isn't
  // there. Captured from a real dead session, `game_zone/` still serves the full
  // catalogue — it is public — so session death is NOT expected to land here;
  // this stays as defence in case the portal ever gates it. A genuine format
  // change keeps its own error, so the two remain distinguishable in logs.
  let services;
  try {
    services = parseServiceList(zoneBody);
  } catch (e) {
    assertSessionAlive(zoneBody, 'game_zone/');
    throw e;
  }
  // The catalogue is the portal's global game list, never legitimately empty —
  // an empty one would reach Discord as a select menu with no options, which the
  // API rejects with an error the user cannot act on.
  if (services.length === 0) {
    assertSessionAlive(zoneBody, 'game_zone/');
    throw new BeanfunError('games.empty_catalogue', 'game_zone/ yielded no services');
  }

  return { ini, services };
}
