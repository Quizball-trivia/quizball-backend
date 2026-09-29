import type { LobbyGameMode } from '../../realtime/socket.types.js';
import { LOBBY_MODES } from './lobby-modes.js';

export {
  FRIENDLY_LOBBY_MAX_MEMBERS,
  FRIENDLY_AUCTION_LOBBY_MAX_MEMBERS,
  FOOTBALL_GRID_LOBBY_MAX_MEMBERS,
} from './lobby-modes.js';

export function lobbyCapacityForGameMode(gameMode: LobbyGameMode): number {
  return (LOBBY_MODES[gameMode] ?? LOBBY_MODES.friendly_party_quiz).capacity;
}

export function playableMembersForGameMode(gameMode: LobbyGameMode): number {
  return (LOBBY_MODES[gameMode] ?? LOBBY_MODES.friendly_party_quiz).playable;
}
