import { config } from '../../core/config.js';
import type { LobbyGameMode } from '../socket.types.js';
import { lobbyCapacityForGameMode } from '../../modules/lobbies/lobby-capacity.js';

/** What a room may play while it holds at least one guest (owner decision 2026-09-12). */
export const GUEST_ALLOWED_LOBBY_MODES: ReadonlySet<LobbyGameMode> = new Set<LobbyGameMode>(['football_grid', 'auction', 'ranked_sim']);
export const MAX_GUESTS_PER_LOBBY = 3;

export interface GuestLobbyMember {
  user_id: string;
  is_guest: boolean;
}

export type GuestLobbyViolation =
  | { code: 'LOBBY_MODE_REQUIRES_ACCOUNT'; message: string; meta: { gameMode: LobbyGameMode } }
  | { code: 'LOBBY_GUEST_LIMIT'; message: string; meta: { maxGuests: number } }
  | { code: 'LOBBY_FULL'; message: string; meta: { memberCount: number; maxMembers: number; gameMode: LobbyGameMode } };

export function isGuestAllowedLobbyMode(mode: LobbyGameMode): boolean {
  return GUEST_ALLOWED_LOBBY_MODES.has(mode);
}

/** The mode a guest-hosted room opens in (the repo default, friendly_possession, is locked for guests). */
export function guestCompatibleInitialMode(): LobbyGameMode {
  return config.FOOTBALL_GRID_LOBBY_ENABLED ? 'football_grid' : 'auction';
}

/**
 * The mode the room will actually be in for a member count, mirroring the
 * join/leave normalization (> 2 members promotes to party quiz unless the room
 * is auction or grid).
 */
export function normalizedModeForMemberCount(mode: LobbyGameMode, memberCount: number): LobbyGameMode {
  return memberCount > 2 && mode !== 'auction' && mode !== 'football_grid' ? 'friendly_party_quiz' : mode;
}

/**
 * Validates the room a mutation would leave behind. `members` are the members
 * AFTER the mutation (joiner included, leaver excluded). Rooms without guests
 * are never constrained here — live behaviour is untouched.
 */
export function validateGuestLobby(members: readonly GuestLobbyMember[], nextMode: LobbyGameMode): GuestLobbyViolation | null {
  const guests = members.filter((member) => member.is_guest).length;
  if (guests === 0) return null;
  if (guests > MAX_GUESTS_PER_LOBBY) {
    return { code: 'LOBBY_GUEST_LIMIT', message: `A room can hold at most ${MAX_GUESTS_PER_LOBBY} guests`, meta: { maxGuests: MAX_GUESTS_PER_LOBBY } };
  }
  if (!isGuestAllowedLobbyMode(nextMode)) {
    return { code: 'LOBBY_MODE_REQUIRES_ACCOUNT', message: 'This mode needs an account — Tic Tac Toe, Auction and Ranked sim are open to guests', meta: { gameMode: nextMode } };
  }
  const maxMembers = lobbyCapacityForGameMode(nextMode);
  if (members.length > maxMembers) {
    return { code: 'LOBBY_FULL', message: 'Lobby is already full', meta: { memberCount: members.length, maxMembers, gameMode: nextMode } };
  }
  return null;
}
