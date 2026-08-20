import { describe, expect, it } from 'vitest';
import {
  FOOTBALL_GRID_COUNTDOWN_MS,
  FOOTBALL_GRID_TURN_MS,
  FOOTBALL_GRID_WIN_LINES,
  acknowledgeHandoff,
  applyResolvedAnswer,
  createFootballGridState,
  expireTurn,
  markReady,
  passTurn,
  pauseForDisconnect,
  resumeAfterReconnect,
  startTurnAfterCountdown,
  type FootballGridBoardView,
  type FootballGridState,
} from '../../src/modules/football-grid/index.js';

const criterion = (id: string) => ({
  id,
  key: id,
  family: 'club' as const,
  labelEn: id,
  labelKa: id,
  assetKey: null,
  difficulty: 'normal' as const,
});

const board: FootballGridBoardView = {
  boardId: 'board-1',
  boardVersion: 1,
  checksum: 'checksum',
  rows: [criterion('r1'), criterion('r2'), criterion('r3')],
  columns: [criterion('c1'), criterion('c2'), criterion('c3')],
};

function activeState(nowMs = 1_000): FootballGridState {
  const handoff = createFootballGridState({
    matchId: 'match-1',
    board,
    players: [
      { userId: 'u1', seat: 1 },
      { userId: 'u2', seat: 2 },
    ],
    openerUserId: 'u1',
    nowMs,
  });
  const h1 = acknowledgeHandoff(handoff, 'u1', handoff.stateVersion, nowMs + 1);
  const h2 = acknowledgeHandoff(h1, 'u2', h1.stateVersion, nowMs + 2);
  const r1 = markReady(h2, 'u1', h2.stateVersion, nowMs + 3);
  const r2 = markReady(r1, 'u2', r1.stateVersion, nowMs + 4);
  return startTurnAfterCountdown(r2, r2.stateVersion, nowMs + 4 + FOOTBALL_GRID_COUNTDOWN_MS);
}

function countdownState(nowMs = 1_000): FootballGridState {
  const handoff = createFootballGridState({
    matchId: 'match-countdown', board,
    players: [{ userId: 'u1', seat: 1 }, { userId: 'u2', seat: 2 }],
    openerUserId: 'u1', nowMs,
  });
  const h1 = acknowledgeHandoff(handoff, 'u1', handoff.stateVersion, nowMs + 1);
  const h2 = acknowledgeHandoff(h1, 'u2', h1.stateVersion, nowMs + 2);
  const r1 = markReady(h2, 'u1', h2.stateVersion, nowMs + 3);
  return markReady(r1, 'u2', r1.stateVersion, nowMs + 4);
}

