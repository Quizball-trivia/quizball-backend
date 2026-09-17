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

describe('penalty sudden-death safety bound', () => {
  it('completes only after both players receive the configured number of extra kicks', () => {
    const state = tiedSuddenDeathState();
    const roster = players();

    const first = applyPenaltyResolution(state, roster, missedAnswers, 1, 1);
    expect(first.forcedBySuddenDeathCap).toBe(false);
    expect(state.phase).toBe('PENALTY_SHOOTOUT');
    expect(state.penalty.kicksTaken).toEqual({ seat1: 6, seat2: 5 });

    const second = applyPenaltyResolution(state, roster, missedAnswers, 2, 1);
    expect(second.forcedBySuddenDeathCap).toBe(true);
    expect(state.phase).toBe('COMPLETED');
    expect(state.penalty.kicksTaken).toEqual({ seat1: 6, seat2: 6 });
  });

  it('ships with a default bound of 5 sudden-death pairs (shootout ends by kick 20 at the latest)', () => {
    expect(config.POSSESSION_MAX_SUDDEN_DEATH_ROUNDS).toBe(5);
    const state = tiedSuddenDeathState();
    const roster = players();
    let kicks = 10;
    let forced = false;
    let shooter: 1 | 2 = 1;
    while (state.phase === 'PENALTY_SHOOTOUT' && kicks < 60) {
      forced = applyPenaltyResolution(state, roster, missedAnswers, shooter, config.POSSESSION_MAX_SUDDEN_DEATH_ROUNDS).forcedBySuddenDeathCap;
      shooter = state.penalty.shooterSeat;
      kicks += 1;
    }
    expect(forced).toBe(true);
    expect(kicks).toBe(20);
    expect(state.penalty.kicksTaken).toEqual({ seat1: 10, seat2: 10 });
  });

  it('keeps unlimited sudden death when the bound is explicitly disabled (0)', () => {
    const state = tiedSuddenDeathState();
    const roster = players();

    applyPenaltyResolution(state, roster, missedAnswers, 1, 0);
    const result = applyPenaltyResolution(state, roster, missedAnswers, 2, 0);

    expect(result.forcedBySuddenDeathCap).toBe(false);
    expect(state.phase).toBe('PENALTY_SHOOTOUT');
  });
});

describe('forced decision after the cap (decideWinner natural chain)', () => {
  const level = () => {
    const state = tiedSuddenDeathState();
    state.penalty.kicksTaken = { seat1: 10, seat2: 10 };
    return state;
  };
  const rows = (p1: number, p2: number, c1: number, c2: number) => [
    { user_id: 'seat-1', seat: 1, total_points: p1, correct_answers: c1 },
    { user_id: 'seat-2', seat: 2, total_points: p2, correct_answers: c2 },
  ];

  it('level on goals and penalty goals: whole-match total points decide, symmetrically', () => {
    expect(decideWinner(rows(400, 300, 4, 3), level())).toMatchObject({ winnerId: 'seat-1', method: 'total_points_fallback' });
    expect(decideWinner(rows(300, 400, 4, 3), level())).toMatchObject({ winnerId: 'seat-2', method: 'total_points_fallback' });
  });

  it('level on points too: correct answers decide, symmetrically', () => {
    expect(decideWinner(rows(400, 400, 5, 4), level()).winnerId).toBe('seat-1');
    expect(decideWinner(rows(400, 400, 4, 5), level()).winnerId).toBe('seat-2');
  });

  it('level on every gameplay signal: seat 1 as the deterministic last resort', () => {
    expect(decideWinner(rows(400, 400, 4, 4), level()).winnerId).toBe('seat-1');
  });
});
