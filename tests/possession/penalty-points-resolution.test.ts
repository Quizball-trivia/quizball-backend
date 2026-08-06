import { describe, expect, it } from 'vitest';
import { createInitialPossessionState } from '../../src/modules/matches/matches.service.js';
import type { CachedPlayer } from '../../src/realtime/match-cache.js';
import { applyPenaltyResolution } from '../../src/realtime/possession-resolution.js';
import type { Seat } from '../../src/realtime/possession-state.js';

function players(): CachedPlayer[] {
  return [
    {
      userId: 'seat-1',
      seat: 1,
      totalPoints: 0,
      correctAnswers: 0,
      goals: 0,
      penaltyGoals: 0,
      avgTimeMs: null,
    },
    {
      userId: 'seat-2',
      seat: 2,
      totalPoints: 0,
      correctAnswers: 0,
      goals: 0,
      penaltyGoals: 0,
      avgTimeMs: null,
    },
  ];
}

function penaltyState() {
  const state = createInitialPossessionState('ranked_sim');
  state.phase = 'PENALTY_SHOOTOUT';
  return state;
}

function answers(seat1Points: number, seat2Points: number) {
  return new Map([
    [
      'seat-1',
      {
        is_correct: seat1Points > 0,
        time_ms: 5_000,
        points_earned: seat1Points,
      },
    ],
    [
      'seat-2',
      {
        is_correct: seat2Points > 0,
        time_ms: 500,
        points_earned: seat2Points,
      },
    ],
  ]);
}

describe('penalty points resolution', () => {
  it.each([
    { shooterSeat: 1 as Seat, seat1Points: 80, seat2Points: 70, scorer: 'seat-1' },
    { shooterSeat: 2 as Seat, seat1Points: 70, seat2Points: 80, scorer: 'seat-2' },
  ])('scores when the shooter has more points: $shooterSeat', ({
    shooterSeat,
    seat1Points,
    seat2Points,
    scorer,
  }) => {
    const state = penaltyState();
    const result = applyPenaltyResolution(
      state,
      players(),
      answers(seat1Points, seat2Points),
      shooterSeat
    );

    expect(result.goalScoredByUserId).toBe(scorer);
    expect(state.penaltyGoals[`seat${shooterSeat}`]).toBe(1);
    expect(state.penalty.attempts?.[`seat${shooterSeat}`]).toEqual(['goal']);
  });

  it.each([
    { shooterSeat: 1 as Seat, seat1Points: 70, seat2Points: 80 },
    { shooterSeat: 2 as Seat, seat1Points: 80, seat2Points: 70 },
  ])('is saved when the keeper has more points: $shooterSeat', ({
    shooterSeat,
    seat1Points,
    seat2Points,
  }) => {
    const state = penaltyState();
    const result = applyPenaltyResolution(
      state,
      players(),
      answers(seat1Points, seat2Points),
      shooterSeat
    );

    expect(result.goalScoredByUserId).toBeNull();
    expect(state.penaltyGoals).toEqual({ seat1: 0, seat2: 0 });
    expect(state.penalty.attempts?.[`seat${shooterSeat}`]).toEqual(['miss']);
  });

  it.each([1, 2] as const)('gives a 100–100 tie to the keeper: shooter seat %s', (shooterSeat) => {
    const state = penaltyState();
    const result = applyPenaltyResolution(state, players(), answers(100, 100), shooterSeat);

    expect(result.goalScoredByUserId).toBeNull();
    expect(state.penaltyGoals).toEqual({ seat1: 0, seat2: 0 });
    expect(state.penalty.attempts?.[`seat${shooterSeat}`]).toEqual(['miss']);
  });
});
