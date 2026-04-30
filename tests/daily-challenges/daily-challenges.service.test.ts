import { beforeEach, describe, expect, it, vi } from 'vitest';

import '../setup.js';

const runInTransactionMock = vi.fn();
const listConfigsMock = vi.fn();
const listCompletionsForUserOnDayMock = vi.fn();
const getConfigMock = vi.fn();
const getCompletionForUserOnDayMock = vi.fn();
const listPublishedQuestionsByTypeAndCategoriesMock = vi.fn();
const listAvailableCategoriesByQuestionTypeMock = vi.fn();
const countPublishedQuestionsByTypeAndCategoriesMock = vi.fn();
const createCompletionMock = vi.fn();
const addCoinsMock = vi.fn();
const grantXpMock = vi.fn();
const deleteCompletionForUserOnDayMock = vi.fn();
const upsertConfigMock = vi.fn();
const listByIdsMock = vi.fn();

vi.mock('../../src/modules/daily-challenges/daily-challenges.repo.js', () => ({
  dailyChallengesRepo: {
    runInTransaction: (...args: unknown[]) => runInTransactionMock(...args),
    listConfigs: (...args: unknown[]) => listConfigsMock(...args),
    listCompletionsForUserOnDay: (...args: unknown[]) => listCompletionsForUserOnDayMock(...args),
    getConfig: (...args: unknown[]) => getConfigMock(...args),
    getCompletionForUserOnDay: (...args: unknown[]) => getCompletionForUserOnDayMock(...args),
    listPublishedQuestionsByTypeAndCategories: (...args: unknown[]) => listPublishedQuestionsByTypeAndCategoriesMock(...args),
    listAvailableCategoriesByQuestionType: (...args: unknown[]) => listAvailableCategoriesByQuestionTypeMock(...args),
    countPublishedQuestionsByTypeAndCategories: (...args: unknown[]) => countPublishedQuestionsByTypeAndCategoriesMock(...args),
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
    runInTransactionMock.mockImplementation(async (callback: (txRepo: {
      getCompletionForUserOnDay: typeof getCompletionForUserOnDayMock;
      createCompletion: typeof createCompletionMock;
      addCoins: typeof addCoinsMock;
      grantXp: typeof grantXpMock;
    }) => Promise<unknown>) => callback({
      getCompletionForUserOnDay: (...args: unknown[]) => getCompletionForUserOnDayMock(...args),
      createCompletion: (...args: unknown[]) => createCompletionMock(...args),
      addCoins: (...args: unknown[]) => addCoinsMock(...args),
      grantXp: (...args: unknown[]) => grantXpMock(...args),
    }));
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

  it('ignores legacy daily challenge configs that are no longer supported', async () => {
    listConfigsMock.mockResolvedValue([
      {
        challenge_type: 'footballJeopardy',
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
        challenge_type: 'footballLogic',
        is_active: true,
        sort_order: 2,
        show_on_home: true,
        coin_reward: 100,
        xp_reward: 20,
        settings: {
          categoryIds: [],
          questionCount: 1,
          secondsPerQuestion: 30,
        },
        created_at: '2026-03-15T00:00:00.000Z',
        updated_at: '2026-03-15T00:00:00.000Z',
      },
    ]);
    listAvailableCategoriesByQuestionTypeMock.mockResolvedValue([]);

    const { dailyChallengesService } = await import('../../src/modules/daily-challenges/daily-challenges.service.js');
    const result = await dailyChallengesService.listAdminConfigs();

    expect(result).toHaveLength(1);
    expect(result[0]?.challengeType).toBe('footballLogic');
    expect(listAvailableCategoriesByQuestionTypeMock).toHaveBeenCalledTimes(1);
    expect(listAvailableCategoriesByQuestionTypeMock).toHaveBeenCalledWith('football_logic');
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

  it('builds a true false session from available categories when config categoryIds is empty', async () => {
    getConfigMock.mockResolvedValue({
      challenge_type: 'trueFalse',
      is_active: true,
      sort_order: 2,
      show_on_home: true,
      coin_reward: 400,
      xp_reward: 100,
      settings: {
        categoryIds: [],
        questionCount: 2,
        secondsPerQuestion: 12,
      },
      created_at: '2026-03-15T00:00:00.000Z',
      updated_at: '2026-03-15T00:00:00.000Z',
    });
    getCompletionForUserOnDayMock.mockResolvedValue(null);
    listPublishedQuestionsByTypeAndCategoriesMock.mockResolvedValue([
      {
        id: 'cat-1-easy',
        category_id: '11111111-1111-1111-1111-111111111111',
        difficulty: 'easy',
        prompt: { en: 'Easy 1' },
        explanation: null,
        category_name: { en: 'Premier League' },
        payload: {
          type: 'true_false',
          options: [
            { id: 'true', text: { en: 'True' }, is_correct: true },
            { id: 'false', text: { en: 'False' }, is_correct: false },
          ],
        },
      },
      {
        id: 'cat-1-medium',
        category_id: '11111111-1111-1111-1111-111111111111',
        difficulty: 'medium',
        prompt: { en: 'Medium 1' },
        explanation: null,
        category_name: { en: 'Premier League' },
        payload: {
          type: 'true_false',
          options: [
            { id: 'true', text: { en: 'True' }, is_correct: false },
            { id: 'false', text: { en: 'False' }, is_correct: true },
          ],
        },
      },
      {
        id: 'cat-1-hard',
        category_id: '11111111-1111-1111-1111-111111111111',
        difficulty: 'hard',
        prompt: { en: 'Hard 1' },
        explanation: null,
        category_name: { en: 'Premier League' },
        payload: {
          type: 'true_false',
          options: [
            { id: 'true', text: { en: 'True' }, is_correct: true },
            { id: 'false', text: { en: 'False' }, is_correct: false },
          ],
        },
      },
      {
        id: 'cat-2-easy',
        category_id: '22222222-2222-2222-2222-222222222222',
        difficulty: 'easy',
        prompt: { en: 'Easy 2' },
        explanation: null,
        category_name: { en: 'La Liga' },
        payload: {
          type: 'true_false',
          options: [
            { id: 'true', text: { en: 'True' }, is_correct: false },
            { id: 'false', text: { en: 'False' }, is_correct: true },
          ],
        },
      },
      {
        id: 'cat-2-medium',
        category_id: '22222222-2222-2222-2222-222222222222',
        difficulty: 'medium',
        prompt: { en: 'Medium 2' },
        explanation: null,
        category_name: { en: 'La Liga' },
        payload: {
          type: 'true_false',
          options: [
            { id: 'true', text: { en: 'True' }, is_correct: true },
            { id: 'false', text: { en: 'False' }, is_correct: false },
          ],
        },
      },
      {
        id: 'cat-2-hard',
        category_id: '22222222-2222-2222-2222-222222222222',
        difficulty: 'hard',
        prompt: { en: 'Hard 2' },
        explanation: null,
        category_name: { en: 'La Liga' },
        payload: {
          type: 'true_false',
          options: [
            { id: 'true', text: { en: 'True' }, is_correct: false },
            { id: 'false', text: { en: 'False' }, is_correct: true },
          ],
        },
      },
      {
        id: 'cat-3-easy',
        category_id: '33333333-3333-3333-3333-333333333333',
        difficulty: 'easy',
        prompt: { en: 'Easy 3' },
        explanation: null,
        category_name: { en: 'Serie A' },
        payload: {
          type: 'true_false',
          options: [
            { id: 'true', text: { en: 'True' }, is_correct: true },
            { id: 'false', text: { en: 'False' }, is_correct: false },
          ],
        },
      },
      {
        id: 'cat-3-medium',
        category_id: '33333333-3333-3333-3333-333333333333',
        difficulty: 'medium',
        prompt: { en: 'Medium 3' },
        explanation: null,
        category_name: { en: 'Serie A' },
        payload: {
          type: 'true_false',
          options: [
            { id: 'true', text: { en: 'True' }, is_correct: false },
            { id: 'false', text: { en: 'False' }, is_correct: true },
          ],
        },
      },
      {
        id: 'cat-3-hard',
        category_id: '33333333-3333-3333-3333-333333333333',
        difficulty: 'hard',
        prompt: { en: 'Hard 3' },
        explanation: null,
        category_name: { en: 'Serie A' },
        payload: {
          type: 'true_false',
          options: [
            { id: 'true', text: { en: 'True' }, is_correct: true },
            { id: 'false', text: { en: 'False' }, is_correct: false },
          ],
        },
      },
    ]);

    const { dailyChallengesService } = await import('../../src/modules/daily-challenges/daily-challenges.service.js');
    const session = await dailyChallengesService.getChallengeSession('user-1', 'trueFalse');

    expect(session.challengeType).toBe('trueFalse');
    expect(session.questionCount).toBe(2);
    expect(session.questions).toHaveLength(2);
    expect(session.questions[0]).toEqual(
      expect.objectContaining({
        trueLabel: expect.any(String),
        falseLabel: expect.any(String),
        correctAnswer: expect.any(Boolean),
      })
    );
  });

  it('uses plain string prompts for true false sessions instead of the fallback label', async () => {
    getConfigMock.mockResolvedValue({
      challenge_type: 'trueFalse',
      is_active: true,
      sort_order: 2,
      show_on_home: true,
      coin_reward: 400,
      xp_reward: 100,
      settings: {
        categoryIds: [],
        questionCount: 1,
        secondsPerQuestion: 12,
      },
      created_at: '2026-03-15T00:00:00.000Z',
      updated_at: '2026-03-15T00:00:00.000Z',
    });
    getCompletionForUserOnDayMock.mockResolvedValue(null);
    countPublishedQuestionsByTypeAndCategoriesMock.mockResolvedValue(1);
    listPublishedQuestionsByTypeAndCategoriesMock.mockResolvedValue([
      {
        id: 'true-false-plain-prompt',
        category_id: '11111111-1111-1111-1111-111111111111',
        difficulty: 'easy',
        prompt: 'Paris Saint-Germain won the UEFA Champions League in 2025.',
        explanation: null,
        category_name: { en: 'True or False' },
        payload: {
          type: 'true_false',
          options: [
            { id: 'true', text: { en: 'True' }, is_correct: true },
            { id: 'false', text: { en: 'False' }, is_correct: false },
          ],
        },
      },
    ]);

    const { dailyChallengesService } = await import('../../src/modules/daily-challenges/daily-challenges.service.js');
    const session = await dailyChallengesService.getChallengeSession('user-1', 'trueFalse');

    expect(session.questions).toHaveLength(1);
    expect(session.questions[0]?.prompt).toBe('Paris Saint-Germain won the UEFA Champions League in 2025.');
    expect(session.questions[0]?.prompt).not.toBe('Question');
  });

  it('unwraps stringified localized prompts for true false sessions', async () => {
    getConfigMock.mockResolvedValue({
      challenge_type: 'trueFalse',
      is_active: true,
      sort_order: 2,
      show_on_home: true,
      coin_reward: 400,
      xp_reward: 100,
      settings: {
        categoryIds: [],
        questionCount: 1,
        secondsPerQuestion: 12,
      },
      created_at: '2026-03-15T00:00:00.000Z',
      updated_at: '2026-03-15T00:00:00.000Z',
    });
    getCompletionForUserOnDayMock.mockResolvedValue(null);
    countPublishedQuestionsByTypeAndCategoriesMock.mockResolvedValue(1);
    listPublishedQuestionsByTypeAndCategoriesMock.mockResolvedValue([
      {
        id: 'true-false-stringified-prompt',
        category_id: '11111111-1111-1111-1111-111111111111',
        difficulty: 'easy',
        prompt: JSON.stringify({
          en: 'Lionel Messi won the 2022 World Cup Golden Boot.',
          ka: 'ლიონელ მესიმ 2022 წლის მსოფლიო ჩემპიონატის ოქროს ბუცი მოიგო.',
        }),
        explanation: null,
        category_name: { en: 'True or False' },
        payload: {
          type: 'true_false',
          options: [
            { id: 'true', text: { en: 'True' }, is_correct: false },
            { id: 'false', text: { en: 'False' }, is_correct: true },
          ],
        },
      },
    ]);

    const { dailyChallengesService } = await import('../../src/modules/daily-challenges/daily-challenges.service.js');
    const session = await dailyChallengesService.getChallengeSession('user-1', 'trueFalse', 'en');

    expect(session.questions).toHaveLength(1);
    expect(session.questions[0]?.prompt).toBe('Lionel Messi won the 2022 World Cup Golden Boot.');
  });

  it('builds a countdown session from uploaded countdown list content', async () => {
    getConfigMock.mockResolvedValue({
      challenge_type: 'countdown',
      is_active: true,
      settings: {
        categoryIds: [],
        roundCount: 1,
        secondsPerRound: 45,
      },
    });
    getCompletionForUserOnDayMock.mockResolvedValue(null);
    listPublishedQuestionsByTypeAndCategoriesMock.mockResolvedValue([
      {
        id: 'countdown-1',
        category_id: '11111111-1111-1111-1111-111111111111',
        difficulty: 'easy',
        prompt: { en: 'Name Ballon d’Or winners' },
        explanation: null,
        category_name: { en: 'Awards' },
        payload: {
          type: 'countdown_list',
          prompt: { en: 'Ballon d’Or winners' },
          answer_groups: [
            {
              id: 'messi',
              display: { en: 'Lionel Messi' },
              accepted_answers: ['Lionel Messi', 'Messi'],
            },
          ],
        },
      },
    ]);

    const { dailyChallengesService } = await import('../../src/modules/daily-challenges/daily-challenges.service.js');
    const session = await dailyChallengesService.getChallengeSession('user-1', 'countdown');

    expect(session).toEqual(
      expect.objectContaining({
        challengeType: 'countdown',
        roundCount: 1,
        secondsPerRound: 45,
        rounds: [
          expect.objectContaining({
            id: 'countdown-1',
            prompt: 'Ballon d’Or winners',
            answerGroups: [
              {
                id: 'messi',
                display: 'Lionel Messi',
                acceptedAnswers: ['Lionel Messi', 'Messi'],
              },
            ],
          }),
        ],
      })
    );
  });

  it('builds a clues session from uploaded clue chain content', async () => {
    getConfigMock.mockResolvedValue({
      challenge_type: 'clues',
      is_active: true,
      settings: {
        categoryIds: [],
        questionCount: 1,
        secondsPerClueStep: 10,
      },
    });
    getCompletionForUserOnDayMock.mockResolvedValue(null);
    listPublishedQuestionsByTypeAndCategoriesMock.mockResolvedValue([
      {
        id: 'clue-1',
        category_id: '11111111-1111-1111-1111-111111111111',
        difficulty: 'medium',
        prompt: { en: 'Guess the player' },
        explanation: null,
        category_name: { en: 'Players' },
        payload: {
          type: 'clue_chain',
          display_answer: { en: 'Petr Cech' },
          accepted_answers: ['Petr Cech', 'Cech'],
          clues: [
            { type: 'text', content: { en: 'Protective headgear' } },
            { type: 'text', content: { en: 'Drummer' } },
          ],
        },
      },
    ]);

    const { dailyChallengesService } = await import('../../src/modules/daily-challenges/daily-challenges.service.js');
    const session = await dailyChallengesService.getChallengeSession('user-1', 'clues');

    expect(session).toEqual(
      expect.objectContaining({
        challengeType: 'clues',
        questionCount: 1,
        secondsPerClueStep: 10,
        questions: [
          expect.objectContaining({
            displayAnswer: 'Petr Cech',
            acceptedAnswers: ['Petr Cech', 'Cech'],
            clues: [
              { type: 'text', content: 'Protective headgear' },
              { type: 'text', content: 'Drummer' },
            ],
          }),
        ],
      })
    );
  });

  it('builds a put in order session from uploaded ordering content', async () => {
    getConfigMock.mockResolvedValue({
      challenge_type: 'putInOrder',
      is_active: true,
      settings: {
        categoryIds: [],
        roundCount: 1,
        itemsPerRound: 3,
      },
    });
    getCompletionForUserOnDayMock.mockResolvedValue(null);
    listPublishedQuestionsByTypeAndCategoriesMock.mockResolvedValue([
      {
        id: 'order-1',
        category_id: '11111111-1111-1111-1111-111111111111',
        difficulty: 'hard',
        prompt: { en: 'Order by transfer year' },
        explanation: null,
        category_name: { en: 'Transfers' },
        payload: {
          type: 'put_in_order',
          prompt: { en: 'Order by transfer year' },
          direction: 'asc',
          items: [
            { id: 'ronaldo', label: { en: 'Ronaldo to Real Madrid' }, details: null, emoji: null, sort_value: 2009 },
            { id: 'neymar', label: { en: 'Neymar to PSG' }, details: null, emoji: null, sort_value: 2017 },
            { id: 'mbappe', label: { en: 'Mbappe to Real Madrid' }, details: null, emoji: null, sort_value: 2024 },
          ],
        },
      },
    ]);

    const { dailyChallengesService } = await import('../../src/modules/daily-challenges/daily-challenges.service.js');
    const session = await dailyChallengesService.getChallengeSession('user-1', 'putInOrder');

    expect(session.challengeType).toBe('putInOrder');
    expect(session.rounds).toHaveLength(1);
    expect(session.rounds[0]).toEqual(
      expect.objectContaining({
        id: 'order-1',
        prompt: 'Order by transfer year',
        direction: 'asc',
        items: expect.arrayContaining([
          expect.objectContaining({ id: 'ronaldo', label: 'Ronaldo to Real Madrid', sortValue: 2009 }),
          expect.objectContaining({ id: 'neymar', label: 'Neymar to PSG', sortValue: 2017 }),
          expect.objectContaining({ id: 'mbappe', label: 'Mbappe to Real Madrid', sortValue: 2024 }),
        ]),
      })
    );
  });

  it('builds an imposter session from uploaded multi-select content', async () => {
    getConfigMock.mockResolvedValue({
      challenge_type: 'imposter',
      is_active: true,
      settings: {
        categoryIds: [],
        questionCount: 1,
        secondsPerQuestion: 20,
      },
    });
    getCompletionForUserOnDayMock.mockResolvedValue(null);
    listPublishedQuestionsByTypeAndCategoriesMock.mockResolvedValue([
      {
        id: 'imposter-1',
        category_id: '11111111-1111-1111-1111-111111111111',
        difficulty: 'medium',
        prompt: { en: "Which players have won the Ballon d'Or?" },
        explanation: null,
        category_name: { en: 'Awards' },
        payload: {
          type: 'imposter_multi_select',
          options: [
            { id: 'messi', text: { en: 'Lionel Messi' }, is_correct: true },
            { id: 'ronaldo', text: { en: 'Cristiano Ronaldo' }, is_correct: true },
            { id: 'xavi', text: { en: 'Xavi Hernandez' }, is_correct: false },
            { id: 'henry', text: { en: 'Thierry Henry' }, is_correct: false },
          ],
        },
      },
    ]);

    const { dailyChallengesService } = await import('../../src/modules/daily-challenges/daily-challenges.service.js');
    const session = await dailyChallengesService.getChallengeSession('user-1', 'imposter');

    expect(session).toEqual(
      expect.objectContaining({
        challengeType: 'imposter',
        questions: [
          expect.objectContaining({
            prompt: "Which players have won the Ballon d'Or?",
            options: [
              { id: 'messi', text: 'Lionel Messi' },
              { id: 'ronaldo', text: 'Cristiano Ronaldo' },
              { id: 'xavi', text: 'Xavi Hernandez' },
              { id: 'henry', text: 'Thierry Henry' },
            ],
            correctOptionIds: ['messi', 'ronaldo'],
          }),
        ],
      })
    );
  });

  it('builds a career path session from uploaded club path content', async () => {
    getConfigMock.mockResolvedValue({
      challenge_type: 'careerPath',
      is_active: true,
      settings: {
        categoryIds: [],
        questionCount: 1,
        secondsPerQuestion: 25,
      },
    });
    getCompletionForUserOnDayMock.mockResolvedValue(null);
    listPublishedQuestionsByTypeAndCategoriesMock.mockResolvedValue([
      {
        id: 'career-1',
        category_id: '11111111-1111-1111-1111-111111111111',
        difficulty: 'easy',
        prompt: { en: 'Who followed this path?' },
        explanation: null,
        category_name: { en: 'Careers' },
        payload: {
          type: 'career_path',
          clubs: [{ en: 'Birmingham City' }, { en: 'Borussia Dortmund' }, { en: 'Real Madrid' }],
          display_answer: { en: 'Jude Bellingham' },
          accepted_answers: ['Jude Bellingham', 'Bellingham'],
        },
      },
    ]);

    const { dailyChallengesService } = await import('../../src/modules/daily-challenges/daily-challenges.service.js');
    const session = await dailyChallengesService.getChallengeSession('user-1', 'careerPath');

    expect(session).toEqual(
      expect.objectContaining({
        challengeType: 'careerPath',
        questions: [
          expect.objectContaining({
            clubs: ['Birmingham City', 'Borussia Dortmund', 'Real Madrid'],
            displayAnswer: 'Jude Bellingham',
            acceptedAnswers: ['Jude Bellingham', 'Bellingham'],
          }),
        ],
      })
    );
  });

  it('builds a high low session from uploaded matchup content', async () => {
    getConfigMock.mockResolvedValue({
      challenge_type: 'highLow',
      is_active: true,
      settings: {
        categoryIds: [],
        roundCount: 1,
        secondsPerRound: 30,
      },
    });
    getCompletionForUserOnDayMock.mockResolvedValue(null);
    listPublishedQuestionsByTypeAndCategoriesMock.mockResolvedValue([
      {
        id: 'high-low-1',
        category_id: '11111111-1111-1111-1111-111111111111',
        difficulty: 'medium',
        prompt: { en: 'Who has more Premier League goals?' },
        explanation: null,
        category_name: { en: 'Premier League' },
        payload: {
          type: 'high_low',
          stat_label: { en: 'All-time Premier League goals' },
          matchups: [
            {
              id: 'owen-v-rvp',
              left_name: { en: 'Michael Owen' },
              left_value: 150,
              right_name: { en: 'Robin van Persie' },
              right_value: 144,
            },
          ],
        },
      },
    ]);

    const { dailyChallengesService } = await import('../../src/modules/daily-challenges/daily-challenges.service.js');
    const session = await dailyChallengesService.getChallengeSession('user-1', 'highLow');

    expect(session).toEqual(
      expect.objectContaining({
        challengeType: 'highLow',
        rounds: [
          expect.objectContaining({
            statLabel: 'All-time Premier League goals',
            matchups: [
              {
                id: 'owen-v-rvp',
                leftName: 'Michael Owen',
                leftValue: 150,
                rightName: 'Robin van Persie',
                rightValue: 144,
              },
            ],
          }),
        ],
      })
    );
  });

  it('builds a football logic session from uploaded image clue content', async () => {
    getConfigMock.mockResolvedValue({
      challenge_type: 'footballLogic',
      is_active: true,
      settings: {
        categoryIds: [],
        questionCount: 1,
        secondsPerQuestion: 30,
      },
    });
    getCompletionForUserOnDayMock.mockResolvedValue(null);
    listPublishedQuestionsByTypeAndCategoriesMock.mockResolvedValue([
      {
        id: 'logic-1',
        category_id: '11111111-1111-1111-1111-111111111111',
        difficulty: 'hard',
        prompt: { en: 'Decode the player' },
        explanation: { en: 'Five goals in nine minutes.' },
        category_name: { en: 'Logic' },
        payload: {
          type: 'football_logic',
          image_a_url: 'https://cdn.example.com/stopwatch.png',
          image_b_url: 'https://cdn.example.com/five.png',
          display_answer: { en: 'Robert Lewandowski' },
          accepted_answers: ['Robert Lewandowski', 'Lewandowski'],
          prompt: { en: 'Who is this?' },
          explanation: { en: 'Bundesliga record: five goals in nine minutes.' },
        },
      },
    ]);

    const { dailyChallengesService } = await import('../../src/modules/daily-challenges/daily-challenges.service.js');
    const session = await dailyChallengesService.getChallengeSession('user-1', 'footballLogic');

    expect(session).toEqual(
      expect.objectContaining({
        challengeType: 'footballLogic',
        questions: [
          expect.objectContaining({
            prompt: 'Decode the player',
            imageAUrl: 'https://cdn.example.com/stopwatch.png',
            imageBUrl: 'https://cdn.example.com/five.png',
            displayAnswer: 'Robert Lewandowski',
            acceptedAnswers: ['Robert Lewandowski', 'Lewandowski'],
            explanation: 'Bundesliga record: five goals in nine minutes.',
          }),
        ],
      })
    );
  });

  it('completes a challenge once and awards configured coins', async () => {
    getConfigMock.mockResolvedValue({
      challenge_type: 'countdown',
      is_active: true,
      coin_reward: 80,
      xp_reward: 15,
    });
    getCompletionForUserOnDayMock.mockResolvedValue(null);
    createCompletionMock.mockResolvedValue({
      id: 'completion-1',
    });
    addCoinsMock.mockResolvedValue({
      coins: 1080,
      tickets: 10,
    });
    grantXpMock.mockResolvedValue({
      awarded: true,
      totalXp: 215,
    });

    const { dailyChallengesService } = await import('../../src/modules/daily-challenges/daily-challenges.service.js');
    const result = await dailyChallengesService.completeChallenge('user-1', 'countdown', 500);

    expect(runInTransactionMock).toHaveBeenCalled();
    expect(createCompletionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        challengeType: 'countdown',
        score: 500,
        coinsAwarded: 80,
        xpAwarded: 15,
      })
    );
    expect(addCoinsMock).toHaveBeenCalledWith('user-1', 80);
    expect(grantXpMock).toHaveBeenCalledWith({
      userId: 'user-1',
      sourceType: 'daily_challenge_completion',
      sourceKey: expect.stringMatching(/^countdown:\d{4}-\d{2}-\d{2}$/),
      xpDelta: 15,
      metadata: {
        challengeType: 'countdown',
        challengeDay: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      },
    });
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
    createCompletionMock.mockRejectedValue({ code: '23505' });

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
