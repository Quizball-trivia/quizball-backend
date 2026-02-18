import { describe, expect, it } from 'vitest';
import { createInitialPossessionState } from '../../src/modules/matches/matches.service.js';
import { __possessionInternals } from '../../src/realtime/possession-match-flow.js';

const { applyDeltaAndGoalCheck } = __possessionInternals;

describe('possessionDiff scoring model', () => {
  it('scores immediately on +100 and resets diff', () => {
    const state = createInitialPossessionState();
    const result = applyDeltaAndGoalCheck(state, 100, 0);
    expect(result.delta).toBe(100);
    expect(result.goalScoredBySeat).toBe(1);
    expect(state.possessionDiff).toBe(0);
    expect(state.goals.seat1).toBe(1);
  });

  it('scores immediately on -100 and resets diff', () => {
    const state = createInitialPossessionState();
    const result = applyDeltaAndGoalCheck(state, 0, 100);
    expect(result.delta).toBe(-100);
    expect(result.goalScoredBySeat).toBe(2);
    expect(state.possessionDiff).toBe(0);
    expect(state.goals.seat2).toBe(1);
  });

  it('accumulates non-goal deltas', () => {
    const state = createInitialPossessionState();
    applyDeltaAndGoalCheck(state, 70, 50);
    expect(state.possessionDiff).toBe(20);
    applyDeltaAndGoalCheck(state, 60, 40);
    expect(state.possessionDiff).toBe(40);
  });

  it('checks threshold on raw nextDiff before clamp', () => {
    const state = createInitialPossessionState();
    state.possessionDiff = 99;
    const result = applyDeltaAndGoalCheck(state, 51, 50);
    expect(result.goalScoredBySeat).toBe(1);
    expect(state.possessionDiff).toBe(0);
  });

  it('keeps raw round delta semantics on threshold-crossing goals', () => {
    const state = createInitialPossessionState();
    state.possessionDiff = 90;
    const result = applyDeltaAndGoalCheck(state, 50, 40);
    expect(result.delta).toBe(10);
    expect(result.goalScoredBySeat).toBe(1);
    expect(state.possessionDiff).toBe(0);
  });
});
