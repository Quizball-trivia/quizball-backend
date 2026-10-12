import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FOOTBALL_GRID_SETTINGS,
  footballGridBotTargetRp,
  footballGridRoomRules,
  footballGridSeriesMaxGames,
  footballGridSeriesTargetWins,
  parseFootballGridSettings,
  storedFootballGridSettings,
} from '../../src/modules/football-grid/football-grid.settings.js';
import {
  createFootballGridState,
  acknowledgeHandoff,
  markReady,
  passTurn,
  startTurnAfterCountdown,
  FOOTBALL_GRID_COUNTDOWN_MS,
} from '../../src/modules/football-grid/football-grid.engine.js';
import type { FootballGridBoardView, FootballGridCriterionView } from '../../src/modules/football-grid/football-grid.types.js';

function criterion(id: string): FootballGridCriterionView {
  return { id, key: id, family: 'club', labelEn: id, labelKa: id, assetKey: null, difficulty: 'easy' };
}

const BOARD: FootballGridBoardView = {
  boardId: 'board', boardVersion: 1, checksum: 'x'.repeat(32),
  rows: [criterion('r1'), criterion('r2'), criterion('r3')],
  columns: [criterion('c1'), criterion('c2'), criterion('c3')],
};

describe('Football Tic Tac Toe settings', () => {
  it('stores nothing for the standard game and reads nothing back as the standard game', () => {
    expect(storedFootballGridSettings(DEFAULT_FOOTBALL_GRID_SETTINGS)).toBeNull();
    expect(parseFootballGridSettings(null)).toEqual(DEFAULT_FOOTBALL_GRID_SETTINGS);
    expect(parseFootballGridSettings({ turnSeconds: 'fast' })).toEqual(DEFAULT_FOOTBALL_GRID_SETTINGS);
  });

  it('round-trips a room\'s rules', () => {
    const { format, settings } = footballGridRoomRules({ rounds: 'bo5', turnSeconds: 20, answers: 'choice', difficulty: 'easy' });
    expect(format).toBe('bo5');
    expect(settings).toEqual({ turnMs: 20_000, answerMode: 'choice', boardDifficulty: 'easy' });
    expect(parseFootballGridSettings(storedFootballGridSettings(settings))).toEqual(settings);
  });

  it('plays the standard game when a room\'s options are missing or not ones it offers', () => {
    expect(footballGridRoomRules(null).format).toBe('bo3');
    expect(footballGridRoomRules(null).settings).toEqual(DEFAULT_FOOTBALL_GRID_SETTINGS);
    expect(footballGridRoomRules({ rounds: 'bo9' }).format).toBe('bo3');
    expect(footballGridRoomRules({ turnSeconds: 5 }).settings.turnMs).toBe(40_000);
    expect(footballGridRoomRules({ rounds: 'bo7', steals: 3 }).format).toBe('bo3');
  });

  it('knows how many wins and games each format takes', () => {
    expect([footballGridSeriesTargetWins('single'), footballGridSeriesMaxGames('single')]).toEqual([1, 1]);
    expect([footballGridSeriesTargetWins('bo3'), footballGridSeriesMaxGames('bo3')]).toEqual([2, 3]);
    expect([footballGridSeriesTargetWins('bo5'), footballGridSeriesMaxGames('bo5')]).toEqual([3, 5]);
    expect([footballGridSeriesTargetWins('bo7'), footballGridSeriesMaxGames('bo7')]).toEqual([4, 7]);
  });

  it('times every turn by the match\'s own turn length', () => {
    const players = [{ userId: 'a', seat: 1 as const }, { userId: 'b', seat: 2 as const }];
    let state = createFootballGridState({
      matchId: 'm', board: BOARD, players, openerUserId: 'a', nowMs: 0,
      settings: { ...DEFAULT_FOOTBALL_GRID_SETTINGS, turnMs: 20_000 },
    });
    state = acknowledgeHandoff(state, 'a', state.stateVersion, 0);
    state = acknowledgeHandoff(state, 'b', state.stateVersion, 0);
    state = markReady(state, 'a', state.stateVersion, 0);
    state = markReady(state, 'b', state.stateVersion, 0);
    state = startTurnAfterCountdown(state, state.stateVersion, FOOTBALL_GRID_COUNTDOWN_MS);
    expect(Date.parse(state.turnDeadlineAt!)).toBe(FOOTBALL_GRID_COUNTDOWN_MS + 20_000);
    state = passTurn(state, 'a', state.stateVersion, 30_000);
    expect(Date.parse(state.turnDeadlineAt!)).toBe(50_000);
    expect(state.turnRemainingMs).toBe(20_000);
  });
});

describe('Football Tic Tac Toe bot level', () => {
  const record = (finished: number, wins: number, losses: number) => ({ finished, wins, losses });

  it('starts a newcomer against a Youth Prospect bot whatever their quiz ranking', () => {
    expect(footballGridBotTargetRp({ rankedTargetRp: 1900, placed: false, experience: record(0, 0, 0) })).toBe(450);
    expect(footballGridBotTargetRp({ rankedTargetRp: 4200, placed: true, experience: record(0, 0, 0) })).toBe(450);
  });

  it('moves one step per net win and never above a placed player\'s own level', () => {
    expect(footballGridBotTargetRp({ rankedTargetRp: 1900, placed: false, experience: record(3, 3, 0) })).toBe(1500);
    expect(footballGridBotTargetRp({ rankedTargetRp: 700, placed: true, experience: record(3, 3, 0) })).toBe(700);
    expect(footballGridBotTargetRp({ rankedTargetRp: 1900, placed: false, experience: record(4, 0, 4) })).toBe(300);
  });

  it('hands a placed player to their ranked level after ten games, and keeps an unplaced one on the ladder', () => {
    expect(footballGridBotTargetRp({ rankedTargetRp: 3100, placed: true, experience: record(10, 5, 5) })).toBe(3100);
    expect(footballGridBotTargetRp({ rankedTargetRp: 1900, placed: false, experience: record(10, 5, 5) })).toBe(450);
    expect(footballGridBotTargetRp({ rankedTargetRp: 1900, placed: false, experience: record(10, 10, 0) })).toBe(2700);
  });
});
