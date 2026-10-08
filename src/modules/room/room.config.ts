import { config } from '../../core/config.js';
import { isRoomGame, type RoomGameId } from './room.types.js';

/** On without any configuration; ROOM_GAMES_DISABLED still switches one off. */
export const ROOM_GAMES_ON_BY_DEFAULT: readonly RoomGameId[] = ['shared_player', 'name_chain'];

/** Per-game switch: on by default or named in ROOM_GAMES_ENABLED, and not named in ROOM_GAMES_DISABLED. */
export const isRoomGameEnabled = (game: unknown): game is RoomGameId => isRoomGame(game)
  && (ROOM_GAMES_ON_BY_DEFAULT.includes(game) || config.ROOM_GAMES_ENABLED.includes(game))
  && !(config.ROOM_GAMES_DISABLED ?? []).includes(game);

export const anyRoomGameEnabled = (): boolean => [...ROOM_GAMES_ON_BY_DEFAULT, ...config.ROOM_GAMES_ENABLED].some(isRoomGameEnabled);
