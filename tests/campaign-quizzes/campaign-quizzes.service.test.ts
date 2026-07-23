import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/modules/campaign-quizzes/campaign-quizzes.repo.js', () => ({
  campaignQuizzesRepo: {
    getPublishedQuiz: vi.fn(),
    getPublishedQuestions: vi.fn(),
    getPublishedQuestion: vi.fn(),
    getRating: vi.fn(),
    upsertRating: vi.fn(),
  },
}));

import { campaignQuizzesRepo } from '../../src/modules/campaign-quizzes/campaign-quizzes.repo.js';
import { campaignQuizzesService } from '../../src/modules/campaign-quizzes/campaign-quizzes.service.js';

const question = {
  id: '6c6b8d10-8b8e-4d12-9a10-000000000001',
  display_order: 1,
  difficulty: 'easy' as const,
  prompt: { en: 'Who managed Liverpool?' },
  explanation: { en: 'Jürgen Klopp managed Liverpool.' },
  payload: {
    type: 'mcq_single',
    options: [
      { id: 'a', text: { en: 'Rafael Benítez' }, is_correct: false },
      { id: 'b', text: { en: 'Jürgen Klopp' }, is_correct: true },
      { id: 'c', text: { en: 'Brendan Rodgers' }, is_correct: false },
      { id: 'd', text: { en: 'Steven Gerrard' }, is_correct: false },
    ],
  },
};

describe('campaignQuizzesService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(campaignQuizzesRepo.getPublishedQuiz).mockResolvedValue({
      slug: 'liverpool',
      title: 'Liverpool Quiz',
    });
    vi.mocked(campaignQuizzesRepo.getPublishedQuestions).mockResolvedValue([question]);
    vi.mocked(campaignQuizzesRepo.getPublishedQuestion).mockResolvedValue(question);
    vi.mocked(campaignQuizzesRepo.getRating).mockResolvedValue({
      average: '4.75',
      count: 12,
    });
  });

  it('returns crawlable prompts and options without leaking the answer key', async () => {
    const quiz = await campaignQuizzesService.getQuiz('liverpool');

    expect(quiz.questions).toEqual([
      {
        id: question.id,
        position: 1,
        difficulty: 'easy',
        type: 'mcq_single',
        prompt: 'Who managed Liverpool?',
        details: [],
        image_url: null,
        options: [
          { id: 'a', text: 'Rafael Benítez' },
          { id: 'b', text: 'Jürgen Klopp' },
          { id: 'c', text: 'Brendan Rodgers' },
          { id: 'd', text: 'Steven Gerrard' },
        ],
      },
    ]);
    expect(JSON.stringify(quiz)).not.toContain('is_correct');
    expect(quiz.rating).toEqual({ average: 4.75, count: 12 });
  });

  it('skips a malformed campaign question without failing the whole quiz', async () => {
    vi.mocked(campaignQuizzesRepo.getPublishedQuestions).mockResolvedValue([
      {
        ...question,
        id: '6c6b8d10-8b8e-4d12-9a10-000000000002',
        payload: null,
      },
      {
        ...question,
        display_order: 2,
      },
    ]);

    const quiz = await campaignQuizzesService.getQuiz('liverpool');

    expect(quiz.total_questions).toBe(1);
    expect(quiz.questions).toHaveLength(1);
    expect(quiz.questions[0]).toMatchObject({
      id: question.id,
      position: 2,
    });
  });

  it('reveals the correct option only after an answer is submitted', async () => {
    await expect(
      campaignQuizzesService.answer('liverpool', question.id, 'a'),
    ).resolves.toEqual({
      correct: false,
      correct_option_id: 'b',
      explanation: 'Jürgen Klopp managed Liverpool.',
    });
  });

  it('supports the approved two-option true-or-false campaign format', async () => {
    const trueFalseQuestion = {
      ...question,
      payload: {
        type: 'true_false' as const,
        options: [
          { id: 'true' as const, text: { en: 'True' }, is_correct: true },
          { id: 'false' as const, text: { en: 'False' }, is_correct: false },
        ],
      },
    };
    vi.mocked(campaignQuizzesRepo.getPublishedQuestions).mockResolvedValue([
      trueFalseQuestion,
    ]);

    await expect(
      campaignQuizzesService.answer('tottenham', question.id, 'false'),
    ).resolves.toEqual({
      correct: false,
      correct_option_id: 'true',
      explanation: 'Jürgen Klopp managed Liverpool.',
    });
  });

  it('builds hidden-answer options from existing clue-chain questions', async () => {
    const clueRows = ['Ronaldo', 'Roberto Baggio', 'Thierry Henry', 'Zinedine Zidane'].map(
      (answer, index) => ({
        ...question,
        id: `6c6b8d10-8b8e-4d12-9a90-00000000000${index + 1}`,
        display_order: index + 1,
        prompt: { en: `Player clue ${index + 1}` },
        payload: {
          type: 'clue_chain' as const,
          clues: [
            { type: 'text' as const, content: { en: `Player clue ${index + 1}` } },
            { type: 'text' as const, content: { en: `Extra clue ${index + 1}` } },
          ],
          display_answer: { en: answer },
          accepted_answers: [answer],
        },
      }),
    );
    vi.mocked(campaignQuizzesRepo.getPublishedQuestions).mockResolvedValue(clueRows);

    const quiz = await campaignQuizzesService.getQuiz('guess-the-player');
    expect(quiz.questions[0]).toMatchObject({
      type: 'clue_chain',
      prompt: 'Player clue 1',
      details: ['Extra clue 1'],
    });
    expect(quiz.questions[0].options).toHaveLength(4);
    expect(quiz.questions[0].options.map((option) => option.text)).toContain('Ronaldo');
    expect(JSON.stringify(quiz)).not.toContain('accepted_answers');

    const correctOption = quiz.questions[0].options.find(
      (option) => option.text === 'Ronaldo',
    );
    await expect(
      campaignQuizzesService.answer(
        'guess-the-player',
        clueRows[0].id,
        correctOption?.id ?? '',
      ),
    ).resolves.toMatchObject({
      correct: true,
      explanation: 'Jürgen Klopp managed Liverpool.',
    });
  });

  it('rejects an option that does not belong to the question', async () => {
    await expect(
      campaignQuizzesService.answer('liverpool', question.id, 'not-an-option'),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('upserts one account-bound rating and returns the new aggregate', async () => {
    await expect(
      campaignQuizzesService.rate('liverpool', 'user-1', 5),
    ).resolves.toEqual({ average: 4.75, count: 12 });

    expect(campaignQuizzesRepo.upsertRating).toHaveBeenCalledWith(
      'liverpool',
      'user-1',
      5,
    );
  });
});
