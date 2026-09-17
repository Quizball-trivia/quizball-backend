import { describe, expect, it } from 'vitest';
import { createInitialPossessionState } from '../../src/modules/matches/matches.service.js';
import type { CachedPlayer } from '../../src/realtime/match-cache.js';
import { applyPenaltyResolution } from '../../src/realtime/possession-resolution.js';
import type { Seat } from '../../src/realtime/possession-state.js';

// Clients only receive `deltas.penaltyOutcome: 'goal' | 'saved'`, so a
// keeper who answered correctly but lost on speed sees an unexplained goal.
// The resolution must say WHY the duel went the way it did.

function players(): CachedPlayer[] {
  return [
    { userId: 'seat-1', seat: 1, totalPoints: 0, correctAnswers: 0, goals: 0, penaltyGoals: 0, avgTimeMs: null },
    { userId: 'seat-2', seat: 2, totalPoints: 0, correctAnswers: 0, goals: 0, penaltyGoals: 0, avgTimeMs: null },
  ];
}

function duel(params: {
  shooter: { correct: boolean; timeMs: number; points: number } | null;
  keeper: { correct: boolean; timeMs: number; points: number } | null;
}) {
  const shooterSeat: Seat = 1;
  const answers = new Map<string, { is_correct: boolean; time_ms: number; points_earned: number }>();
  if (params.shooter) {
    answers.set('seat-1', {
      is_correct: params.shooter.correct,
      time_ms: params.shooter.timeMs,
      points_earned: params.shooter.points,
    });
  }
  if (params.keeper) {
    answers.set('seat-2', {
      is_correct: params.keeper.correct,
      time_ms: params.keeper.timeMs,
      points_earned: params.keeper.points,
    });
  }
  const state = createInitialPossessionState('ranked_sim');
  state.phase = 'PENALTY_SHOOTOUT';
  return applyPenaltyResolution(state, players(), answers, shooterSeat);
}

describe('applyPenaltyResolution outcome reason', () => {
  it('shooter_missed when the shooter is wrong, whatever the keeper did', () => {
    expect(duel({
      shooter: { correct: false, timeMs: 500, points: 0 },
      keeper: { correct: true, timeMs: 2_000, points: 80 },
    })).toMatchObject({ goalScoredByUserId: null, penaltyOutcomeReason: 'shooter_missed' });

    expect(duel({
      shooter: { correct: false, timeMs: 500, points: 0 },
      keeper: { correct: false, timeMs: 9_000, points: 0 },
    })).toMatchObject({ goalScoredByUserId: null, penaltyOutcomeReason: 'shooter_missed' });

    // Shooter timeout (no answer at all) is a miss too.
    expect(duel({
      shooter: null,
      keeper: { correct: true, timeMs: 900, points: 100 },
    })).toMatchObject({ goalScoredByUserId: null, penaltyOutcomeReason: 'shooter_missed' });
  });

  it('keeper_missed when the shooter is correct and the keeper is wrong', () => {
    expect(duel({
      shooter: { correct: true, timeMs: 9_900, points: 0 },
      keeper: { correct: false, timeMs: 1_000, points: 0 },
    })).toMatchObject({ goalScoredByUserId: 'seat-1', penaltyOutcomeReason: 'keeper_missed' });

    expect(duel({
      shooter: { correct: true, timeMs: 1_500, points: 90 },
      keeper: null,
    })).toMatchObject({ goalScoredByUserId: 'seat-1', penaltyOutcomeReason: 'keeper_missed' });
  });

  it('shooter_faster when both are correct and the shooter wins on points or on the time tie-break', () => {
    expect(duel({
      shooter: { correct: true, timeMs: 800, points: 100 },
      keeper: { correct: true, timeMs: 2_500, points: 80 },
    })).toMatchObject({ goalScoredByUserId: 'seat-1', penaltyOutcomeReason: 'shooter_faster' });

    expect(duel({
      shooter: { correct: true, timeMs: 769, points: 100 },
      keeper: { correct: true, timeMs: 935, points: 100 },
    })).toMatchObject({ goalScoredByUserId: 'seat-1', penaltyOutcomeReason: 'shooter_faster' });
  });

  it('keeper_faster when both are correct and the keeper wins on points or on the time tie-break', () => {
    expect(duel({
      shooter: { correct: true, timeMs: 2_500, points: 80 },
      keeper: { correct: true, timeMs: 800, points: 100 },
    })).toMatchObject({ goalScoredByUserId: null, penaltyOutcomeReason: 'keeper_faster' });

    expect(duel({
      shooter: { correct: true, timeMs: 935, points: 100 },
      keeper: { correct: true, timeMs: 769, points: 100 },
    })).toMatchObject({ goalScoredByUserId: null, penaltyOutcomeReason: 'keeper_faster' });
  });

  it('keeper_faster on an exact points-and-time tie (keeper keeps the edge)', () => {
    expect(duel({
      shooter: { correct: true, timeMs: 1_000, points: 100 },
      keeper: { correct: true, timeMs: 1_000, points: 100 },
    })).toMatchObject({ goalScoredByUserId: null, penaltyOutcomeReason: 'keeper_faster' });
  });
});
