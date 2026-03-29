import { describe, expect, it } from 'vitest';

import { normalizeQuestionPayloadCandidate, questionPayloadSchema } from '../../src/modules/questions/questions.schemas.js';

describe('question payload normalization', () => {
  it('parses canonical mcq payload with non-uuid option ids', () => {
    const payload = {
      type: 'mcq_single',
      options: [
        { id: 'A', text: { en: 'One' }, is_correct: true },
        { id: 'B', text: { en: 'Two' }, is_correct: false },
        { id: 'C', text: { en: 'Three' }, is_correct: false },
        { id: 'D', text: { en: 'Four' }, is_correct: false },
      ],
    };

    const parsed = questionPayloadSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
  });

  it('parses stringified payload JSON', () => {
    const payload = JSON.stringify({
      type: 'mcq_single',
      options: [
        { id: '1', text: { en: 'One' }, is_correct: true },
        { id: '2', text: { en: 'Two' }, is_correct: false },
        { id: '3', text: { en: 'Three' }, is_correct: false },
        { id: '4', text: { en: 'Four' }, is_correct: false },
      ],
    });

    const parsed = questionPayloadSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
  });

  it('parses legacy choices shape', () => {
    const legacyPayload = {
      type: 'mcq_single',
      choices: [
        { id: 'a', text: 'Santos', isCorrect: true },
        { id: 'b', text: 'River Plate', isCorrect: false },
        { id: 'c', text: 'Estudiantes', isCorrect: false },
        { id: 'd', text: 'Al Sadd', isCorrect: false },
      ],
    };

    const normalized = normalizeQuestionPayloadCandidate(legacyPayload);
    const parsed = questionPayloadSchema.safeParse(normalized);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.type).toBe('mcq_single');
    expect(parsed.data.options[0]?.text).toEqual({ en: 'Santos' });
    expect(parsed.data.options[0]?.is_correct).toBe(true);
  });

  it('fails malformed payload missing answer array', () => {
    const malformed = {
      type: 'mcq_single',
      answers_blob: [],
    };
    const parsed = questionPayloadSchema.safeParse(malformed);
    expect(parsed.success).toBe(false);
  });

  it('parses countdown_list payloads', () => {
    const payload = {
      type: 'countdown_list',
      prompt: { en: 'Name the clubs' },
      answer_groups: [
        {
          id: 'clubs',
          display: { en: 'Premier League Winners' },
          accepted_answers: ['arsenal', 'chelsea'],
        },
      ],
    };

    const parsed = questionPayloadSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
  });

  it('parses true_false payloads and rejects invalid ids', () => {
    const validPayload = {
      type: 'true_false',
      options: [
        { id: 'true', text: { en: 'True' }, is_correct: true },
        { id: 'false', text: { en: 'False' }, is_correct: false },
      ],
    };

    expect(questionPayloadSchema.safeParse(validPayload).success).toBe(true);

    const invalidPayload = {
      type: 'true_false',
      options: [
        { id: 'yes', text: { en: 'True' }, is_correct: true },
        { id: 'no', text: { en: 'False' }, is_correct: false },
      ],
    };

    expect(questionPayloadSchema.safeParse(invalidPayload).success).toBe(false);
  });

  it('parses clue_chain payloads', () => {
    const payload = {
      type: 'clue_chain',
      display_answer: { en: 'Lionel Messi' },
      accepted_answers: ['lionel messi', 'messi'],
      clues: [
        { type: 'text', content: { en: 'World Cup winner' } },
        { type: 'emoji', content: { en: '🐐' } },
      ],
    };

    const parsed = questionPayloadSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
  });

  it('parses put_in_order payloads and rejects duplicate item ids', () => {
    const validPayload = {
      type: 'put_in_order',
      prompt: { en: 'Put these wins in order' },
      direction: 'asc',
      items: [
        { id: 'a', label: { en: '2010' }, sort_value: 2010 },
        { id: 'b', label: { en: '2014' }, sort_value: 2014 },
        { id: 'c', label: { en: '2022' }, sort_value: 2022 },
      ],
    };

    expect(questionPayloadSchema.safeParse(validPayload).success).toBe(true);

    const duplicateIdPayload = {
      ...validPayload,
      items: [
        { id: 'dup', label: { en: '2010' }, sort_value: 2010 },
        { id: 'dup', label: { en: '2014' }, sort_value: 2014 },
        { id: 'c', label: { en: '2022' }, sort_value: 2022 },
      ],
    };

    expect(questionPayloadSchema.safeParse(duplicateIdPayload).success).toBe(false);
  });
});
