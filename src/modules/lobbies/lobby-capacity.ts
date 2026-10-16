import type { LobbyGameMode } from '../../realtime/socket.types.js';
import { LOBBY_MODES } from './lobby-modes.js';
import { roomGameSeats } from '../room/room.types.js';

export {
  FRIENDLY_LOBBY_MAX_MEMBERS,
  FRIENDLY_AUCTION_LOBBY_MAX_MEMBERS,
  FOOTBALL_GRID_LOBBY_MAX_MEMBERS,
} from './lobby-modes.js';

/** `roomGame`: a room game with its own seat cap lowers a room_game room's (the mode's own cap stays the ceiling). */
export function lobbyCapacityForGameMode(gameMode: LobbyGameMode, roomGame?: unknown): number {
  const capacity = (LOBBY_MODES[gameMode] ?? LOBBY_MODES.friendly_party_quiz).capacity;
  return gameMode === 'room_game' ? roomGameSeats(roomGame, capacity) : capacity;
}

export function playableMembersForGameMode(gameMode: LobbyGameMode, roomGame?: unknown): number {
  const playable = (LOBBY_MODES[gameMode] ?? LOBBY_MODES.friendly_party_quiz).playable;
  return gameMode === 'room_game' ? roomGameSeats(roomGame, playable) : playable;
}
