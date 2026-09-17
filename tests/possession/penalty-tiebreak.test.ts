import { describe, expect, it } from 'vitest';
import { createInitialPossessionState } from '../../src/modules/matches/matches.service.js';
import type { CachedPlayer } from '../../src/realtime/match-cache.js';
import { applyPenaltyResolution } from '../../src/realtime/possession-resolution.js';
import type { Seat } from '../../src/realtime/possession-state.js';

// Penalty duel rule (product decision, 2026-09-17): a goal iff the shooter is
// correct and the keeper is wrong, OR the shooter out-scores the keeper on
// points. Both correct with EQUAL points is ALWAYS a save — no millisecond
// tie-break — so the score bar explains every outcome on its own.
//
// History: #575 broke point-ties on raw answer time because scoring is
// stepped in 10-point buckets with a full-points grace window, equally-good
// players tied constantly, and prod shootouts ran 18-40 kicks at 0-0 (23%
// exceeded the regulation 10). That tie-break is gone; the sudden-death cap
// (POSSESSION_MAX_SUDDEN_DEATH_ROUNDS, default 5 → a shootout ends by kick
// 20 at the latest) is now the guard against marathons.

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

describe('penalty duel: equal points is a save', () => {
  it('both correct with equal points and a FASTER shooter: SAVE (no time tie-break)', () => {
    const { outcome } = duel({
      shooter: { correct: true, timeMs: 769, points: 100 },
      keeper: { correct: true, timeMs: 935, points: 100 },
    });
    expect(outcome.goalScoredByUserId).toBeNull();
  });

  it('both correct with equal points and a SLOWER shooter: save', () => {
    const { outcome } = duel({
      shooter: { correct: true, timeMs: 935, points: 100 },
      keeper: { correct: true, timeMs: 769, points: 100 },
    });
    expect(outcome.goalScoredByUserId).toBeNull();
  });

  it('both correct with equal points and EXACTLY equal time: save', () => {
    const { outcome } = duel({
      shooter: { correct: true, timeMs: 1_000, points: 100 },
      keeper: { correct: true, timeMs: 1_000, points: 100 },
    });
    expect(outcome.goalScoredByUserId).toBeNull();
  });

  it('both correct, shooter has MORE points: goal, even when the shooter was slower on the clock', () => {
    const { outcome, shooterUserId } = duel({
      shooter: { correct: true, timeMs: 4_000, points: 70 },
      keeper: { correct: true, timeMs: 800, points: 60 },
    });
    expect(outcome.goalScoredByUserId).toBe(shooterUserId);
  });

  it('both correct, keeper has MORE points: save, even when the shooter was faster', () => {
    const { outcome } = duel({
      shooter: { correct: true, timeMs: 800, points: 60 },
      keeper: { correct: true, timeMs: 4_000, points: 70 },
    });
    expect(outcome.goalScoredByUserId).toBeNull();
  });

  it('correct shooter vs wrong keeper is a goal even at 0 points', () => {
    const { outcome, shooterUserId } = duel({
      shooter: { correct: true, timeMs: 9_900, points: 0 },
      keeper: { correct: false, timeMs: 1_000, points: 0 },
    });
    expect(outcome.goalScoredByUserId).toBe(shooterUserId);
  });

  it('correct shooter vs keeper timeout (no answer) is a goal', () => {
    const answers = new Map([
      ['seat-1', { is_correct: true, time_ms: 1_500, points_earned: 90 }],
    ]);
    const state = penaltyState();
    const outcome = applyPenaltyResolution(state, players(), answers, 1);
    expect(outcome.goalScoredByUserId).toBe('seat-1');
  });

  it('wrong shooter never scores, whatever the keeper did', () => {
    expect(duel({
      shooter: { correct: false, timeMs: 400, points: 0 },
      keeper: { correct: true, timeMs: 2_000, points: 80 },
    }).outcome.goalScoredByUserId).toBeNull();
    expect(duel({
      shooter: { correct: false, timeMs: 400, points: 0 },
      keeper: { correct: false, timeMs: 9_000, points: 0 },
    }).outcome.goalScoredByUserId).toBeNull();
  });

  it('shooter timeout (no answer) against a wrong keeper: still no goal', () => {
    const answers = new Map([
      ['seat-2', { is_correct: false, time_ms: 3_000, points_earned: 0 }],
    ]);
    const state = penaltyState();
    const outcome = applyPenaltyResolution(state, players(), answers, 1);
    expect(outcome.goalScoredByUserId).toBeNull();
  });

  it('two equally fast, always-correct players: every kick is a save and the cap ends it by kick 20', () => {
    // The marathon #575 fixed with the time tie-break. With equal points as a
    // save neither player can score, so the sudden-death cap (default 5 pairs
    // after the first 5 kicks each) is what terminates the shootout.
    const state = penaltyState();
    const cached = players();
    let shooterSeat: Seat = 1;
    let kicks = 0;
    let forced = false;
    while (state.phase === 'PENALTY_SHOOTOUT' && kicks < 60) {
      const keeperSeat: Seat = shooterSeat === 1 ? 2 : 1;
      const answers = new Map([
        [`seat-${shooterSeat}`, { is_correct: true, time_ms: 700, points_earned: 100 }],
        [`seat-${keeperSeat}`, { is_correct: true, time_ms: 900, points_earned: 100 }],
      ]);
      const outcome = applyPenaltyResolution(state, cached, answers, shooterSeat, 5);
      forced = outcome.forcedBySuddenDeathCap;
      kicks += 1;
      shooterSeat = state.penalty.shooterSeat;
    }
    expect(state.phase).toBe('COMPLETED');
    expect(forced).toBe(true);
    expect(kicks).toBe(20);
    expect(state.penaltyGoals).toEqual({ seat1: 0, seat2: 0 });
    expect(state.penalty.kicksTaken).toEqual({ seat1: 10, seat2: 10 });
  });
});
