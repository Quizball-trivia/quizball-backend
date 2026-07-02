import { describe, expect, it } from 'vitest';
import type { MatchAnswerRow } from '../../src/modules/matches/matches.types.js';
import {
  hasNoHumanInteraction,
  isGenuineAnswerSubmission,
} from '../../src/realtime/services/match-interaction.service.js';

function backfillRow(userId: string, kind = 'multipleChoice'): MatchAnswerRow {
  return {
    match_id: 'm1',
    q_index: 0,
    user_id: userId,
    selected_index: null,
    is_correct: false,
    time_ms: 18000,
    points_earned: 0,
    answer_payload: {
      questionKind: kind,
      foundCount: kind === 'countdown' || kind === 'putInOrder' ? 0 : null,
      foundAnswerIds: kind === 'countdown' ? [] : null,
      submittedOrderIds: kind === 'putInOrder' ? [] : null,
      clueIndex: null,
    },
    phase_kind: 'normal',
    phase_round: null,
    shooter_seat: null,
    answered_at: new Date().toISOString(),
  };
}

describe('isGenuineAnswerSubmission', () => {
  it('treats a timeout-backfill row as not genuine for every question kind', () => {
    for (const kind of ['multipleChoice', 'countdown', 'putInOrder', 'clues']) {
      expect(isGenuineAnswerSubmission(backfillRow('u1', kind))).toBe(false);
    }
  });

  it('flags a wrong multiple-choice pick (non-null selected_index) as genuine', () => {
    const row = { ...backfillRow('u1'), selected_index: 2 };
    expect(isGenuineAnswerSubmission(row)).toBe(true);
  });

  it('flags scoring / correct answers as genuine', () => {
    expect(isGenuineAnswerSubmission({ ...backfillRow('u1'), is_correct: true })).toBe(true);
    expect(isGenuineAnswerSubmission({ ...backfillRow('u1'), points_earned: 5 })).toBe(true);
  });

  it('flags countdown / putInOrder / clues activity in the payload as genuine', () => {
    const found = backfillRow('u1', 'countdown');
    found.answer_payload = { questionKind: 'countdown', foundCount: 2, foundAnswerIds: ['a', 'b'] };
    expect(isGenuineAnswerSubmission(found)).toBe(true);

    const ordered = backfillRow('u1', 'putInOrder');
    ordered.answer_payload = { questionKind: 'putInOrder', submittedOrderIds: ['a', 'b', 'c'] };
    expect(isGenuineAnswerSubmission(ordered)).toBe(true);

    const clue = backfillRow('u1', 'clues');
    clue.answer_payload = { questionKind: 'clues', clueIndex: 1 };
    expect(isGenuineAnswerSubmission(clue)).toBe(true);
  });
});

describe('hasNoHumanInteraction', () => {
  const humans = new Set(['human-a', 'human-b']);

  it('is true when every human row is a timeout backfill (ghost match)', () => {
    const answers = [backfillRow('human-a'), backfillRow('human-b'), backfillRow('human-a')];
    expect(hasNoHumanInteraction(answers, humans)).toBe(true);
  });

  it('is false when a human genuinely submitted at least once (legit one-sided win)', () => {
    const answers = [
      backfillRow('human-a'),
      { ...backfillRow('human-b'), selected_index: 1 },
    ];
    expect(hasNoHumanInteraction(answers, humans)).toBe(false);
  });

  it('ignores AI submissions — only human interaction clears the guard', () => {
    const answers = [
      backfillRow('human-a'),
      backfillRow('human-b'),
      { ...backfillRow('ai-1'), selected_index: 0, is_correct: true, points_earned: 5 },
    ];
    expect(hasNoHumanInteraction(answers, humans)).toBe(true);
  });

  it('is false when there are no answer rows at all only if no humans provided', () => {
    expect(hasNoHumanInteraction([], humans)).toBe(true);
    expect(hasNoHumanInteraction([], new Set())).toBe(true);
  });
});
