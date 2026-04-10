import { describe, expect, it } from 'vitest';
import { createInitialPossessionState, POSSESSION_QUESTIONS_PER_HALF } from '../../src/modules/matches/matches.service.js';
import { __possessionInternals } from '../../src/realtime/possession-match-flow.js';

describe('possession mixed-question sequencing', () => {
  it('uses the ranked normal-play slot order for each half', () => {
    const expected = [
      'mcq_single',
      'mcq_single',
      'mcq_single',
      'countdown_list',
      'put_in_order',
      'clue_chain',
    ];

    [1, 2].forEach((half) => {
      const state = createInitialPossessionState('ranked_sim');
      state.half = half;
      state.phase = 'NORMAL_PLAY';

      const actual = expected.map((_, answeredInHalf) => {
        state.normalQuestionsAnsweredInHalf = answeredInHalf;
        return __possessionInternals.questionTypeForState(state);
      });

      expect(actual).toEqual(expected);
    });
  });

  it('keeps last attack on multiple choice only', () => {
    const state = createInitialPossessionState('ranked_sim');
    state.phase = 'LAST_ATTACK';

    expect(__possessionInternals.questionTypeForState(state)).toBe('mcq_single');
  });

  it('still awards last attack only on the boundary win condition', () => {
    const state = createInitialPossessionState('ranked_sim');
    state.normalQuestionsAnsweredInHalf = POSSESSION_QUESTIONS_PER_HALF - 1;
    state.possessionDiff = 55;

    const result = __possessionInternals.applyNormalResolution(state, 10, 0, true, false);

    expect(result.delta).toBeGreaterThan(0);
    expect(state.phase).toBe('LAST_ATTACK');
    expect(state.lastAttack.attackerSeat).toBe(1);
  });

  it('skips halftime when a second-half category is already assigned', () => {
    const state = createInitialPossessionState('ranked_sim');
    state.normalQuestionsAnsweredInHalf = POSSESSION_QUESTIONS_PER_HALF - 1;

    __possessionInternals.applyNormalResolution(
      state,
      0,
      0,
      false,
      false,
      'category-b'
    );

    expect(state.half).toBe(2);
    expect(state.phase).toBe('NORMAL_PLAY');
    expect(state.normalQuestionsAnsweredInHalf).toBe(0);
    expect(state.halftime.deadlineAt).toBeNull();
  });

  it('preserves remaining countdown answer time when resuming after a disconnect', () => {
    const state = createInitialPossessionState('ranked_sim');
    const resumedAtMs = Date.UTC(2026, 3, 9, 12, 0, 0);
    const shownAtMs = resumedAtMs - 10_000;
    const deadlineAtMs = resumedAtMs + 5_000;
    const pauseStartedAtMs = resumedAtMs - 1_000;

    const result = __possessionInternals.computeResumedPossessionTiming({
      shownAtRaw: new Date(shownAtMs).toISOString(),
      deadlineAtRaw: new Date(deadlineAtMs).toISOString(),
      pauseStartedAtMs,
      resumedAtMs,
      qIndex: 3,
      state,
      questionKind: 'countdown',
    });

    expect(result.playableAt.toISOString()).toBe(new Date(resumedAtMs).toISOString());
    expect(result.deadlineAt.toISOString()).toBe(new Date(resumedAtMs + 6_000).toISOString());
  });

  it('preserves remaining clue reveal and answer timing when resuming before playableAt', () => {
    const state = createInitialPossessionState('ranked_sim');
    const resumedAtMs = Date.UTC(2026, 3, 9, 12, 0, 0);
    const shownAtMs = resumedAtMs + 4_000;
    const deadlineAtMs = resumedAtMs + 19_000;
    const pauseStartedAtMs = resumedAtMs - 1_000;

    const result = __possessionInternals.computeResumedPossessionTiming({
      shownAtRaw: new Date(shownAtMs).toISOString(),
      deadlineAtRaw: new Date(deadlineAtMs).toISOString(),
      pauseStartedAtMs,
      resumedAtMs,
      qIndex: 5,
      state,
      questionKind: 'clues',
    });

    expect(result.playableAt.toISOString()).toBe(new Date(resumedAtMs + 5_000).toISOString());
    expect(result.deadlineAt.toISOString()).toBe(new Date(resumedAtMs + 20_000).toISOString());
  });
});
