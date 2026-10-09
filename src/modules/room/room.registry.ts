import { aproximadoRoomEngine } from './games/aproximado/aproximado.room.js';
import { nameChainRoomEngine } from './games/name-chain/name-chain.room.js';
import { sharedPlayerRoomEngine } from './games/shared-player/shared-player.room.js';
import type { AnyRoomEngine } from './room.engine.js';
import type { RoomGameId } from './room.types.js';

// Engines are looked up by (game, version): a match keeps the engine it started with across deploys.
const CURRENT: Record<RoomGameId, AnyRoomEngine> = {
  aproximado: aproximadoRoomEngine as unknown as AnyRoomEngine,
  shared_player: sharedPlayerRoomEngine as unknown as AnyRoomEngine,
  name_chain: nameChainRoomEngine as unknown as AnyRoomEngine,
};

const ENGINES: Record<RoomGameId, Record<number, AnyRoomEngine>> = {
  aproximado: { [aproximadoRoomEngine.version]: aproximadoRoomEngine as unknown as AnyRoomEngine },
  shared_player: { [sharedPlayerRoomEngine.version]: sharedPlayerRoomEngine as unknown as AnyRoomEngine },
  name_chain: { [nameChainRoomEngine.version]: nameChainRoomEngine as unknown as AnyRoomEngine },
};

/**
 * Games every deployed client can draw. For any other game a client must list it (`games` on room:ready and
 * room:resync): a tab loaded before that game shipped lists nothing, so it is never admitted and never brings a seat
 * back.
 */
const KNOWN_TO_EVERY_CLIENT: ReadonlySet<string> = new Set<RoomGameId>(['aproximado']);

export const clientCanPlay = (game: RoomGameId, listed: readonly string[] | undefined): boolean => KNOWN_TO_EVERY_CLIENT.has(game) || Boolean(listed?.includes(game));

export const currentRoomEngine = (game: RoomGameId): AnyRoomEngine => CURRENT[game];

/** Null for a game or version this build does not have (the match is then cancelled). */
export const roomEngineFor = (game: string, version: number): AnyRoomEngine | null => (ENGINES as Record<string, Record<number, AnyRoomEngine>>)[game]?.[version] ?? null;
