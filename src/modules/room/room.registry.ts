import { aproximadoRoomEngine } from './games/aproximado/aproximado.room.js';
import { CODENAMES_TIMER_VERSION, CODENAMES_WORDS_VERSION, codenamesRoomEngine } from './games/codenames/codenames.room.js';
import { datoFalsoRoomEngine } from './games/dato-falso/dato-falso.room.js';
import { footballRaceRoomEngine } from './games/football-race/football-race.room.js';
import { nameChainRoomEngine } from './games/name-chain/name-chain.room.js';
import { sharedPlayerRoomEngine } from './games/shared-player/shared-player.room.js';
import { tenableRoomEngine } from './games/tenable/tenable.room.js';
import type { AnyRoomEngine } from './room.engine.js';
import type { RoomGameId } from './room.types.js';

// Engines are looked up by (game, version): a match keeps the engine it started with across deploys.
const CURRENT: Record<RoomGameId, AnyRoomEngine> = {
  aproximado: aproximadoRoomEngine as unknown as AnyRoomEngine,
  shared_player: sharedPlayerRoomEngine as unknown as AnyRoomEngine,
  name_chain: nameChainRoomEngine as unknown as AnyRoomEngine,
  tenable: tenableRoomEngine as unknown as AnyRoomEngine,
  football_race: footballRaceRoomEngine as unknown as AnyRoomEngine,
  codenames: codenamesRoomEngine as unknown as AnyRoomEngine,
  dato_falso: datoFalsoRoomEngine as unknown as AnyRoomEngine,
};

const ENGINES: Record<RoomGameId, Record<number, AnyRoomEngine>> = {
  aproximado: { [aproximadoRoomEngine.version]: aproximadoRoomEngine as unknown as AnyRoomEngine },
  shared_player: { [sharedPlayerRoomEngine.version]: sharedPlayerRoomEngine as unknown as AnyRoomEngine },
  name_chain: { [nameChainRoomEngine.version]: nameChainRoomEngine as unknown as AnyRoomEngine },
  tenable: { [tenableRoomEngine.version]: tenableRoomEngine as unknown as AnyRoomEngine },
  football_race: { [footballRaceRoomEngine.version]: footballRaceRoomEngine as unknown as AnyRoomEngine },
  // Version 2: word boards (an older build reads picture boards only). One engine runs both.
  codenames: { 1: codenamesRoomEngine as unknown as AnyRoomEngine, [CODENAMES_WORDS_VERSION]: codenamesRoomEngine as unknown as AnyRoomEngine, [CODENAMES_TIMER_VERSION]: codenamesRoomEngine as unknown as AnyRoomEngine },
  dato_falso: { [datoFalsoRoomEngine.version]: datoFalsoRoomEngine as unknown as AnyRoomEngine },
};

/**
 * Games every deployed client can draw. For any other game a client must list it (`games` on room:ready and
 * room:resync): a tab loaded before that game shipped lists nothing, so it is never admitted and never brings a seat
 * back.
 */
const KNOWN_TO_EVERY_CLIENT: ReadonlySet<string> = new Set<RoomGameId>(['aproximado']);

/**
 * Match versions an older bundle of the game cannot draw: a client must also list `<game>@<version>` (a tab loaded
 * before word boards would show picture art for words).
 */
const NEEDS_CLIENT_VERSION: Partial<Record<RoomGameId, ReadonlySet<number>>> = { codenames: new Set([CODENAMES_WORDS_VERSION, CODENAMES_TIMER_VERSION]) };

/** What a client must list besides the game to draw this version of it; null when the game alone is enough. */
export const clientVersionToken = (game: string | null | undefined, version: number | null | undefined): string | null =>
  game && version && NEEDS_CLIENT_VERSION[game as RoomGameId]?.has(version) ? `${game}@${version}` : null;
/** Every such token (a tab that does not list one is kept out of that version's broadcasts). */
export const CLIENT_VERSION_TOKENS: readonly string[] = Object.entries(NEEDS_CLIENT_VERSION).flatMap(([game, versions]) => [...versions!].map((v) => `${game}@${v}`));

export const clientCanPlay = (game: RoomGameId, listed: readonly string[] | undefined, version = 1): boolean => {
  const token = clientVersionToken(game, version);
  return (KNOWN_TO_EVERY_CLIENT.has(game) || Boolean(listed?.includes(game))) && (!token || Boolean(listed?.includes(token)));
};

export const currentRoomEngine = (game: RoomGameId): AnyRoomEngine => CURRENT[game];

/** Null for a game or version this build does not have (the match is then cancelled). */
export const roomEngineFor = (game: string, version: number): AnyRoomEngine | null => (ENGINES as Record<string, Record<number, AnyRoomEngine>>)[game]?.[version] ?? null;
