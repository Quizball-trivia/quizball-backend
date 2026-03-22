import { beforeEach, describe, expect, it, vi } from 'vitest';

import '../setup.js';

const beginMock = vi.fn();
const listConfigsMock = vi.fn();
const listCompletionsForUserOnDayMock = vi.fn();
const getConfigMock = vi.fn();
const getCompletionForUserOnDayMock = vi.fn();
const listPublishedQuestionsByTypeAndCategoriesMock = vi.fn();
const createCompletionInTxMock = vi.fn();
const addCoinsInTxMock = vi.fn();
const deleteCompletionForUserOnDayMock = vi.fn();
const upsertConfigMock = vi.fn();
const listByIdsMock = vi.fn();

vi.mock('../../src/db/index.js', () => ({
  sql: {
    begin: (...args: unknown[]) => beginMock(...args),
  },
}));

vi.mock('../../src/modules/daily-challenges/daily-challenges.repo.js', () => ({
  dailyChallengesRepo: {
    listConfigs: (...args: unknown[]) => listConfigsMock(...args),
    listCompletionsForUserOnDay: (...args: unknown[]) => listCompletionsForUserOnDayMock(...args),
    getConfig: (...args: unknown[]) => getConfigMock(...args),
    getCompletionForUserOnDay: (...args: unknown[]) => getCompletionForUserOnDayMock(...args),
    listPublishedQuestionsByTypeAndCategories: (...args: unknown[]) => listPublishedQuestionsByTypeAndCategoriesMock(...args),
    createCompletionInTx: (...args: unknown[]) => createCompletionInTxMock(...args),
    addCoinsInTx: (...args: unknown[]) => addCoinsInTxMock(...args),
    deleteCompletionForUserOnDay: (...args: unknown[]) => deleteCompletionForUserOnDayMock(...args),
    upsertConfig: (...args: unknown[]) => upsertConfigMock(...args),
  },
}));

vi.mock('../../src/modules/categories/categories.repo.js', () => ({
  categoriesRepo: {
    listByIds: (...args: unknown[]) => listByIdsMock(...args),
  },
}));

