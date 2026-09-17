import { describe, expect, it } from 'vitest';
import { config } from '../../src/core/config.js';
import { createInitialPossessionState } from '../../src/modules/matches/matches.service.js';
import type { CachedPlayer } from '../../src/realtime/match-cache.js';
import { applyPenaltyResolution, isShootoutDraw } from '../../src/realtime/possession-resolution.js';
import type { Seat } from '../../src/realtime/possession-state.js';

// Product rule (2026-09-17): after the regulation 5 kicks each, a level
// shootout is a DRAW. POSSESSION_MAX_SUDDEN_DEATH_ROUNDS is the number of
// sudden-death PAIRS played before the draw is declared: 0 (default) = draw
// straight after 5 each, N = up to N extra pairs, then draw. The old forced
// fallback (total points → correct answers → seat 1) is gone for shootouts.

function players(): CachedPlayer[] {
  return [
    { userId: 'seat-1', seat: 1, totalPoints: 400, correctAnswers: 4, goals: 1, penaltyGoals: 0, avgTimeMs: null },
    { userId: 'seat-2', seat: 2, totalPoints: 300, correctAnswers: 3, goals: 1, penaltyGoals: 0, avgTimeMs: null },
  ];
}

function shootoutState() {
  const state = createInitialPossessionState('ranked_sim');
  state.phase = 'PENALTY_SHOOTOUT';
  state.goals = { seat1: 1, seat2: 1 };
  state.penalty.round = 1;
  return state;
}

/** Every kick a save (both correct, equal points) until the shootout ends. */
function playAllSaves(maxSuddenDeathRounds: number) {
  const state = shootoutState();
  const roster = players();
  let shooter: Seat = 1;
  let kicks = 0;
  let last = { goalScoredByUserId: null as string | null, shootoutDrawn: false };
  while (state.phase === 'PENALTY_SHOOTOUT' && kicks < 60) {
    const keeper: Seat = shooter === 1 ? 2 : 1;
    const answers = new Map([
      [`seat-${shooter}`, { is_correct: true, time_ms: 700, points_earned: 100 }],
      [`seat-${keeper}`, { is_correct: true, time_ms: 900, points_earned: 100 }],
    ]);
    last = applyPenaltyResolution(state, roster, answers, shooter, maxSuddenDeathRounds);
    shooter = state.penalty.shooterSeat;
    kicks += 1;
  }
  return { state, kicks, last };
}

describe('penalty shootout draw', () => {
  it('ships with no sudden death by default (POSSESSION_MAX_SUDDEN_DEATH_ROUNDS = 0)', () => {
    expect(config.POSSESSION_MAX_SUDDEN_DEATH_ROUNDS).toBe(0);
  });

  it('level after the regulation 5 kicks each with the default config: draw, no fallback winner', () => {
    const { state, kicks, last } = playAllSaves(config.POSSESSION_MAX_SUDDEN_DEATH_ROUNDS);
    expect(kicks).toBe(10);
    expect(state.phase).toBe('COMPLETED');
    expect(last.shootoutDrawn).toBe(true);
    expect(last.goalScoredByUserId).toBeNull();
    expect(state.penaltyGoals).toEqual({ seat1: 0, seat2: 0 });
    expect(state.penalty.kicksTaken).toEqual({ seat1: 5, seat2: 5 });
    expect(isShootoutDraw(state)).toBe(true);
  });

  it('with N = 2 sudden-death rounds: still level after 7 each -> draw', () => {
    const { state, kicks, last } = playAllSaves(2);
    expect(kicks).toBe(14);
    expect(state.phase).toBe('COMPLETED');
    expect(last.shootoutDrawn).toBe(true);
    expect(state.penalty.suddenDeath).toBe(true);
    expect(state.penalty.kicksTaken).toEqual({ seat1: 7, seat2: 7 });
  });

  it('a decided shootout is unchanged: the side ahead after 5 each wins, not drawn', () => {
    const state = shootoutState();
    const roster = players();
    let shooter: Seat = 1;
    let last = { goalScoredByUserId: null as string | null, shootoutDrawn: false };
    let kicks = 0;
    while (state.phase === 'PENALTY_SHOOTOUT' && kicks < 60) {
      const keeper: Seat = shooter === 1 ? 2 : 1;
      // Seat 1 always scores (keeper wrong), seat 2 is always saved.
      const answers = new Map([
        [`seat-${shooter}`, { is_correct: true, time_ms: 900, points_earned: 90 }],
        [`seat-${keeper}`, { is_correct: shooter !== 1, time_ms: 900, points_earned: shooter !== 1 ? 90 : 0 }],
      ]);
      last = applyPenaltyResolution(state, roster, answers, shooter, 0);
      shooter = state.penalty.shooterSeat;
      kicks += 1;
    }
    expect(state.phase).toBe('COMPLETED');
    expect(last.shootoutDrawn).toBe(false);
    expect(state.penaltyGoals.seat1).toBeGreaterThan(state.penaltyGoals.seat2);
    expect(isShootoutDraw(state)).toBe(false);
  });

  it('never draws mid-regulation: level at 3 each keeps playing', () => {
    const state = shootoutState();
    state.penalty.kicksTaken = { seat1: 3, seat2: 2 };
    const answers = new Map([
      ['seat-2', { is_correct: true, time_ms: 700, points_earned: 100 }],
      ['seat-1', { is_correct: true, time_ms: 900, points_earned: 100 }],
    ]);
    const outcome = applyPenaltyResolution(state, players(), answers, 2, 0);
    expect(outcome.shootoutDrawn).toBe(false);
    expect(state.phase).toBe('PENALTY_SHOOTOUT');
  });
});

describe('isShootoutDraw', () => {
  it('true while penalty goals are level in a shootout (pool exhausted mid-shootout)', () => {
    const state = shootoutState();
    state.penalty.kicksTaken = { seat1: 3, seat2: 2 };
    state.penaltyGoals = { seat1: 2, seat2: 2 };
    expect(isShootoutDraw(state)).toBe(true);
    // Even before any kick was taken.
    state.penalty.kicksTaken = { seat1: 0, seat2: 0 };
    state.penaltyGoals = { seat1: 0, seat2: 0 };
    expect(isShootoutDraw(state)).toBe(true);
  });

  it('false when a side is ahead on penalty goals (pool exhausted while ahead -> that side wins)', () => {
    const state = shootoutState();
    state.penaltyGoals = { seat1: 3, seat2: 2 };
    expect(isShootoutDraw(state)).toBe(false);
  });

  it('false outside a shootout, even with level goals', () => {
    const state = createInitialPossessionState('ranked_sim');
    state.phase = 'NORMAL_PLAY';
    state.goals = { seat1: 1, seat2: 1 };
    expect(isShootoutDraw(state)).toBe(false);
    state.phase = 'COMPLETED';
    state.goals = { seat1: 2, seat2: 1 };
    expect(isShootoutDraw(state)).toBe(false);
  });
});
