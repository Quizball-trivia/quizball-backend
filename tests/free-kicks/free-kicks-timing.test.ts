import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../setup.js';

const mocks = vi.hoisted(() => {
  const tx = {};
  const sql = Object.assign(vi.fn(), {
    begin: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
  });
  const repo = {
    getActiveRoundForUpdate: vi.fn(),
    getActiveRound: vi.fn(),
    getRecentQuestionIds: vi.fn(async () => []),
    pickQuestionCandidates: vi.fn(),
    setQuestionSnapshot: vi.fn(),
    updateRoundState: vi.fn(),
    insertEvent: vi.fn(async () => undefined),
  };
  return { sql, repo };
});

vi.mock('../../src/db/index.js', () => ({ sql: mocks.sql }));
vi.mock('../../src/modules/free-kicks/free-kicks.repo.js', () => ({ freeKicksRepo: mocks.repo }));
vi.mock('../../src/modules/store/store.repo.js', () => ({ storeRepo: {} }));

import { QUESTION_WINDOW_MS } from '../../src/modules/free-kicks/free-kicks.constants.js';
import {
  BASE_ANSWER_MS,
  FREE_READ_CHARS,
  MAX_ANSWER_MS,
  READ_CHARS_PER_SECOND,
  answerTimeMsForChars,
  answerTimeMsForQuestion,
  questionReadChars,
  questionWindowMs,
} from '../../src/modules/free-kicks/free-kicks.timing.js';
import { freeKicksService } from '../../src/modules/free-kicks/free-kicks.service.js';
import type { FreeKicksRoundRow } from '../../src/modules/free-kicks/free-kicks.types.js';

const USER = '11111111-1111-4111-8111-111111111111';
const QUESTION_ID = '22222222-2222-4222-8222-222222222222';
const NOW = Date.parse('2026-11-02T12:00:00.000Z');

const opt = (id: string, en: string, ka = en) => ({ id, text: { en, ka } });

describe('free-kicks answer timing', () => {
  it('keeps the base 10s timer for short questions', () => {
    expect(answerTimeMsForChars(0)).toBe(BASE_ANSWER_MS);
    expect(answerTimeMsForChars(FREE_READ_CHARS)).toBe(BASE_ANSWER_MS);
    expect(answerTimeMsForQuestion({ en: 'Who won 2010?' }, [
      { text: { en: 'Spain' } },
      { text: { en: 'Italy' } },
      { text: { en: 'Brazil' } },
      { text: { en: 'France' } },
    ])).toBe(BASE_ANSWER_MS);
  });

  it('adds a second per READ_CHARS_PER_SECOND characters beyond the allowance, capped', () => {
    expect(answerTimeMsForChars(FREE_READ_CHARS + 1)).toBe(BASE_ANSWER_MS + 1000);
    expect(answerTimeMsForChars(FREE_READ_CHARS + READ_CHARS_PER_SECOND)).toBe(BASE_ANSWER_MS + 1000);
    expect(answerTimeMsForChars(FREE_READ_CHARS + READ_CHARS_PER_SECOND + 1)).toBe(BASE_ANSWER_MS + 2000);
    expect(answerTimeMsForChars(10_000)).toBe(MAX_ANSWER_MS);
    for (let chars = 0; chars < 600; chars += 1) {
      const ms = answerTimeMsForChars(chars);
      expect(ms).toBeGreaterThanOrEqual(BASE_ANSWER_MS);
      expect(ms).toBeLessThanOrEqual(MAX_ANSWER_MS);
      expect(ms).toBeGreaterThanOrEqual(answerTimeMsForChars(Math.max(0, chars - 1)));
    }
  });

  it('measures the longest locale, prompt plus options', () => {
    const chars = questionReadChars({ en: 'abc', ka: 'abcdefgh' }, [
      { text: { en: 'xx', ka: 'y' } },
      { text: { en: 'xx', ka: 'y' } },
    ]);
    expect(chars).toBe(10); // ka: 8 + 1 + 1 beats en: 3 + 2 + 2
  });

  it('the server window is never shorter than the original fixed window', () => {
    expect(questionWindowMs(BASE_ANSWER_MS)).toBe(QUESTION_WINDOW_MS);
    expect(questionWindowMs(0)).toBe(QUESTION_WINDOW_MS);
    expect(questionWindowMs(MAX_ANSWER_MS)).toBe(QUESTION_WINDOW_MS + (MAX_ANSWER_MS - BASE_ANSWER_MS));
  });
});

function baseRow(patch: Partial<FreeKicksRoundRow> = {}): FreeKicksRoundRow {
  return {
    id: 'round-1',
    user_id: USER,
    status: 'active',
    phase: 'deciding',
    state_version: 3,
    stake_coins: 10,
    pot_coins: 10,
    attack: 0,
    open_count: 2,
    answer_locked: false,
    goals: 0,
    question_id: null,
    question_payload: null,
    question_correct_option: null,
    question_deadline_at: null,
    server_seed: 'seed',
    commit_hash: 'hash',
    client_nonce: null,
    payout_coins: null,
    last_seen_at: new Date(NOW).toISOString(),
    created_at: new Date(NOW).toISOString(),
    updated_at: new Date(NOW).toISOString(),
    settled_at: null,
    ...patch,
  };
}

const LONG_PROMPT = 'Which club did this player join after leaving his boyhood team, where he went on to win two league titles and a domestic cup before moving abroad?';
const longOptions = [
  { id: 'a', text: { en: 'Borussia Dortmund' }, is_correct: true },
  { id: 'b', text: { en: 'Bayer Leverkusen' }, is_correct: false },
  { id: 'c', text: { en: 'Eintracht Frankfurt' }, is_correct: false },
  { id: 'd', text: { en: 'VfB Stuttgart' }, is_correct: false },
];

