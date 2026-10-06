import { config } from '../../core/config.js';
import { isRoomGame, type RoomGameId } from './room.types.js';

/** Per-game kill switch: ROOM_GAMES_ENABLED. */
export const anyRoomGameEnabled = (): boolean => config.ROOM_GAMES_ENABLED.length > 0;

export const isRoomGameEnabled = (game: unknown): game is RoomGameId => isRoomGame(game) && config.ROOM_GAMES_ENABLED.includes(game);
