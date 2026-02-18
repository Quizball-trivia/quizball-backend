import { describe, expect, it } from 'vitest';
import { createInitialPossessionState } from '../../src/modules/matches/matches.service.js';
import { __possessionInternals } from '../../src/realtime/possession-match-flow.js';

const { applyNormalResolution, applyLastAttackResolution } = __possessionInternals;

describe('last attack mechanic', () => {
  it('triggers for seat1 at +50 after Q6', () => {
    const state = createInitialPossessionState();
    state.normalQuestionsAnsweredInHalf = 5;
    state.normalQuestionsAnsweredTotal = 5;
    state.possessionDiff = 40;

    applyNormalResolution(state, 60, 50);
    expect(state.phase).toBe('LAST_ATTACK');
    expect(state.lastAttack.attackerSeat).toBe(1);
  });

  it('triggers for seat2 at -50 after Q6', () => {
    const state = createInitialPossessionState();
    state.normalQuestionsAnsweredInHalf = 5;
    state.normalQuestionsAnsweredTotal = 5;
    state.possessionDiff = -40;

    applyNormalResolution(state, 50, 60);
    expect(state.phase).toBe('LAST_ATTACK');
    expect(state.lastAttack.attackerSeat).toBe(2);
  });

  it('does not trigger when abs(diff) < 50 after Q6', () => {
    const state = createInitialPossessionState();
    state.normalQuestionsAnsweredInHalf = 5;
    state.normalQuestionsAnsweredTotal = 5;
    state.possessionDiff = 10;

    applyNormalResolution(state, 50, 50);
    expect(state.phase).toBe('HALFTIME');
  });

  it('resolves last attack and transitions onward without incrementing normal counters', () => {
    const state = createInitialPossessionState();
    state.phase = 'LAST_ATTACK';
    state.half = 2;
    state.goals = { seat1: 1, seat2: 0 };
    state.normalQuestionsAnsweredInHalf = 6;
    state.normalQuestionsAnsweredTotal = 12;
    state.possessionDiff = 70;

    applyLastAttackResolution(state, 60, 50);
    expect(state.normalQuestionsAnsweredInHalf).toBe(6);
    expect(state.normalQuestionsAnsweredTotal).toBe(12);
    expect(state.phase).toBe('COMPLETED');
  });
});
