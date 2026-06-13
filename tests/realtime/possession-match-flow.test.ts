import { describe, expect, it } from 'vitest';
import { createInitialPossessionState, POSSESSION_QUESTIONS_PER_HALF } from '../../src/modules/matches/matches.service.js';
import { __possessionInternals } from '../../src/realtime/possession-match-flow.js';

describe('possession mixed-question sequencing', () => {
  it('uses the same normal-play slot order for ranked and friendly possession halves', () => {
    const expected = [
      'mcq_single',
      'mcq_single',
      'mcq_single',
      'mcq_single',
      'put_in_order',
      'clue_chain',
    ];

    (['ranked_sim', 'friendly_possession'] as const).forEach((variant) => {
      [1, 2].forEach((half) => {
        const state = createInitialPossessionState(variant);
        state.half = half;
        state.phase = 'NORMAL_PLAY';

        const actual = expected.map((_, answeredInHalf) => {
          state.normalQuestionsAnsweredInHalf = answeredInHalf;
          return __possessionInternals.questionTypeForState(state);
        });

        expect(actual).toEqual(expected);
        expect(actual).not.toContain('countdown_list');
      });
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

  // C1: the resume-timing math is question-kind agnostic when timestamps are
  // intact — an mcq round resumed after a disconnect preserves its remaining
  // answer window exactly like countdown/clues do (those two cases are already
  // covered above; this closes the mcq gap so all live kinds are pinned).
  it('preserves remaining mcq answer time when resuming after a disconnect', () => {
    const state = createInitialPossessionState('ranked_sim');
    const resumedAtMs = Date.UTC(2026, 3, 9, 12, 0, 0);
    const shownAtMs = resumedAtMs - 8_000;
    const deadlineAtMs = resumedAtMs + 2_000;
    const pauseStartedAtMs = resumedAtMs - 1_500;

    const result = __possessionInternals.computeResumedPossessionTiming({
      shownAtRaw: new Date(shownAtMs).toISOString(),
      deadlineAtRaw: new Date(deadlineAtMs).toISOString(),
      pauseStartedAtMs,
      resumedAtMs,
      qIndex: 1,
      state,
      questionKind: 'multipleChoice',
    });

    // Already past reveal at pause → playable immediately; 3.5s answer time left
    // (deadline 2s after resume + the 1.5s the pause ate back).
    expect(result.playableAt.toISOString()).toBe(new Date(resumedAtMs).toISOString());
    expect(result.deadlineAt.toISOString()).toBe(new Date(resumedAtMs + 3_500).toISOString());
  });

  // C2: mixed-type survivorship. If a disconnect leaves the question timestamps
  // unusable (missing / inverted), resume must fall back to a FRESH window sized
  // for THAT question's kind — a put_in_order must not inherit an mcq-sized
  // (10s) clock, and vice versa. This is what stops a disconnect on one slot
  // from corrupting the next slot's answer time when the half mixes types.
  it('falls back to a kind-correct fresh window when resume timestamps are unusable', () => {
    const state = createInitialPossessionState('ranked_sim');
    const resumedAtMs = Date.UTC(2026, 3, 9, 12, 0, 0);
    // Inverted window (deadline <= shown) → timestamps unusable → fresh-timing path.
    const corruptArgs = {
      shownAtRaw: new Date(resumedAtMs).toISOString(),
      deadlineAtRaw: new Date(resumedAtMs - 5_000).toISOString(),
      pauseStartedAtMs: resumedAtMs - 1_000,
      resumedAtMs,
      qIndex: 4,
      state,
    } as const;

    const order = __possessionInternals.computeResumedPossessionTiming({
      ...corruptArgs,
      questionKind: 'putInOrder',
    });
    const mcq = __possessionInternals.computeResumedPossessionTiming({
      ...corruptArgs,
      questionKind: 'multipleChoice',
    });

    const orderWindowMs = order.deadlineAt.getTime() - order.playableAt.getTime();
    const mcqWindowMs = mcq.deadlineAt.getTime() - mcq.playableAt.getTime();

    // put_in_order gets its full 30s; mcq gets its 10s. They do NOT collapse to
    // the same value — the kind determines the fresh window.
    expect(orderWindowMs).toBe(30_000);
    expect(mcqWindowMs).toBe(10_000);
    expect(orderWindowMs).not.toBe(mcqWindowMs);
  });

  it('does not persist special-round progress as selected_index', () => {
    expect(__possessionInternals.selectedIndexForAnswerPersistence('multipleChoice', 2)).toBe(2);
    expect(__possessionInternals.selectedIndexForAnswerPersistence('countdown', 7)).toBeNull();
    expect(__possessionInternals.selectedIndexForAnswerPersistence('putInOrder', null)).toBeNull();
    expect(__possessionInternals.selectedIndexForAnswerPersistence('clues', null)).toBeNull();
  });
});
