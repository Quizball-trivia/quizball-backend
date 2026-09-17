import { describe, expect, it } from 'vitest';
import { createInitialPossessionState } from '../../src/modules/matches/matches.service.js';
import type { CachedPlayer } from '../../src/realtime/match-cache.js';
import { applyPenaltyResolution } from '../../src/realtime/possession-resolution.js';
import { config } from '../../src/core/config.js';
import { decideWinner } from '../../src/realtime/possession-completion.js';

function players(): CachedPlayer[] {
  return [
    {
      userId: 'seat-1',
      seat: 1,
      totalPoints: 400,
      correctAnswers: 4,
      goals: 0,
      penaltyGoals: 0,
      avgTimeMs: null,
    },
    {
      userId: 'seat-2',
      seat: 2,
      totalPoints: 300,
      correctAnswers: 3,
      goals: 0,
      penaltyGoals: 0,
      avgTimeMs: null,
    },
  ];
}

function tiedSuddenDeathState() {
  const state = createInitialPossessionState('ranked_sim');
  state.phase = 'PENALTY_SHOOTOUT';
  state.penalty = {
    round: 11,
    shooterSeat: 1,
    suddenDeath: true,
    kicksTaken: { seat1: 5, seat2: 5 },
    attempts: {
      seat1: ['miss', 'miss', 'miss', 'miss', 'miss'],
      seat2: ['miss', 'miss', 'miss', 'miss', 'miss'],
    },
  };
  return state;
}

const missedAnswers = new Map([
  ['seat-1', { is_correct: false, time_ms: 1_000 }],
  ['seat-2', { is_correct: false, time_ms: 1_000 }],
]);

describe('penalty sudden-death rounds before the draw', () => {
  it('N = 1: still level after one extra pair (6 each) -> draw; not before both took the extra kick', () => {
    const state = tiedSuddenDeathState();
    const roster = players();

    const first = applyPenaltyResolution(state, roster, missedAnswers, 1, 1);
    expect(first.shootoutDrawn).toBe(false);
    expect(state.phase).toBe('PENALTY_SHOOTOUT');
    expect(state.penalty.kicksTaken).toEqual({ seat1: 6, seat2: 5 });

    const second = applyPenaltyResolution(state, roster, missedAnswers, 2, 1);
    expect(second.shootoutDrawn).toBe(true);
    expect(second.goalScoredByUserId).toBeNull();
    expect(state.phase).toBe('COMPLETED');
    expect(state.penalty.kicksTaken).toEqual({ seat1: 6, seat2: 6 });
  });

  it('default 0: a level shootout at 5 each is already a draw (no sudden death at all)', () => {
    expect(config.POSSESSION_MAX_SUDDEN_DEATH_ROUNDS).toBe(0);
    const state = tiedSuddenDeathState();
    state.penalty.suddenDeath = false;
    state.penalty.kicksTaken = { seat1: 5, seat2: 4 };
    const result = applyPenaltyResolution(state, players(), missedAnswers, 2, config.POSSESSION_MAX_SUDDEN_DEATH_ROUNDS);
    expect(result.shootoutDrawn).toBe(true);
    expect(state.phase).toBe('COMPLETED');
    expect(state.penalty.kicksTaken).toEqual({ seat1: 5, seat2: 5 });
  });

  it('there is no unlimited setting: with 0 a level pair beyond regulation is a draw, never more kicks', () => {
    // (A 5/5 level state can only sit mid-shootout when sudden death was
    // allowed; from there, 0 draws at the very next completed level pair.)
    const state = tiedSuddenDeathState();
    const roster = players();
    expect(applyPenaltyResolution(state, roster, missedAnswers, 1, 0).shootoutDrawn).toBe(false);
    expect(state.phase).toBe('PENALTY_SHOOTOUT');
    expect(applyPenaltyResolution(state, roster, missedAnswers, 2, 0).shootoutDrawn).toBe(true);
    expect(state.phase).toBe('COMPLETED');
    expect(state.penalty.kicksTaken).toEqual({ seat1: 6, seat2: 6 });
  });
});

describe('decideWinner fallback chain (non-shootout natural completions only)', () => {
  // Shootouts never reach this chain any more (a level shootout is a draw);
  // it still serves the other natural completions and stays symmetric.
  const level = () => {
    const state = tiedSuddenDeathState();
    state.penalty.kicksTaken = { seat1: 10, seat2: 10 };
    return state;
  };
  const rows = (p1: number, p2: number, c1: number, c2: number) => [
    { user_id: 'seat-1', seat: 1, total_points: p1, correct_answers: c1 },
    { user_id: 'seat-2', seat: 2, total_points: p2, correct_answers: c2 },
  ];

  it('total points decide, symmetrically', () => {
    expect(decideWinner(rows(400, 300, 4, 3), level())).toMatchObject({ winnerId: 'seat-1', method: 'total_points_fallback' });
    expect(decideWinner(rows(300, 400, 4, 3), level())).toMatchObject({ winnerId: 'seat-2', method: 'total_points_fallback' });
  });

  it('then correct answers, symmetrically; then seat 1 as the last resort', () => {
    expect(decideWinner(rows(400, 400, 5, 4), level()).winnerId).toBe('seat-1');
    expect(decideWinner(rows(400, 400, 4, 5), level()).winnerId).toBe('seat-2');
    expect(decideWinner(rows(400, 400, 4, 4), level()).winnerId).toBe('seat-1');
  });
});