describe('dailyChallengesService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    beginMock.mockImplementation(async (callback: (tx: object) => Promise<unknown>) => callback({}));
  });

  it('lists active challenges with per-user completion flags', async () => {
    listConfigsMock.mockResolvedValue([
      {
        challenge_type: 'moneyDrop',
        is_active: true,
        sort_order: 1,
        show_on_home: true,
        coin_reward: 100,
        xp_reward: 20,
        settings: {},
        created_at: '2026-03-15T00:00:00.000Z',
        updated_at: '2026-03-15T00:00:00.000Z',
      },
      {
        challenge_type: 'countdown',
        is_active: true,
        sort_order: 2,
        show_on_home: false,
        coin_reward: 75,
        xp_reward: 10,
        settings: {},
        created_at: '2026-03-15T00:00:00.000Z',
        updated_at: '2026-03-15T00:00:00.000Z',
      },
    ]);
    listCompletionsForUserOnDayMock.mockResolvedValue([
      {
        user_id: 'user-1',
        challenge_type: 'moneyDrop',
      },
    ]);

    const { dailyChallengesService } = await import('../../src/modules/daily-challenges/daily-challenges.service.js');
    const result = await dailyChallengesService.listActiveChallenges('user-1');

    expect(result).toEqual([
      expect.objectContaining({
        challengeType: 'moneyDrop',
        completedToday: true,
        availableToday: false,
        showOnHome: true,
      }),
      expect.objectContaining({
        challengeType: 'countdown',
        completedToday: false,
        availableToday: true,
        showOnHome: false,
      }),
    ]);
  });

  it('builds a money drop session from published mcq questions', async () => {
    const categoryId = '11111111-1111-1111-1111-111111111111';
    getConfigMock.mockResolvedValue({
      challenge_type: 'moneyDrop',
      is_active: true,
      sort_order: 1,
      show_on_home: true,
      coin_reward: 100,
      xp_reward: 20,
      settings: {
        categoryIds: [categoryId],
        questionCount: 1,
        secondsPerQuestion: 30,
        startingMoney: 100000,
      },
      created_at: '2026-03-15T00:00:00.000Z',
      updated_at: '2026-03-15T00:00:00.000Z',
    });
    getCompletionForUserOnDayMock.mockResolvedValue(null);
    listByIdsMock.mockResolvedValue([{ id: categoryId, is_active: true }]);
    listPublishedQuestionsByTypeAndCategoriesMock.mockResolvedValue([
      {
        id: 'q-1',
        category_id: categoryId,
        difficulty: 'easy',
        prompt: { en: 'Who won the 2010 World Cup?' },
        explanation: { en: 'Spain beat the Netherlands.' },
        category_name: { en: 'World Cup' },
        payload: {
          type: 'mcq_single',
          options: [
            { id: 'a', text: { en: 'Spain' }, is_correct: true },
            { id: 'b', text: { en: 'Germany' }, is_correct: false },
            { id: 'c', text: { en: 'Brazil' }, is_correct: false },
            { id: 'd', text: { en: 'France' }, is_correct: false },
          ],
        },
      },
    ]);

    const { dailyChallengesService } = await import('../../src/modules/daily-challenges/daily-challenges.service.js');
    const result = await dailyChallengesService.getChallengeSession('user-1', 'moneyDrop');

    expect(result).toEqual({
      challengeType: 'moneyDrop',
      title: expect.any(String),
      description: expect.any(String),
      questionCount: 1,
      secondsPerQuestion: 30,
      startingMoney: 100000,
      questions: [
        {
          id: 'q-1',
          category: 'World Cup',
          difficulty: 'easy',
          prompt: 'Who won the 2010 World Cup?',
          options: ['Spain', 'Germany', 'Brazil', 'France'],
          correctAnswerIndex: 0,
          clue: 'Spain beat the Netherlands.',
        },
      ],
    });
  });

  it('falls back to legacy payload prompt when the row prompt is blank', async () => {
    const categoryId = '11111111-1111-1111-1111-111111111111';
    getConfigMock.mockResolvedValue({
      challenge_type: 'moneyDrop',
      is_active: true,
      sort_order: 1,
      show_on_home: true,
      coin_reward: 100,
      xp_reward: 20,
      settings: {
        categoryIds: [categoryId],
        questionCount: 1,
        secondsPerQuestion: 30,
        startingMoney: 100000,
      },
      created_at: '2026-03-15T00:00:00.000Z',
      updated_at: '2026-03-15T00:00:00.000Z',
    });
    getCompletionForUserOnDayMock.mockResolvedValue(null);
    listByIdsMock.mockResolvedValue([{ id: categoryId, is_active: true }]);
    listPublishedQuestionsByTypeAndCategoriesMock.mockResolvedValue([
      {
        id: 'q-legacy',
        category_id: categoryId,
        difficulty: 'easy',
        prompt: null,
        explanation: null,
        category_name: { en: 'Serie A' },
        payload: {
          type: 'mcq_single',
          prompt: { en: 'What is AC Milan known as?' },
          options: [
            { id: 'a', text: { en: 'The Rossoneri' }, is_correct: true },
            { id: 'b', text: { en: 'The Gunners' }, is_correct: false },
            { id: 'c', text: { en: 'The Reds' }, is_correct: false },
            { id: 'd', text: { en: 'The Old Lady' }, is_correct: false },
          ],
        },
      },
    ]);

    const { dailyChallengesService } = await import('../../src/modules/daily-challenges/daily-challenges.service.js');
    const result = await dailyChallengesService.getChallengeSession('user-1', 'moneyDrop');

    expect(result).toEqual(
      expect.objectContaining({
        questions: [
          expect.objectContaining({
            id: 'q-legacy',
            prompt: 'What is AC Milan known as?',
          }),
        ],
      })
    );
  });

  it('rejects session creation when the user already completed the challenge today', async () => {
    const categoryId = '11111111-1111-1111-1111-111111111111';
    getConfigMock.mockResolvedValue({
      challenge_type: 'moneyDrop',
      is_active: true,
      settings: {
        categoryIds: [categoryId],
        questionCount: 1,
        secondsPerQuestion: 30,
        startingMoney: 100000,
      },
    });
    getCompletionForUserOnDayMock.mockResolvedValue({
      challenge_type: 'moneyDrop',
      user_id: 'user-1',
    });

    const { dailyChallengesService } = await import('../../src/modules/daily-challenges/daily-challenges.service.js');

    await expect(dailyChallengesService.getChallengeSession('user-1', 'moneyDrop')).rejects.toMatchObject({
      code: 'DAILY_CHALLENGE_ALREADY_COMPLETED',
      statusCode: 409,
    });
  });

  it('completes a challenge once and awards configured coins', async () => {
    getConfigMock.mockResolvedValue({
      challenge_type: 'countdown',
      is_active: true,
      coin_reward: 80,
      xp_reward: 15,
    });
    getCompletionForUserOnDayMock.mockResolvedValue(null);
    createCompletionInTxMock.mockResolvedValue({
      id: 'completion-1',
    });
    addCoinsInTxMock.mockResolvedValue({
      coins: 1080,
      tickets: 10,
    });

    const { dailyChallengesService } = await import('../../src/modules/daily-challenges/daily-challenges.service.js');
    const result = await dailyChallengesService.completeChallenge('user-1', 'countdown', 500);

    expect(createCompletionInTxMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: 'user-1',
        challengeType: 'countdown',
        score: 500,
        coinsAwarded: 80,
        xpAwarded: 15,
      })
    );
    expect(addCoinsInTxMock).toHaveBeenCalledWith(expect.anything(), 'user-1', 80);
    expect(result).toEqual({
      challengeType: 'countdown',
      completedToday: true,
      coinsAwarded: 80,
      xpAwarded: 15,
      wallet: {
        coins: 1080,
        tickets: 10,
      },
    });
  });

  it('returns already completed if completion insert hits the unique constraint', async () => {
    getConfigMock.mockResolvedValue({
      challenge_type: 'countdown',
      is_active: true,
      coin_reward: 80,
      xp_reward: 15,
    });
    getCompletionForUserOnDayMock.mockResolvedValue(null);
    createCompletionInTxMock.mockRejectedValue({ code: '23505' });

    const { dailyChallengesService } = await import('../../src/modules/daily-challenges/daily-challenges.service.js');

    await expect(dailyChallengesService.completeChallenge('user-1', 'countdown', 500)).rejects.toMatchObject({
      code: 'DAILY_CHALLENGE_ALREADY_COMPLETED',
      statusCode: 409,
    });
  });

  it('filters out unusable money drop questions', async () => {
    const categoryId = '11111111-1111-1111-1111-111111111111';
    getConfigMock.mockResolvedValue({
      challenge_type: 'moneyDrop',
      is_active: true,
      sort_order: 1,
      show_on_home: true,
      coin_reward: 100,
      xp_reward: 20,
      settings: {
        categoryIds: [categoryId],
        questionCount: 1,
        secondsPerQuestion: 30,
        startingMoney: 100000,
      },
      created_at: '2026-03-15T00:00:00.000Z',
      updated_at: '2026-03-15T00:00:00.000Z',
    });
    getCompletionForUserOnDayMock.mockResolvedValue(null);
    listByIdsMock.mockResolvedValue([{ id: categoryId, is_active: true }]);
    listPublishedQuestionsByTypeAndCategoriesMock.mockResolvedValue([
      {
        id: 'q-bad',
        category_id: categoryId,
        difficulty: 'easy',
        prompt: null,
        explanation: null,
        category_name: { en: 'Serie A' },
        payload: {
          type: 'mcq_single',
          options: [
            { id: 'a', text: { en: 'A' }, is_correct: true },
            { id: 'b', text: { en: 'B' }, is_correct: false },
            { id: 'c', text: { en: 'C' }, is_correct: false },
            { id: 'd', text: { en: 'D' }, is_correct: false },
          ],
        },
      },
      {
        id: 'q-good',
        category_id: categoryId,
        difficulty: 'easy',
        prompt: { en: 'Which city is AC Milan based in?' },
        explanation: null,
        category_name: { en: 'Serie A' },
        payload: {
          type: 'mcq_single',
          options: [
            { id: 'a', text: { en: 'Turin' }, is_correct: false },
            { id: 'b', text: { en: 'Milan' }, is_correct: true },
            { id: 'c', text: { en: 'Rome' }, is_correct: false },
            { id: 'd', text: { en: 'Naples' }, is_correct: false },
          ],
        },
      },
    ]);

    const { dailyChallengesService } = await import('../../src/modules/daily-challenges/daily-challenges.service.js');
    const session = await dailyChallengesService.getChallengeSession('user-1', 'moneyDrop');

    expect(session.questions).toHaveLength(1);
    expect(session.questions[0]?.id).toBe('q-good');
  });

  it('allows dev reset only for admins', async () => {
    const { dailyChallengesService } = await import('../../src/modules/daily-challenges/daily-challenges.service.js');

    expect(() => dailyChallengesService.assertDevResetAllowed('admin')).not.toThrow();
    expect(() => dailyChallengesService.assertDevResetAllowed('user')).toThrow();
  });

  it('resets today completion for the dev user flow', async () => {
    const { dailyChallengesService } = await import('../../src/modules/daily-challenges/daily-challenges.service.js');

    const resetResult = await dailyChallengesService.resetChallengeForToday('user-1', 'moneyDrop');
    expect(deleteCompletionForUserOnDayMock).toHaveBeenCalledWith(
      'user-1',
      'moneyDrop',
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/)
    );
    expect(resetResult).toEqual({
      challengeType: 'moneyDrop',
      reset: true,
    });
  });
});
