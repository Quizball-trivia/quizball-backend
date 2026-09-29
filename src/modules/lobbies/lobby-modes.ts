import { config } from '../../core/config.js';
import { isDuelGameEnabled } from '../duel/duel.config.js';
import type { LobbyGameMode } from '../../realtime/socket.types.js';

export const FRIENDLY_LOBBY_MAX_MEMBERS = 6;
export const FRIENDLY_AUCTION_LOBBY_MAX_MEMBERS = 3;
export const FOOTBALL_GRID_LOBBY_MAX_MEMBERS = 2;
export const DUEL_LOBBY_MAX_MEMBERS = 2;

export interface LobbyModeCapabilities {
  /** Members a room may HOLD in this mode (possession grows past 2 and then promotes to party quiz). */
  capacity: number;
  /** Members who can PLAY it: a host may switch the room into the mode only within this. */
  playable: number;
  /** A room holding a guest may be in this mode (owner decision 2026-09-12). */
  guestAllowed: boolean;
  /** Member counts a host start accepts; null = no host start (ranked sim drafts on ready). */
  hostStart: { min: number; max: number } | null;
  /** Plays the lobby's friendly categories; otherwise the room's category picks are cleared. */
  needsCategories: boolean;
  /** More than two members turn the room into party quiz. */
  promotesToPartyQuiz: boolean;
  /** Kill switch: null while the mode can be chosen, else the error the client gets. */
  unavailable: (duelGame: unknown) => { code: 'GRID_UNAVAILABLE' | 'DUEL_UNAVAILABLE'; message: string } | null;
}

const alwaysAvailable = () => null;

/** One place per mode: every lobby switch (join, settings, start, guests, public list, zod enums) reads this. */
export const LOBBY_MODES: Readonly<Record<LobbyGameMode, LobbyModeCapabilities>> = {
  friendly_possession: {
    capacity: FRIENDLY_LOBBY_MAX_MEMBERS,
    playable: 2,
    guestAllowed: false,
    hostStart: { min: 2, max: 2 },
    needsCategories: true,
    promotesToPartyQuiz: true,
    unavailable: alwaysAvailable,
  },
  friendly_party_quiz: {
    capacity: FRIENDLY_LOBBY_MAX_MEMBERS,
    playable: FRIENDLY_LOBBY_MAX_MEMBERS,
    guestAllowed: false,
    hostStart: { min: 2, max: FRIENDLY_LOBBY_MAX_MEMBERS },
    needsCategories: true,
    promotesToPartyQuiz: true,
    unavailable: alwaysAvailable,
  },
  football_grid: {
    capacity: FOOTBALL_GRID_LOBBY_MAX_MEMBERS,
    playable: FOOTBALL_GRID_LOBBY_MAX_MEMBERS,
    guestAllowed: true,
    hostStart: { min: 2, max: 2 },
    needsCategories: false,
    promotesToPartyQuiz: false,
    unavailable: () => (config.FOOTBALL_GRID_LOBBY_ENABLED
      ? null
      : { code: 'GRID_UNAVAILABLE', message: 'Football Tic Tac Toe lobbies are temporarily unavailable' }),
  },
  // Empty seats are backfilled with bots, so one human may start.
  auction: {
    capacity: FRIENDLY_AUCTION_LOBBY_MAX_MEMBERS,
    playable: FRIENDLY_AUCTION_LOBBY_MAX_MEMBERS,
    guestAllowed: true,
    hostStart: { min: 1, max: FRIENDLY_AUCTION_LOBBY_MAX_MEMBERS },
    needsCategories: false,
    promotesToPartyQuiz: false,
    unavailable: alwaysAvailable,
  },
  ranked_sim: {
    capacity: FRIENDLY_LOBBY_MAX_MEMBERS,
    playable: 2,
    guestAllowed: true,
    hostStart: null,
    needsCategories: false,
    promotesToPartyQuiz: true,
    unavailable: alwaysAvailable,
  },
  // A friend duel of a daily mini-game (lobbies.duel_game); runs on duel_matches, never on `matches`.
  duel: {
    capacity: DUEL_LOBBY_MAX_MEMBERS,
    playable: DUEL_LOBBY_MAX_MEMBERS,
    guestAllowed: true,
    hostStart: { min: 2, max: 2 },
    needsCategories: false,
    promotesToPartyQuiz: false,
    unavailable: (duelGame) => (isDuelGameEnabled(duelGame)
      ? null
      : { code: 'DUEL_UNAVAILABLE', message: 'This game cannot be played as a friend duel right now' }),
  },
};

export const LOBBY_GAME_MODES = Object.keys(LOBBY_MODES) as [LobbyGameMode, ...LobbyGameMode[]];

export function isLobbyGameMode(value: unknown): value is LobbyGameMode {
  return typeof value === 'string' && Object.hasOwn(LOBBY_MODES, value);
}

export function lobbyModeUnavailable(mode: LobbyGameMode, duelGame?: unknown) {
  return LOBBY_MODES[mode].unavailable(duelGame);
}

export function isValidHostStartShape(mode: LobbyGameMode, memberCount: number): boolean {
  const shape = LOBBY_MODES[mode].hostStart;
  return shape !== null && memberCount >= shape.min && memberCount <= shape.max;
}

/** The mode a room is actually in for a member count (join/leave/settings normalization). */
export function modeForMemberCount(mode: LobbyGameMode, memberCount: number): LobbyGameMode {
  return memberCount > 2 && LOBBY_MODES[mode].promotesToPartyQuiz ? 'friendly_party_quiz' : mode;
}

/** Capacity per mode for SQL (public lobby list); unknown modes fall back to the party ceiling there. */
export function lobbyCapacityByMode(): Record<string, number> {
  return Object.fromEntries(LOBBY_GAME_MODES.map((mode) => [mode, LOBBY_MODES[mode].capacity]));
}