describe('football grid engine', () => {
  it('uses the two-client ready barrier before starting the opener turn', () => {
    const state = activeState();
    expect(state.status).toBe('active');
    expect(state.phase).toBe('turn');
    expect(state.currentPlayerUserId).toBe('u1');
    expect(Date.parse(state.turnDeadlineAt!)).toBe(1_004 + FOOTBALL_GRID_COUNTDOWN_MS + FOOTBALL_GRID_TURN_MS);
  });

  it.each(FOOTBALL_GRID_WIN_LINES.map((line) => [line] as const))(
    'completes every win line %j immediately',
    (line) => {
    const state = activeState();
    state.claims = [
      { cellIndex: line[0], footballPlayerId: `p-${line[0]}`, claimantUserId: 'u1', turnNumber: 0 },
      { cellIndex: line[1], footballPlayerId: `p-${line[1]}`, claimantUserId: 'u1', turnNumber: 2 },
    ];
    const result = applyResolvedAnswer(state, {
      userId: 'u1',
      expectedStateVersion: state.stateVersion,
      cellIndex: line[2],
      outcome: 'correct',
      footballPlayerId: `p-${line[2]}`,
      nowMs: 50_000,
    });
    expect(result.status).toBe('completed');
    expect(result.winnerUserId).toBe('u1');
    expect(result.completionReason).toBe('line');
    },
  );

  it('draws when the ninth distinct claim fills the board without a line', () => {
    const state = activeState();
    state.claims = [
      [0, 'u1'], [1, 'u2'], [2, 'u1'],
      [3, 'u1'], [4, 'u2'], [5, 'u2'],
      [6, 'u2'], [7, 'u1'],
    ].map(([cell, userId], turnNumber) => ({
      cellIndex: Number(cell),
      footballPlayerId: `p-${cell}`,
      claimantUserId: String(userId),
      turnNumber,
    }));
    const result = applyResolvedAnswer(state, {
      userId: 'u1', expectedStateVersion: state.stateVersion, cellIndex: 8,
      outcome: 'correct', footballPlayerId: 'p-8', nowMs: 50_000,
    });
    expect(result.status).toBe('completed');
    expect(result.winnerUserId).toBeNull();
    expect(result.completionReason).toBe('board_full');
  });

  it('does not transition state for an ambiguous answer', () => {
    const state = activeState();
    const result = applyResolvedAnswer(state, {
      userId: 'u1', expectedStateVersion: state.stateVersion, cellIndex: 0,
      outcome: 'ambiguous', footballPlayerId: null, nowMs: 50_000,
    });
    expect(result).toEqual(state);
    expect(result).not.toBe(state);
  });

  it('ends a turn for wrong, already-used, and pass outcomes', () => {
    for (const outcome of ['wrong', 'already_used'] as const) {
      const state = activeState();
      const result = applyResolvedAnswer(state, {
        userId: 'u1', expectedStateVersion: state.stateVersion, cellIndex: 0,
        outcome, footballPlayerId: outcome === 'already_used' ? 'p-used' : null, nowMs: 50_000,
      });
      expect(result.currentPlayerUserId).toBe('u2');
      expect(result.turnNumber).toBe(1);
    }
    const state = activeState();
    expect(passTurn(state, 'u1', state.stateVersion, 50_000).currentPlayerUserId).toBe('u2');
  });

  it('forfeits after the same player reaches three no-action timeouts', () => {
    const state = activeState();
    state.players[0].noActionTimeouts = 2;
    const result = expireTurn(state, state.stateVersion, 50_000);
    expect(result.status).toBe('forfeited');
    expect(result.winnerUserId).toBe('u2');
    expect(result.completionReason).toBe('no_action_timeouts');
  });

  it('does not count a timeout as no-action after an ambiguous attempt', () => {
    const state = activeState();
    state.players[0].noActionTimeouts = 2;
    const result = expireTurn(state, state.stateVersion, 50_000, { hadActivity: true });
    expect(result.status).toBe('active');
    expect(result.players[0].noActionTimeouts).toBe(0);
  });

  it('preserves remaining turn time across a disconnect pause', () => {
    const state = activeState(1_000);
    const originalDeadline = Date.parse(state.turnDeadlineAt!);
    const pausedAt = originalDeadline - 7_000;
    const paused = pauseForDisconnect(state, pausedAt, pausedAt + 30_000);
    expect(paused.turnRemainingMs).toBe(7_000);
    const resumed = resumeAfterReconnect(paused, pausedAt + 5_000);
    expect(Date.parse(resumed.turnDeadlineAt!)).toBe(pausedAt + 12_000);
  });

  it('resumes a paused countdown before opening the first turn', () => {
    const state = countdownState();
    const pausedAt = Date.parse(state.phaseDeadlineAt!) - 1_500;
    const paused = pauseForDisconnect(state, pausedAt, pausedAt + 30_000);
    expect(paused.pausedFromPhase).toBe('countdown');
    expect(paused.turnRemainingMs).toBe(1_500);
    const resumedAt = pausedAt + 2_000;
    const resumed = resumeAfterReconnect(paused, resumedAt);
    expect(resumed.phase).toBe('countdown');
    expect(resumed.currentPlayerUserId).toBeNull();
    expect(Date.parse(resumed.phaseDeadlineAt!)).toBe(resumedAt + 1_500);
  });
});
