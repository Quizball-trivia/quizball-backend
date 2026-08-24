import type { LobbyGameMode } from '../../realtime/socket.types.js';

export const FRIENDLY_LOBBY_MAX_MEMBERS = 6;
export const FRIENDLY_AUCTION_LOBBY_MAX_MEMBERS = 3;
export const FOOTBALL_GRID_LOBBY_MAX_MEMBERS = 2;

export function lobbyCapacityForGameMode(gameMode: LobbyGameMode): number {
  if (gameMode === 'football_grid') return FOOTBALL_GRID_LOBBY_MAX_MEMBERS;
  if (gameMode === 'auction') return FRIENDLY_AUCTION_LOBBY_MAX_MEMBERS;
  return FRIENDLY_LOBBY_MAX_MEMBERS;
}

export function playableMembersForGameMode(gameMode: LobbyGameMode): number {
  if (gameMode === 'football_grid' || gameMode === 'friendly_possession' || gameMode === 'ranked_sim') {
    return 2;
  }
  if (gameMode === 'auction') return FRIENDLY_AUCTION_LOBBY_MAX_MEMBERS;
  return FRIENDLY_LOBBY_MAX_MEMBERS;
}
