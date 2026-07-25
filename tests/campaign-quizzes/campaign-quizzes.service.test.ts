import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/modules/campaign-quizzes/campaign-quizzes.repo.js', () => ({
  campaignQuizzesRepo: {
    getPublishedQuiz: vi.fn(),
    getPublishedQuestions: vi.fn(),
    getPublishedQuestion: vi.fn(),
    getRating: vi.fn(),
    upsertRating: vi.fn(),
    upsertGuestRating: vi.fn(),
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

  it('exposes the club sequence for career-path questions', async () => {
    const careerRows = [
      { answer: 'Steven Gerrard', clubs: ['Liverpool', 'LA Galaxy'] },
      { answer: 'Thierry Henry', clubs: ['Monaco', 'Juventus', 'Arsenal'] },
      { answer: 'Patrick Vieira', clubs: ['Cannes', 'AC Milan', 'Arsenal'] },
      { answer: 'Edgar Davids', clubs: ['Ajax', 'AC Milan', 'Juventus'] },
    ].map((entry, index) => ({
      ...question,
      id: `6c6b8d10-8b8e-4d12-9a91-00000000000${index + 1}`,
      display_order: index + 1,
      prompt: { en: 'Guess the player' },
      payload: {
        type: 'career_path' as const,
        clubs: entry.clubs.map((club) => ({ en: club })),
        display_answer: { en: entry.answer },
        accepted_answers: [entry.answer],
      },
    }));
    vi.mocked(campaignQuizzesRepo.getPublishedQuestions).mockResolvedValue(careerRows);

    const quiz = await campaignQuizzesService.getQuiz('career-path');

    // The prompt alone ("Guess the player") carries no information, so the
    // club sequence must reach the client or the question is unanswerable.
    expect(quiz.questions[0]).toMatchObject({
      type: 'career_path',
      details: ['Liverpool', 'LA Galaxy'],
    });
    expect(quiz.questions[0].options).toHaveLength(4);
    expect(JSON.stringify(quiz)).not.toContain('accepted_answers');
  });

  it('rejects an option that does not belong to the question', async () => {
    await expect(
      campaignQuizzesService.answer('liverpool', question.id, 'not-an-option'),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('accepts a guest rating keyed by a hash rather than the raw address', async () => {
    await expect(
      campaignQuizzesService.rateAsGuest('liverpool', '203.0.113.7', 4),
    ).resolves.toEqual({ average: 4.75, count: 12 });

    expect(campaignQuizzesRepo.upsertGuestRating).toHaveBeenCalledTimes(1);
    const [slug, guestKey, rating] = vi.mocked(
      campaignQuizzesRepo.upsertGuestRating,
    ).mock.calls[0];
    expect(slug).toBe('liverpool');
    expect(rating).toBe(4);
    expect(guestKey).toMatch(/^[a-f0-9]{64}$/);
    expect(guestKey).not.toContain('203.0.113.7');
  });

  it('gives the same guest a stable key per quiz but not across quizzes', async () => {
    await campaignQuizzesService.rateAsGuest('liverpool', '203.0.113.7', 4);
    await campaignQuizzesService.rateAsGuest('liverpool', '203.0.113.7', 2);
    await campaignQuizzesService.rateAsGuest('tottenham', '203.0.113.7', 5);

    const keys = vi
      .mocked(campaignQuizzesRepo.upsertGuestRating)
      .mock.calls.map((call) => call[1]);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it('declines a guest rating when no client address can be resolved', async () => {
    await expect(
      campaignQuizzesService.rateAsGuest('liverpool', undefined, 5),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(campaignQuizzesRepo.upsertGuestRating).not.toHaveBeenCalled();
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
