import { describe, expect, it } from 'vitest';
import { createInitialPossessionState } from '../../src/modules/matches/matches.service.js';
import type { CachedPlayer } from '../../src/realtime/match-cache.js';
import { applyPenaltyResolution } from '../../src/realtime/possession-resolution.js';

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

  it('keeps unlimited sudden death when the bound is disabled', () => {
    const state = tiedSuddenDeathState();
    const roster = players();

    applyPenaltyResolution(state, roster, missedAnswers, 1, 0);
    const result = applyPenaltyResolution(state, roster, missedAnswers, 2, 0);

    expect(result.forcedBySuddenDeathCap).toBe(false);
    expect(state.phase).toBe('PENALTY_SHOOTOUT');
  });
});