describe('free-kicks service enforces the scaled window', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    for (const fn of Object.values(mocks.repo)) fn.mockClear();
    mocks.repo.getRecentQuestionIds.mockResolvedValue([]);
    mocks.repo.insertEvent.mockResolvedValue(undefined);
  });
  afterEach(() => vi.useRealTimers());

  it('deals a long question with a longer deadline and exposes time_limit_ms', async () => {
    const row = baseRow();
    mocks.repo.getActiveRoundForUpdate.mockResolvedValue(row);
    mocks.repo.pickQuestionCandidates.mockResolvedValue([
      { id: QUESTION_ID, prompt: { en: LONG_PROMPT }, payload: { options: longOptions } },
    ]);
    mocks.repo.setQuestionSnapshot.mockImplementation(async (_tx, _id, _v, data) => baseRow({
      phase: 'question',
      state_version: 4,
      question_id: data.questionId,
      question_payload: data.snapshot,
      question_correct_option: data.correctOption,
      question_deadline_at: data.deadlineAt,
    }));

    const state = await freeKicksService.dealQuestion(USER, 3);
    const expectedAnswerMs = answerTimeMsForQuestion({ en: LONG_PROMPT }, longOptions);
    expect(expectedAnswerMs).toBeGreaterThan(BASE_ANSWER_MS);
    expect(state.question?.time_limit_ms).toBe(expectedAnswerMs);
    expect(Date.parse(state.question!.deadline_at)).toBe(NOW + questionWindowMs(expectedAnswerMs));
  });

  it('a short question keeps the original 17.5s deadline', async () => {
    mocks.repo.getActiveRoundForUpdate.mockResolvedValue(baseRow());
    mocks.repo.pickQuestionCandidates.mockResolvedValue([
      { id: QUESTION_ID, prompt: { en: 'Who won 2010?' }, payload: { options: [
        { id: 'a', text: { en: 'Spain' }, is_correct: true },
        { id: 'b', text: { en: 'Italy' }, is_correct: false },
        { id: 'c', text: { en: 'Brazil' }, is_correct: false },
        { id: 'd', text: { en: 'France' }, is_correct: false },
      ] } },
    ]);
    mocks.repo.setQuestionSnapshot.mockImplementation(async (_tx, _id, _v, data) => baseRow({
      phase: 'question',
      question_id: data.questionId,
      question_payload: data.snapshot,
      question_correct_option: data.correctOption,
      question_deadline_at: data.deadlineAt,
    }));

    const state = await freeKicksService.dealQuestion(USER, 3);
    expect(state.question?.time_limit_ms).toBe(BASE_ANSWER_MS);
    expect(Date.parse(state.question!.deadline_at)).toBe(NOW + QUESTION_WINDOW_MS);
  });

  function pendingLongQuestion(): FreeKicksRoundRow {
    const answerMs = answerTimeMsForQuestion({ en: LONG_PROMPT }, longOptions);
    return baseRow({
      phase: 'question',
      open_count: 2,
      question_id: QUESTION_ID,
      question_correct_option: 'a',
      question_payload: {
        question_id: QUESTION_ID,
        prompt: { en: LONG_PROMPT },
        options: longOptions.map(({ id, text }) => opt(id, text.en)),
        dealt_at: new Date(NOW).toISOString(),
        answer_time_ms: answerMs,
      },
      question_deadline_at: new Date(NOW + questionWindowMs(answerMs)).toISOString(),
    });
  }

  it('accepts a correct answer after the old 17.5s window but inside the scaled one', async () => {
    mocks.repo.getActiveRoundForUpdate.mockResolvedValue(pendingLongQuestion());
    // The updated row comes back answer-locked so the post-answer auto-deal stays out of this unit test.
    mocks.repo.updateRoundState.mockImplementation(async (_tx, _id, _v, patch) => baseRow({ ...patch, answer_locked: true }));
    vi.setSystemTime(NOW + QUESTION_WINDOW_MS + 1_000);

    const result = await freeKicksService.answerQuestion(USER, {
      questionId: QUESTION_ID,
      optionId: 'a',
      expectedVersion: 3,
    });
    expect(result.outcome).toBe('correct');
    expect(mocks.repo.updateRoundState.mock.calls[0][3]).toMatchObject({ open_count: 3 });
  });

  it('still marks answers after the scaled deadline as late', async () => {
    const row = pendingLongQuestion();
    mocks.repo.getActiveRoundForUpdate.mockResolvedValue(row);
    mocks.repo.updateRoundState.mockImplementation(async (_tx, _id, _v, patch) => baseRow({ ...patch }));
    vi.setSystemTime(Date.parse(row.question_deadline_at!) + 1);

    const result = await freeKicksService.answerQuestion(USER, {
      questionId: QUESTION_ID,
      optionId: 'a',
      expectedVersion: 3,
    });
    expect(result.outcome).toBe('late');
    expect(mocks.repo.updateRoundState.mock.calls[0][3]).toMatchObject({ open_count: 2, answer_locked: true });
  });

  it('rounds dealt before the change (no answer_time_ms) report the base timer', async () => {
    const row = pendingLongQuestion();
    const legacy = { ...(row.question_payload as Record<string, unknown>) };
    delete legacy.answer_time_ms;
    mocks.repo.getActiveRound.mockResolvedValue({ ...row, question_payload: legacy });
    mocks.repo.getActiveRoundForUpdate.mockResolvedValue(null);

    const state = await freeKicksService.getCurrentState(USER);
    expect(state.question?.time_limit_ms).toBe(BASE_ANSWER_MS);
  });
});
