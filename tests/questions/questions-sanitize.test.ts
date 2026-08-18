import { describe, expect, it } from 'vitest';
import { sanitizeQuestionResponse } from '../../src/modules/questions/questions.sanitize.js';

const base = {
  id: 'q1',
  type: 'mcq_single',
  prompt: { en: 'Who?', ka: 'ვინ?' },
  explanation: { en: 'Because…', ka: 'იმიტომ…' },
};

describe('sanitizeQuestionResponse', () => {
  it('strips is_correct from mcq options but keeps ids and text', () => {
    const out = sanitizeQuestionResponse({
      ...base,
      payload: {
        type: 'mcq_single',
        options: [
          { id: 'a', text: { en: 'A', ka: 'ა' }, is_correct: false },
          { id: 'b', text: { en: 'B', ka: 'ბ' }, is_correct: true },
        ],
      },
    });
    const payload = out.payload as { options: Array<Record<string, unknown>> };
    expect(payload.options).toHaveLength(2);
    for (const option of payload.options) {
      expect(option).not.toHaveProperty('is_correct');
      expect(option).toHaveProperty('id');
      expect(option).toHaveProperty('text');
    }
  });

  it('strips top-level explanation', () => {
    const out = sanitizeQuestionResponse({ ...base, payload: null });
    expect(out).not.toHaveProperty('explanation');
  });

  it('strips accepted/display answers from text-answer types', () => {
    const out = sanitizeQuestionResponse({
      ...base,
      payload: {
        type: 'clue_chain',
        display_answer: { en: 'Zidane', ka: 'ზიდანი' },
        accepted_answers: ['zidane', 'zizou'],
        clues: [{ type: 'text', content: { en: 'French', ka: 'ფრანგი' } }],
      },
    });
    const payload = out.payload as Record<string, unknown>;
    expect(payload).not.toHaveProperty('display_answer');
    expect(payload).not.toHaveProperty('accepted_answers');
    expect(payload).toHaveProperty('clues');
  });

  it('strips sort_value, high/low values and answer_groups', () => {
    const out = sanitizeQuestionResponse({
      ...base,
      payload: {
        type: 'put_in_order',
        items: [{ id: 'i1', label: { en: 'X', ka: 'X' }, sort_value: 3 }],
        matchups: [
          { id: 'm1', left_name: { en: 'L', ka: 'L' }, left_value: 9, right_name: { en: 'R', ka: 'R' }, right_value: 4 },
        ],
        answer_groups: [{ id: 'g1', display: { en: 'D', ka: 'D' }, accepted_answers: ['d'] }],
      },
    });
    const payload = out.payload as {
      items: Array<Record<string, unknown>>;
      matchups: Array<Record<string, unknown>>;
    };
    expect(payload.items[0]).not.toHaveProperty('sort_value');
    expect(payload.matchups[0]).not.toHaveProperty('left_value');
    expect(payload.matchups[0]).not.toHaveProperty('right_value');
    expect(payload).not.toHaveProperty('answer_groups');
  });

  it('does not mutate the input object', () => {
    const input = {
      ...base,
      payload: { type: 'mcq_single', options: [{ id: 'a', text: { en: 'A', ka: 'ა' }, is_correct: true }] },
    };
    sanitizeQuestionResponse(input);
    expect((input.payload.options[0] as Record<string, unknown>).is_correct).toBe(true);
    expect(input).toHaveProperty('explanation');
  });
});
