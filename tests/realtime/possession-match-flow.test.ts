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

    // PAUSE formula: playableAt = resumedAt - elapsedPlayMs
    // elapsedPlay = pauseStart - shownAt = 9s → playableAt = resumedAt - 9s
    // Scoring clock reflects only actual play time, not disconnect gap.
    expect(result.playableAt.toISOString()).toBe(new Date(resumedAtMs - 9_000).toISOString());
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

    // Already past reveal at pause → PAUSE formula:
    // elapsedPlay = pauseStart - shownAt = 6.5s → playableAt = resumedAt - 6.5s
    // 3.5s answer time left (deadline 2s after resume + the 1.5s the pause ate back).
    expect(result.playableAt.toISOString()).toBe(new Date(resumedAtMs - 6_500).toISOString());
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

  // Regression: reconnecting mid-question must PAUSE the scoring clock, not
  // reset it. Before the fix, computeResumedPossessionTiming overwrote shownAt
  // with resumedAt when the question was already revealed, so a player who
  // disconnected 36s into a 50s clue_chain and reconnected would get timeMs ≈ 0s
  // → clueIndex 0 → 100 pts. The PAUSE formula shifts playableAt forward by
  // the disconnect duration so scoring only counts actual play time.
  it('pauses the scoring clock during disconnect so reconnecting does not reset it', () => {
    const state = createInitialPossessionState('ranked_sim');
    // Reproduces the bug-report match: 5-clue question (50s), shown 36s
    // before reconnect, paused 22s in, deadline 50s after shown.
    const resumedAtMs = Date.UTC(2026, 5, 25, 20, 48, 55, 88);
    const shownAtMs = resumedAtMs - 36_200;   // shown 36.2s before reconnect
    const deadlineAtMs = shownAtMs + 50_000;   // 50s clue_chain window
    const pauseStartedAtMs = shownAtMs + 22_100; // disconnect 22.1s in

    const result = __possessionInternals.computeResumedPossessionTiming({
      shownAtRaw: new Date(shownAtMs).toISOString(),
      deadlineAtRaw: new Date(deadlineAtMs).toISOString(),
      pauseStartedAtMs,
      resumedAtMs,
      qIndex: 11,
      state,
      questionKind: 'clues',
    });

    // PAUSE formula: playableAt = resumedAt - elapsedPlayMs
    // elapsedPlay = pauseStart - shownAt = 22.1s
    // playableAt = resumedAt - 22.1s (NOT resumedAt, NOT original shownAt)
    const expectedPlayableAtMs = resumedAtMs - 22_100;
    expect(result.playableAt.getTime()).toBe(expectedPlayableAtMs);
    expect(result.playableAt.getTime()).not.toBe(resumedAtMs);  // not reset to 0
    expect(result.playableAt.getTime()).not.toBe(shownAtMs);     // not including disconnect gap

    // Deadline is shifted to preserve the remaining answer time from the
    // pause start (50s - 22.1s = 27.9s after resume).
    expect(result.deadlineAt.getTime()).toBe(resumedAtMs + 27_900);

    // The scoring clock for an answer 2.2s after reconnect:
    // timeMs = answerAt - playableAt = (resumedAt + 2.2s) - (resumedAt - 22.1s) = 24.3s
    // clueIndex = floor(24.3s / 10s) = 2 → 60 pts (NOT 100).
    const answerAtMs = resumedAtMs + 2_198;
    const timeMs = __possessionInternals.computeAuthoritativeTimeMs(
      { shownAt: result.playableAt.toISOString(), deadlineAt: result.deadlineAt.toISOString() },
      answerAtMs,
      0,
      50_000
    );
    expect(timeMs).toBeGreaterThan(24_000);
    expect(timeMs).toBeLessThan(25_000);
    // clueIndex = floor(24.3s / 10s) = 2 → 60 pts (NOT 100, NOT 40).
    expect(Math.floor(timeMs / 10_000)).toBe(2);
  });
});
