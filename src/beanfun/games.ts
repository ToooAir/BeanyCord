/**
 * Game catalogue. Mirrors Rust `games.rs::list_games`: two GETs
 * (`get_service_ini.ashx` + `game_zone/`) parsed atomically.
 */
import { BeanfunClient, boundedText, ensureSuccess } from './client.js';
import { TW } from './endpoints.js';
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
  const services = parseServiceList(boundedText(zoneRes));

  return { ini, services };
}
