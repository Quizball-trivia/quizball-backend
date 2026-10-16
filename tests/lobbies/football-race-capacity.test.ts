import { describe, expect, it } from 'vitest';
import { lobbyCapacityForGameMode, playableMembersForGameMode } from '../../src/modules/lobbies/lobby-capacity.js';
import { isValidHostStartShape } from '../../src/modules/lobbies/lobby-modes.js';
import { roomGameSeats, ROOM_GAME_MAX_SEATS } from '../../src/modules/room/room.types.js';
import { footballRaceRoomEngine } from '../../src/modules/room/games/football-race/football-race.room.js';

describe('per-game room seats', () => {
  it('caps a Football Horserace room at four, and leaves every other room game at six', () => {
    expect(ROOM_GAME_MAX_SEATS.football_race).toBe(4);
    expect(lobbyCapacityForGameMode('room_game', 'football_race')).toBe(4);
    expect(playableMembersForGameMode('room_game', 'football_race')).toBe(4);
    expect(lobbyCapacityForGameMode('room_game', 'name_chain')).toBe(6);
    expect(lobbyCapacityForGameMode('room_game')).toBe(6);
    // Another mode never takes a room game's cap.
    expect(lobbyCapacityForGameMode('friendly_party_quiz', 'football_race')).toBe(lobbyCapacityForGameMode('friendly_party_quiz'));
  });
  it('lets a host start 2–4 players of it, not 5', () => {
    expect(isValidHostStartShape('room_game', 4, 'football_race')).toBe(true);
    expect(isValidHostStartShape('room_game', 5, 'football_race')).toBe(false);
    expect(isValidHostStartShape('room_game', 5, 'name_chain')).toBe(true);
    expect(isValidHostStartShape('room_game', 1, 'football_race')).toBe(false);
  });
  it('never raises a ceiling', () => {
    expect(roomGameSeats('football_race', 3)).toBe(3);
    expect(roomGameSeats('unknown_game', 6)).toBe(6);
  });
});

describe('Football Horserace room options', () => {
  it('defaults to a random tournament and refuses anything else than an id or "random"', () => {
    expect(footballRaceRoomEngine.parseOptions(null)).toEqual({ tournament: 'random' });
    expect(footballRaceRoomEngine.parseOptions({ tournament: 'WC' })).toEqual({ tournament: 'WC' });
    expect(footballRaceRoomEngine.parseOptions({ tournament: 'wc; drop' })).toBeUndefined();
    expect(footballRaceRoomEngine.parseOptions({ tournament: 'WC', extra: 1 })).toBeUndefined();
  });
});
