import { describe, expect, it } from 'vitest';
import '../setup.js';
import { decideWinnerFromProgress } from '../../src/realtime/possession-completion.js';
import { createInitialPossessionState } from '../../src/modules/matches/matches.service.js';

function players(overrides: {
  seat1?: { totalPoints?: number; correctAnswers?: number };
  seat2?: { totalPoints?: number; correctAnswers?: number };
} = {}) {
  return [
    {
      user_id: 'u1',
      seat: 1,
      total_points: overrides.seat1?.totalPoints ?? 0,
      correct_answers: overrides.seat1?.correctAnswers ?? 0,
    },
    {
      user_id: 'u2',
      seat: 2,
      total_points: overrides.seat2?.totalPoints ?? 0,
      correct_answers: overrides.seat2?.correctAnswers ?? 0,
    },
  ];
}

describe('decideWinnerFromProgress', () => {
  it('uses goals before all fallback signals', () => {
    const state = createInitialPossessionState('ranked_sim');
    state.goals = { seat1: 1, seat2: 0 };

    expect(decideWinnerFromProgress(players({
      seat1: { totalPoints: 100, correctAnswers: 1 },
      seat2: { totalPoints: 900, correctAnswers: 9 },
    }), state)).toEqual({
      winnerId: 'u1',
      method: 'goals',
      totalPointsFallbackUsed: false,
      basis: 'goals',
    });
  });

  it('uses penalty goals after tied goals', () => {
    const state = createInitialPossessionState('ranked_sim');
    state.penaltyGoals = { seat1: 1, seat2: 2 };

    expect(decideWinnerFromProgress(players(), state)).toEqual({
      winnerId: 'u2',
      method: 'penalty_goals',
      totalPointsFallbackUsed: false,
      basis: 'penalty_goals',
    });
  });

  it('uses total points after tied goals and penalties', () => {
    const state = createInitialPossessionState('ranked_sim');

    expect(decideWinnerFromProgress(players({
      seat1: { totalPoints: 120, correctAnswers: 1 },
      seat2: { totalPoints: 200, correctAnswers: 0 },
    }), state)).toEqual({
      winnerId: 'u2',
      method: 'total_points_fallback',
      totalPointsFallbackUsed: true,
      basis: 'total_points',
    });
  });

  it('maps correct-answer fallback to the public total_points_fallback method', () => {
    const state = createInitialPossessionState('ranked_sim');

    expect(decideWinnerFromProgress(players({
      seat1: { totalPoints: 100, correctAnswers: 4 },
      seat2: { totalPoints: 100, correctAnswers: 3 },
    }), state)).toEqual({
      winnerId: 'u1',
      method: 'total_points_fallback',
      totalPointsFallbackUsed: true,
      basis: 'correct_answers',
    });
  });

  it('returns null when progress cannot decide a winner', () => {
    const state = createInitialPossessionState('ranked_sim');

    expect(decideWinnerFromProgress(players({
      seat1: { totalPoints: 100, correctAnswers: 3 },
      seat2: { totalPoints: 100, correctAnswers: 3 },
    }), state)).toBeNull();
  });
});
