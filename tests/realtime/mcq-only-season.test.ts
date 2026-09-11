import { describe, expect, it, vi } from 'vitest';
import '../setup.js';

vi.mock('../../src/core/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/config.js')>();
  return { ...actual, config: { ...actual.config, POSSESSION_MCQ_ONLY: true } };
});

const { normalHalfSequence, questionTypeForState } = await import('../../src/realtime/possession-payload-mappers.js');
const { createInitialPossessionState, POSSESSION_QUESTIONS_PER_HALF } = await import('../../src/modules/matches/matches.service.js');

describe('Season 3: possession matches are MCQ-only', () => {
  it('serves an MCQ in every slot of the half', () => {
    expect(normalHalfSequence()).toEqual(Array(POSSESSION_QUESTIONS_PER_HALF).fill('mcq_single'));
    const state = createInitialPossessionState('ranked_sim');
    for (let answered = 0; answered < POSSESSION_QUESTIONS_PER_HALF; answered += 1) {
      expect(questionTypeForState({ ...state, normalQuestionsAnsweredInHalf: answered })).toBe('mcq_single');
    }
  });
});
