import { afterEach, describe, expect, it } from 'vitest';
import '../setup.js';

const {
  LOBBY_GAME_MODES,
  LOBBY_MODES,
  isLobbyGameMode,
  isValidHostStartShape,
  lobbyCapacityByMode,
  lobbyModeUnavailable,
  modeForMemberCount,
} = await import('../../src/modules/lobbies/lobby-modes.js');
const { normalizeFriendlyGameMode } = await import('../../src/realtime/lobby-utils.js');
const { GUEST_ALLOWED_LOBBY_MODES } = await import('../../src/realtime/services/lobby-guest-rules.js');
const { lobbyCapacityForGameMode, playableMembersForGameMode } = await import('../../src/modules/lobbies/lobby-capacity.js');
const { lobbyCreateSchema, lobbyUpdateSettingsSchema } = await import('../../src/realtime/schemas/lobby.schemas.js');
const { publicLobbyResponseSchema } = await import('../../src/modules/lobbies/lobbies.schemas.js');
const { config } = await import('../../src/core/config.js');

const flags = config as unknown as { DUEL_GAMES_ENABLED: string[]; FOOTBALL_GRID_LOBBY_ENABLED: boolean };
const originalDuelGames = [...flags.DUEL_GAMES_ENABLED];

afterEach(() => {
  flags.DUEL_GAMES_ENABLED = [...originalDuelGames];
});

describe('lobby mode capability map', () => {
  it('describes a duel room: two seats, guests welcome, no categories, never party quiz', () => {
    expect(LOBBY_MODES.duel).toMatchObject({
      capacity: 2,
      playable: 2,
      guestAllowed: true,
      hostStart: { min: 2, max: 2 },
      needsCategories: false,
      promotesToPartyQuiz: false,
    });
    expect(lobbyCapacityForGameMode('duel')).toBe(2);
    expect(playableMembersForGameMode('duel')).toBe(2);
    expect(GUEST_ALLOWED_LOBBY_MODES.has('duel')).toBe(true);
  });

  it('keeps the existing modes as they were', () => {
    expect(LOBBY_GAME_MODES.map((mode) => [mode, lobbyCapacityForGameMode(mode), playableMembersForGameMode(mode)])).toEqual([
      ['friendly_possession', 6, 2],
      ['friendly_party_quiz', 6, 6],
      ['football_grid', 2, 2],
      ['auction', 3, 3],
      ['ranked_sim', 6, 2],
      ['duel', 2, 2],
      ['room_game', 6, 6],
    ]);
    expect([...GUEST_ALLOWED_LOBBY_MODES].sort()).toEqual(['auction', 'duel', 'football_grid', 'ranked_sim', 'room_game']);
    expect(lobbyCapacityByMode()).toEqual({
      friendly_possession: 6, friendly_party_quiz: 6, football_grid: 2, auction: 3, ranked_sim: 6, duel: 2, room_game: 6,
    });
  });

  it('room games: 2–6 players, guests welcome, behind their own switch', () => {
    expect(isValidHostStartShape('room_game', 1)).toBe(false);
    expect(isValidHostStartShape('room_game', 2)).toBe(true);
    expect(isValidHostStartShape('room_game', 6)).toBe(true);
    expect(isValidHostStartShape('room_game', 7)).toBe(false);
    expect(GUEST_ALLOWED_LOBBY_MODES.has('room_game')).toBe(true);
    expect(lobbyUpdateSettingsSchema.safeParse({ gameMode: 'room_game', roomGame: 'aproximado' }).success).toBe(true);
    expect(lobbyUpdateSettingsSchema.safeParse({ gameMode: 'room_game' }).success).toBe(false);
    expect(lobbyUpdateSettingsSchema.safeParse({ gameMode: 'room_game', roomGame: 'chess' }).success).toBe(false);
    expect(lobbyUpdateSettingsSchema.safeParse({ gameMode: 'auction', roomGame: 'aproximado' }).success).toBe(false);
  });

  it('host start shapes', () => {
    expect(isValidHostStartShape('duel', 2)).toBe(true);
    expect(isValidHostStartShape('duel', 1)).toBe(false);
    expect(isValidHostStartShape('duel', 3)).toBe(false);
    expect(isValidHostStartShape('auction', 1)).toBe(true);
    expect(isValidHostStartShape('friendly_party_quiz', 6)).toBe(true);
    expect(isValidHostStartShape('friendly_possession', 3)).toBe(false);
    expect(isValidHostStartShape('ranked_sim', 2)).toBe(false);
  });

  it('only modes that promote become party quiz past two members', () => {
    expect(modeForMemberCount('duel', 3)).toBe('duel');
    expect(modeForMemberCount('auction', 3)).toBe('auction');
    expect(modeForMemberCount('football_grid', 3)).toBe('football_grid');
    expect(modeForMemberCount('friendly_possession', 3)).toBe('friendly_party_quiz');
    expect(modeForMemberCount('ranked_sim', 3)).toBe('friendly_party_quiz');
    expect(modeForMemberCount('friendly_possession', 2)).toBe('friendly_possession');
  });

  it('a duel room survives normalization; unknown modes still fall back to possession', () => {
    expect(normalizeFriendlyGameMode('duel')).toBe('duel');
    expect(normalizeFriendlyGameMode('auction')).toBe('auction');
    expect(normalizeFriendlyGameMode('toString')).toBe('friendly_possession');
    expect(normalizeFriendlyGameMode('bogus')).toBe('friendly_possession');
    expect(normalizeFriendlyGameMode(null)).toBe('friendly_possession');
    expect(isLobbyGameMode('duel')).toBe(true);
    expect(isLobbyGameMode('__proto__')).toBe(false);
  });

  it('a duel is available per game (DUEL_GAMES_ENABLED)', () => {
    flags.DUEL_GAMES_ENABLED = ['buscaminas'];
    expect(lobbyModeUnavailable('duel', 'buscaminas')).toBeNull();
    expect(lobbyModeUnavailable('duel', 'pistas')).toMatchObject({ code: 'DUEL_UNAVAILABLE' });
    expect(lobbyModeUnavailable('duel', 'chess')).toMatchObject({ code: 'DUEL_UNAVAILABLE' });
    expect(lobbyModeUnavailable('duel', null)).toMatchObject({ code: 'DUEL_UNAVAILABLE' });
    flags.DUEL_GAMES_ENABLED = [];
    expect(lobbyModeUnavailable('duel', 'buscaminas')).toMatchObject({ code: 'DUEL_UNAVAILABLE' });
    expect(lobbyModeUnavailable('auction')).toBeNull();
  });
});

