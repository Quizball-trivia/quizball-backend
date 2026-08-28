import { describe, expect, it } from 'vitest';
import { createInitialPossessionState } from '../../src/modules/matches/matches.service.js';
import type { CachedPlayer } from '../../src/realtime/match-cache.js';
import { applyPenaltyResolution } from '../../src/realtime/possession-resolution.js';
import type { Seat } from '../../src/realtime/possession-state.js';

// Reproduces the "0-0 marathon" bug reported from prod (match 2e85cbbb…):
// scoring is stepped in 10-point buckets with a 500ms full-points grace
// window, so two players who both answer correctly and fast land on IDENTICAL
// points round after round. With ties resolving as a save, neither player can
// EVER score — 23% of prod shootouts exceeded the regulation 10 kicks, the
// worst reaching 40. The fix breaks point-ties on raw answer time: the
// faster correct answer wins the duel; an exact time tie stays a save.

function players(): CachedPlayer[] {
  return [
    { userId: 'seat-1', seat: 1, totalPoints: 0, correctAnswers: 0, goals: 0, penaltyGoals: 0, avgTimeMs: null },
    { userId: 'seat-2', seat: 2, totalPoints: 0, correctAnswers: 0, goals: 0, penaltyGoals: 0, avgTimeMs: null },
  ];
}

function penaltyState() {
  const state = createInitialPossessionState('ranked_sim');
  state.phase = 'PENALTY_SHOOTOUT';
  return state;
}

function duel(params: {
  shooter: { correct: boolean; timeMs: number; points: number };
  keeper: { correct: boolean; timeMs: number; points: number };
  shooterSeat?: Seat;
}) {
  const shooterSeat: Seat = params.shooterSeat ?? 1;
  const keeperSeat: Seat = shooterSeat === 1 ? 2 : 1;
  const answers = new Map([
    [`seat-${shooterSeat}`, {
      is_correct: params.shooter.correct,
      time_ms: params.shooter.timeMs,
      points_earned: params.shooter.points,
    }],
    [`seat-${keeperSeat}`, {
      is_correct: params.keeper.correct,
      time_ms: params.keeper.timeMs,
      points_earned: params.keeper.points,
    }],
  ]);
  const state = penaltyState();
  const outcome = applyPenaltyResolution(state, players(), answers, shooterSeat);
  return { state, outcome, shooterUserId: `seat-${shooterSeat}` };
}

describe('penalty duel tie-break on answer time', () => {
  it('both correct with equal points: FASTER shooter scores (prod repro: both <1s → both 100pts)', () => {
    const { outcome, shooterUserId } = duel({
      shooter: { correct: true, timeMs: 769, points: 100 },
      keeper: { correct: true, timeMs: 935, points: 100 },
    });
    expect(outcome.goalScoredByUserId).toBe(shooterUserId);
  });

  it('both correct with equal points: SLOWER shooter is saved', () => {
    const { outcome } = duel({
      shooter: { correct: true, timeMs: 935, points: 100 },
      keeper: { correct: true, timeMs: 769, points: 100 },
    });
    expect(outcome.goalScoredByUserId).toBeNull();
  });

  it('both correct with equal points and EXACTLY equal time: save (keeper keeps the edge)', () => {
    const { outcome } = duel({
      shooter: { correct: true, timeMs: 1_000, points: 100 },
      keeper: { correct: true, timeMs: 1_000, points: 100 },
    });
    expect(outcome.goalScoredByUserId).toBeNull();
  });

  it('both wrong: never a goal, regardless of speed', () => {
    const { outcome } = duel({
      shooter: { correct: false, timeMs: 400, points: 0 },
      keeper: { correct: false, timeMs: 9_000, points: 0 },
    });
    expect(outcome.goalScoredByUserId).toBeNull();
  });

  it('shooter timeout (no answer) against a wrong keeper: still no goal', () => {
    const shooterSeat: Seat = 1;
    const answers = new Map([
      ['seat-2', { is_correct: false, time_ms: 3_000, points_earned: 0 }],
    ]);
    const state = penaltyState();
    const outcome = applyPenaltyResolution(state, players(), answers, shooterSeat);
    expect(outcome.goalScoredByUserId).toBeNull();
  });

  it('tie-break never overrides a points win: keeper with FEWER points but faster time still concedes', () => {
    const { outcome, shooterUserId } = duel({
      shooter: { correct: true, timeMs: 4_000, points: 70 },
      keeper: { correct: true, timeMs: 800, points: 60 },
    });
    // Slower shooter, but strictly more points — points stay authoritative.
    expect(outcome.goalScoredByUserId).toBe(shooterUserId);
  });

  it('correct shooter vs wrong keeper stays a goal even at 0 points (existing rule preserved)', () => {
    const { outcome, shooterUserId } = duel({
      shooter: { correct: true, timeMs: 9_900, points: 0 },
      keeper: { correct: false, timeMs: 1_000, points: 0 },
    });
    expect(outcome.goalScoredByUserId).toBe(shooterUserId);
  });

  it('a consistently faster player now wins in regulation instead of a 0-0 marathon', () => {
    // Regression for the marathon itself, modelled on the prod match: both
    // players always correct and always inside the full-points grace bucket,
    // one consistently ~200ms quicker. Pre-fix every duel was a 100-100 tie →
    // save → 0-0 forever (prod: 18-40 kicks). Post-fix the quicker player
    // scores as shooter AND saves as keeper, so the shootout resolves inside
    // regulation via the mercy rule.
    const state = penaltyState();
    const cached = players();
    const timeFor = (userId: string) => (userId === 'seat-1' ? 700 : 900);
    let shooterSeat: Seat = 1;
    let kicks = 0;
    while (state.phase === 'PENALTY_SHOOTOUT' && kicks < 30) {
      const keeperSeat: Seat = shooterSeat === 1 ? 2 : 1;
      const answers = new Map([
        [`seat-${shooterSeat}`, { is_correct: true, time_ms: timeFor(`seat-${shooterSeat}`), points_earned: 100 }],
        [`seat-${keeperSeat}`, { is_correct: true, time_ms: timeFor(`seat-${keeperSeat}`), points_earned: 100 }],
      ]);
      applyPenaltyResolution(state, cached, answers, shooterSeat);
      kicks += 1;
      shooterSeat = state.penalty.shooterSeat;
    }
    expect(state.phase).toBe('COMPLETED');
    // Seat 1 scores every kick, seat 2 never does — the mercy rule
    // (p1 > p2 + remaining2) ends it well inside the regulation 10.
    expect(state.penaltyGoals.seat1).toBeGreaterThan(state.penaltyGoals.seat2);
    expect(kicks).toBeLessThanOrEqual(10);
  });
});
