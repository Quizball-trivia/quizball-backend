import { config } from '../../core/config.js';
import { isRoomGame, ROOM_GAMES, type RoomGameId } from './room.types.js';

/** Every room game is on; ROOM_GAMES_DISABLED switches one off. */
export const isRoomGameEnabled = (game: unknown): game is RoomGameId => isRoomGame(game) && !(config.ROOM_GAMES_DISABLED ?? []).includes(game);

export const anyRoomGameEnabled = (): boolean => ROOM_GAMES.some(isRoomGameEnabled);