describe('duel payload schemas', () => {
  it('lobby:create needs a duel game exactly for a duel room', () => {
    expect(lobbyCreateSchema.safeParse({ mode: 'friendly', isPublic: false, gameMode: 'duel', duelGame: 'pistas' }).success).toBe(true);
    expect(lobbyCreateSchema.safeParse({ mode: 'friendly', gameMode: 'duel' }).success).toBe(false);
    expect(lobbyCreateSchema.safeParse({ mode: 'friendly', gameMode: 'duel', duelGame: 'chess' }).success).toBe(false);
    expect(lobbyCreateSchema.safeParse({ mode: 'friendly', gameMode: 'auction', duelGame: 'pistas' }).success).toBe(false);
    expect(lobbyCreateSchema.safeParse({ mode: 'friendly', gameMode: 'auction' }).success).toBe(true);
  });

  it('lobby:update_settings: duel needs its game, other modes carry none and no categories are required', () => {
    expect(lobbyUpdateSettingsSchema.safeParse({ gameMode: 'duel', duelGame: 'buscaminas' }).success).toBe(true);
    expect(lobbyUpdateSettingsSchema.safeParse({ gameMode: 'duel', duelGame: 'buscaminas', friendlyRandom: false }).success).toBe(true);
    expect(lobbyUpdateSettingsSchema.safeParse({ gameMode: 'duel' }).success).toBe(false);
    expect(lobbyUpdateSettingsSchema.safeParse({ gameMode: 'duel', duelGame: null }).success).toBe(false);
    expect(lobbyUpdateSettingsSchema.safeParse({ gameMode: 'auction', duelGame: null }).success).toBe(true);
    expect(lobbyUpdateSettingsSchema.safeParse({ gameMode: 'auction', duelGame: 'pistas' }).success).toBe(false);
    expect(lobbyUpdateSettingsSchema.safeParse({ gameMode: 'friendly_possession', friendlyRandom: false }).success).toBe(false);
  });

  it('the public lobby response carries the duel game', () => {
    const base = {
      lobbyId: '6f1c7b52-7d5e-4a53-9f55-0d9b5c1f5a11', inviteCode: 'ABC123', displayName: 'Room', isPublic: true,
      createdAt: new Date().toISOString(), memberCount: 1, maxMembers: 2,
      host: { id: '6f1c7b52-7d5e-4a53-9f55-0d9b5c1f5a12', username: 'h', avatarUrl: null, avatarCustomization: null },
    };
    expect(publicLobbyResponseSchema.safeParse({ ...base, gameMode: 'duel', duelGame: 'pistas', roomGame: null }).success).toBe(true);
    expect(publicLobbyResponseSchema.safeParse({ ...base, gameMode: 'auction', duelGame: null, roomGame: null }).success).toBe(true);
    expect(publicLobbyResponseSchema.safeParse({ ...base, gameMode: 'room_game', duelGame: null, roomGame: 'aproximado' }).success).toBe(true);
  });
});
