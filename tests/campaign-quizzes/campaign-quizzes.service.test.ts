import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/modules/campaign-quizzes/campaign-quizzes.repo.js', () => ({
  campaignQuizzesRepo: {
    getVisibleQuiz: vi.fn(),
    getQuestionSet: vi.fn(),
    getRelatedPages: vi.fn(),
    getAdminPage: vi.fn(),
    listAdminRelatedSlugs: vi.fn(),
    listManualQuestions: vi.fn(),
    getQuestionSetHealth: vi.fn(),
    isAttachableQuestionSet: vi.fn(),
    countQuestionSetConsumers: vi.fn(),
    slugExists: vi.fn(),
    createAdminPage: vi.fn(),
    updateAdminPage: vi.fn(),
    listAdminPages: vi.fn(),
    updateHubOrder: vi.fn(),
    createRevision: vi.fn(),
    listRevisions: vi.fn(),
    getRevision: vi.fn(),
    publish: vi.fn(),
    getPublishedQuiz: vi.fn(),
    listPublishedPages: vi.fn(),
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
  prompt: { en: 'Who managed Liverpool?', es: '¿Quién entrenó al Liverpool?' },
  explanation: {
    en: 'Jürgen Klopp managed Liverpool.',
    es: 'Jürgen Klopp entrenó al Liverpool.',
  },
  payload: {
    type: 'mcq_single',
    options: [
      { id: 'a', text: { en: 'Rafael Benítez', es: 'Rafael Benítez' }, is_correct: false },
      { id: 'b', text: { en: 'Jürgen Klopp', es: 'Jürgen Klopp' }, is_correct: true },
      { id: 'c', text: { en: 'Brendan Rodgers' }, is_correct: false },
      { id: 'd', text: { en: 'Steven Gerrard' }, is_correct: false },
    ],
  },
};

const quizRow = {
  slug: 'liverpool',
  title: 'Liverpool Quiz',
  internal_name: 'Liverpool Quiz',
  page_category: 'team' as const,
  status: 'published' as const,
  question_source: 'existing' as const,
  question_set_slug: 'liverpool',
  h1: 'Liverpool Quiz',
  lede: null,
  about_heading: null,
  about_blocks: [],
  score_cta: null,
  footer_banner_text: null,
  footer_button_label: 'Play Ranked',
  hero_image_url: null,
  hero_image_alt: null,
  seo_title: 'Liverpool Quiz',
  meta_description: null,
  og_image_url: null,
  og_image_alt: null,
  breadcrumb_label: 'Liverpool Quiz',
  locale_mode: 'en_only' as const,
  ka_seo_title: null,
  ka_meta_description: null,
  ka_h1: null,
  ka_lede: null,
  es_title: 'Quiz del Liverpool',
  es_h1: 'Quiz del Liverpool',
  es_seo_title: 'Quiz del Liverpool | QuizBall',
  es_meta_description: 'Quiz del Liverpool gratis.',
  es_breadcrumb_label: 'Quiz del Liverpool',
  es_lede: null,
  es_about_heading: null,
  es_about_blocks: null,
  es_hero_image_alt: null,
  es_score_cta: null,
  es_footer_banner_text: null,
  es_footer_button_label: null,
  scheduled_publish_at: null,
  published_at: new Date().toISOString(),
  unpublished_at: null,
  preview_token: 'de6bd11f-27ee-4721-9586-7f561bfd27e2',
  hub_order: 1,
  is_hub_pinned: false,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

describe('campaignQuizzesService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(campaignQuizzesRepo.getVisibleQuiz).mockResolvedValue(quizRow);
    vi.mocked(campaignQuizzesRepo.getPublishedQuiz).mockResolvedValue(quizRow);
    vi.mocked(campaignQuizzesRepo.getQuestionSet).mockResolvedValue([question]);
    vi.mocked(campaignQuizzesRepo.getRelatedPages).mockResolvedValue([]);
    vi.mocked(campaignQuizzesRepo.getRating).mockResolvedValue({
      average: '4.75',
      count: 12,
    });
    vi.mocked(campaignQuizzesRepo.isAttachableQuestionSet).mockResolvedValue(true);
    vi.mocked(campaignQuizzesRepo.countQuestionSetConsumers).mockResolvedValue(0);
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
    expect(quiz.difficulty_counts).toEqual({ easy: 1, medium: 0, hard: 0 });
  });

  it('returns managed SSR content and derives the verified count from the attached set', async () => {
    vi.mocked(campaignQuizzesRepo.getVisibleQuiz).mockResolvedValue({
      ...quizRow,
      lede: 'Play {count} verified questions.',
      about_heading: 'About this Liverpool quiz',
      about_blocks: [{ id: 'one', type: 'paragraph', text: 'Checked {count} football questions.' }],
      score_cta: 'You scored {score} from {count}.',
      footer_banner_text: 'Ready for ranked?',
      hero_image_url: 'categories/liverpool-v2.webp',
      hero_image_alt: 'Liverpool category artwork',
      meta_description: 'A free quiz with {count} verified questions.',
    });

    const quiz = await campaignQuizzesService.getQuiz('liverpool');

    expect(quiz.page).toMatchObject({
      lede: 'Play 1 verified questions.',
      meta_description: 'A free quiz with 1 verified questions.',
      hero_image_alt: 'Liverpool category artwork',
      about_blocks: [{ id: 'one', type: 'paragraph', text: 'Checked 1 football questions.' }],
    });
    expect(quiz.page?.hero_image_url).toContain('/storage/v1/object/public/imgs/categories/liverpool-v2.webp');
  });

  it('hard-blocks publishing when an attached set contains a ranked-eligible question', async () => {
    vi.mocked(campaignQuizzesRepo.getAdminPage).mockResolvedValue({
      ...quizRow,
      lede: 'A complete lede with enough copy for the page.',
      about_heading: 'About this quiz',
      about_blocks: [{ id: 'one', type: 'paragraph', text: 'About copy.' }],
      score_cta: 'You scored {score}.',
      footer_banner_text: 'Play ranked.',
      hero_image_url: 'categories/liverpool-v2.webp',
      hero_image_alt: 'Liverpool artwork',
      meta_description: 'Free Liverpool quiz.',
      question_count: 10,
    });
    vi.mocked(campaignQuizzesRepo.getQuestionSetHealth).mockResolvedValue({
      count: 10,
      public_only_count: 9,
    });

    await expect(
      campaignQuizzesService.publish('liverpool', { scheduled_publish_at: null }, 'admin-id'),
    ).rejects.toMatchObject({ statusCode: 422 });
    expect(campaignQuizzesRepo.publish).not.toHaveBeenCalled();
  });

  it('does not persist an invalid edit over a published quiz', async () => {
    vi.mocked(campaignQuizzesRepo.getAdminPage).mockResolvedValue({
      ...quizRow,
      question_count: 10,
    });
    vi.mocked(campaignQuizzesRepo.getQuestionSetHealth).mockResolvedValue({
      count: 10,
      public_only_count: 10,
    });

    await expect(
      campaignQuizzesService.updateAdmin('liverpool', {
        internal_name: 'Liverpool Quiz',
        slug: 'liverpool',
        category: 'team',
        h1: 'Liverpool Quiz',
        lede: 'Play a complete Liverpool football quiz with verified public questions covering famous players, managers, trophies and memorable matches from across the club history. Get your score instantly, compare your knowledge and keep playing more QuizBall challenges when you finish today.',
        question_source: 'existing',
        question_set_slug: 'liverpool',
        manual_questions: [],
        about_heading: 'About this Liverpool quiz',
        about_blocks: [{ id: 'intro', type: 'paragraph', text: 'Verified Liverpool football questions.' }],
        score_cta: 'You scored {score}.',
        footer_banner_text: 'Play ranked.',
        footer_button_label: 'Sign up free',
        related_slugs: [],
        hero_image_url: null,
        hero_image_alt: '',
        seo_title: 'Liverpool Quiz | QuizBall',
        meta_description: 'Free Liverpool football quiz with {count} verified questions.',
        og_image_url: null,
        og_image_alt: null,
        breadcrumb_label: 'Liverpool Quiz',
        locale_mode: 'en_only',
        ka_seo_title: null,
        ka_meta_description: null,
        ka_h1: null,
        ka_lede: null,
      }, 'admin-id'),
    ).rejects.toMatchObject({ statusCode: 422 });

    expect(campaignQuizzesRepo.updateAdminPage).not.toHaveBeenCalled();
  });

  it('returns manually managed answers only to the authenticated admin editor', async () => {
    vi.mocked(campaignQuizzesRepo.getAdminPage).mockResolvedValue({
      ...quizRow,
      question_source: 'manual',
      question_count: 1,
    });
    vi.mocked(campaignQuizzesRepo.listAdminRelatedSlugs).mockResolvedValue([]);
    vi.mocked(campaignQuizzesRepo.listManualQuestions).mockResolvedValue([question]);
    vi.mocked(campaignQuizzesRepo.getQuestionSetHealth).mockResolvedValue({
      count: 1,
      public_only_count: 1,
    });

    const page = await campaignQuizzesService.getAdmin('liverpool');

    expect(page).toMatchObject({
      question_source: 'manual',
      manual_questions: [{
        id: question.id,
        prompt: 'Who managed Liverpool?',
        difficulty: 'easy',
        options: ['Rafael Benítez', 'Jürgen Klopp', 'Brendan Rodgers', 'Steven Gerrard'],
        correct_option: 'b',
        explanation: 'Jürgen Klopp managed Liverpool.',
      }],
    });
  });

  it('does not allow a ranked-pool question set to be attached to a draft', async () => {
    vi.mocked(campaignQuizzesRepo.slugExists).mockResolvedValue(false);
    vi.mocked(campaignQuizzesRepo.getQuestionSetHealth).mockResolvedValue({
      count: 10,
      public_only_count: 9,
    });

    await expect(
      campaignQuizzesService.createAdmin({
        internal_name: 'Arsenal Quiz',
        slug: 'arsenal',
        category: 'team',
        h1: 'Arsenal Quiz',
        lede: 'A complete Arsenal quiz lede.',
        question_set_slug: 'ranked-arsenal',
        about_heading: 'About this Arsenal quiz',
        about_blocks: [{ id: 'intro', type: 'paragraph', text: 'About copy.' }],
        score_cta: 'You scored {score}.',
        footer_banner_text: 'Play ranked.',
        footer_button_label: 'Sign up free',
        related_slugs: ['liverpool', 'everton', 'tottenham'],
        hero_image_url: 'campaign-quizzes/arsenal.webp',
        hero_image_alt: 'Arsenal category artwork',
        seo_title: 'Arsenal Quiz | QuizBall',
        meta_description: 'Free Arsenal quiz.',
        og_image_url: null,
        og_image_alt: null,
        breadcrumb_label: 'Arsenal Quiz',
        locale_mode: 'en_only',
        ka_seo_title: null,
        ka_meta_description: null,
        ka_h1: null,
        ka_lede: null,
      }, 'admin-id'),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(campaignQuizzesRepo.isAttachableQuestionSet).toHaveBeenCalledWith('ranked-arsenal');
    expect(campaignQuizzesRepo.getQuestionSetHealth).toHaveBeenCalledWith('ranked-arsenal');
    expect(campaignQuizzesRepo.createAdminPage).not.toHaveBeenCalled();
  });

  it('does not expose a manually owned set for reuse by another page', async () => {
    vi.mocked(campaignQuizzesRepo.slugExists).mockResolvedValue(false);
    vi.mocked(campaignQuizzesRepo.isAttachableQuestionSet).mockResolvedValue(false);

    await expect(
      campaignQuizzesService.createAdmin({
        internal_name: 'Arsenal Quiz',
        slug: 'arsenal',
        category: 'team',
        h1: 'Arsenal Quiz',
        lede: 'A complete Arsenal quiz lede.',
        question_source: 'existing',
        question_set_slug: 'manual-liverpool',
        manual_questions: [],
        about_heading: 'About this Arsenal quiz',
        about_blocks: [{ id: 'intro', type: 'paragraph', text: 'About copy.' }],
        score_cta: 'You scored {score}.',
        footer_banner_text: 'Play ranked.',
        footer_button_label: 'Sign up free',
        related_slugs: ['liverpool', 'everton', 'tottenham'],
        hero_image_url: 'campaign-quizzes/arsenal.webp',
        hero_image_alt: 'Arsenal category artwork',
        seo_title: 'Arsenal Quiz | QuizBall',
        meta_description: 'Free Arsenal quiz.',
        og_image_url: null,
        og_image_alt: null,
        breadcrumb_label: 'Arsenal Quiz',
        locale_mode: 'en_only',
        ka_seo_title: null,
        ka_meta_description: null,
        ka_h1: null,
        ka_lede: null,
      }, 'admin-id'),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(campaignQuizzesRepo.isAttachableQuestionSet).toHaveBeenCalledWith('manual-liverpool');
    expect(campaignQuizzesRepo.createAdminPage).not.toHaveBeenCalled();
  });

  it('does not overwrite a self-owned question set while another page consumes it', async () => {
    vi.mocked(campaignQuizzesRepo.getAdminPage).mockResolvedValue({
      ...quizRow,
      question_count: 10,
    });
    vi.mocked(campaignQuizzesRepo.countQuestionSetConsumers).mockResolvedValue(1);

    await expect(
      campaignQuizzesService.updateAdmin('liverpool', {
        internal_name: 'Liverpool Quiz',
        slug: 'liverpool',
        category: 'team',
        h1: 'Liverpool Quiz',
        lede: 'A complete Liverpool quiz lede.',
        question_source: 'manual',
        question_set_slug: 'liverpool',
        manual_questions: [{
          prompt: 'Who managed Liverpool?',
          difficulty: 'easy',
          options: ['Rafael Benítez', 'Jürgen Klopp', 'Brendan Rodgers', 'Steven Gerrard'],
          correct_option: 'b',
          explanation: 'Jürgen Klopp managed Liverpool.',
        }],
        about_heading: 'About this Liverpool quiz',
        about_blocks: [{ id: 'intro', type: 'paragraph', text: 'About copy.' }],
        score_cta: 'You scored {score}.',
        footer_banner_text: 'Play ranked.',
        footer_button_label: 'Sign up free',
        related_slugs: [],
        hero_image_url: 'categories/liverpool-v2.webp',
        hero_image_alt: 'Liverpool category artwork',
        seo_title: 'Liverpool Quiz | QuizBall',
        meta_description: 'Free Liverpool quiz.',
        og_image_url: null,
        og_image_alt: null,
        breadcrumb_label: 'Liverpool Quiz',
        locale_mode: 'en_only',
        ka_seo_title: null,
        ka_meta_description: null,
        ka_h1: null,
        ka_lede: null,
      }, 'admin-id'),
    ).rejects.toMatchObject({ statusCode: 400 });

    expect(campaignQuizzesRepo.updateAdminPage).not.toHaveBeenCalled();
  });

  it('skips a malformed campaign question without failing the whole quiz', async () => {
    vi.mocked(campaignQuizzesRepo.getQuestionSet).mockResolvedValue([
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

  it('serves a balanced ten-question round from the curated fifteen-question pool', async () => {
    const rows = Array.from({ length: 15 }, (_, index) => {
      const difficulty: 'easy' | 'medium' | 'hard' =
        index < 5 ? 'easy' : index < 10 ? 'medium' : 'hard';

      return {
        ...question,
        id: `6c6b8d10-8b8e-4d12-9a10-${String(index + 1).padStart(12, '0')}`,
        display_order: index + 1,
        difficulty,
      };
    });
    vi.mocked(campaignQuizzesRepo.getQuestionSet).mockResolvedValue(rows);

    const quiz = await campaignQuizzesService.getQuiz('liverpool');

    expect(quiz.total_questions).toBe(10);
    expect(quiz.questions).toHaveLength(10);
    expect(quiz.questions.map((item) => item.position)).toEqual([
      1, 2, 3, 4, 6, 7, 8, 11, 12, 13,
    ]);
    expect(quiz.questions.filter((item) => item.difficulty === 'easy')).toHaveLength(4);
    expect(quiz.questions.filter((item) => item.difficulty === 'medium')).toHaveLength(3);
    expect(quiz.questions.filter((item) => item.difficulty === 'hard')).toHaveLength(3);
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

  it('serves Spanish prompts and explanations when requested', async () => {
    const quiz = await campaignQuizzesService.getQuiz('liverpool', undefined, 'es');

    expect(quiz.title).toBe('Quiz del Liverpool');
    expect(quiz.questions[0].prompt).toBe('¿Quién entrenó al Liverpool?');
    expect(quiz.questions[0].options.slice(0, 2)).toEqual([
      { id: 'a', text: 'Rafael Benítez' },
      { id: 'b', text: 'Jürgen Klopp' },
    ]);
    await expect(
      campaignQuizzesService.answer('liverpool', question.id, 'a', undefined, 'es'),
    ).resolves.toMatchObject({
      explanation: 'Jürgen Klopp entrenó al Liverpool.',
    });
  });

  it('lists only campaign pages with publishable Spanish SEO content', async () => {
    vi.mocked(campaignQuizzesRepo.listPublishedPages).mockResolvedValue([
      {
        slug: 'liverpool', page_category: 'team', h1: 'Liverpool Quiz',
        breadcrumb_label: 'Liverpool Quiz', hero_image_url: null,
        hero_image_alt: 'Liverpool artwork', locale_mode: 'en_only',
        updated_at: new Date().toISOString(), hub_order: 1, is_hub_pinned: true,
        es_h1: 'Quiz del Liverpool', es_breadcrumb_label: 'Quiz del Liverpool',
        es_hero_image_alt: 'Ilustración del Liverpool',
        es_seo_title: 'Quiz del Liverpool | QuizBall',
        es_meta_description: 'Quiz del Liverpool gratis.',
      },
      {
        slug: 'untranslated', page_category: 'team', h1: 'English only',
        breadcrumb_label: 'English only', hero_image_url: null,
        hero_image_alt: '', locale_mode: 'en_only',
        updated_at: new Date().toISOString(), hub_order: 2, is_hub_pinned: false,
        es_h1: null, es_breadcrumb_label: null, es_hero_image_alt: null,
        es_seo_title: null, es_meta_description: null,
      },
    ]);

    await expect(campaignQuizzesService.listPublished('es')).resolves.toEqual([
      expect.objectContaining({
        slug: 'liverpool',
        h1: 'Quiz del Liverpool',
        breadcrumb_label: 'Quiz del Liverpool',
        hero_image_alt: 'Ilustración del Liverpool',
      }),
    ]);
  });

  it('returns localized Spanish campaign-page fields', async () => {
    vi.mocked(campaignQuizzesRepo.getVisibleQuiz).mockResolvedValue({
      ...quizRow,
      lede: 'English lede',
      about_heading: 'English heading',
      about_blocks: [{ id: 'intro', type: 'paragraph', text: 'English body' }],
      score_cta: 'You scored {score}.',
      footer_banner_text: 'Play ranked.',
      hero_image_url: 'categories/liverpool-v2.webp',
      hero_image_alt: 'Liverpool artwork',
      meta_description: 'English meta',
      es_lede: 'Introducción en español',
      es_about_heading: 'Sobre este quiz',
      es_about_blocks: [{ id: 'intro', type: 'paragraph', text: 'Contenido en español' }],
      es_score_cta: 'Has acertado {score}.',
      es_footer_banner_text: 'Juega la clasificatoria.',
      es_footer_button_label: 'Jugar ahora',
      es_hero_image_alt: 'Ilustración del Liverpool',
    });

    const quiz = await campaignQuizzesService.getQuiz('liverpool', undefined, 'es');
    expect(quiz.page).toMatchObject({
      h1: 'Quiz del Liverpool',
      lede: 'Introducción en español',
      about_heading: 'Sobre este quiz',
      about_blocks: [{ text: 'Contenido en español' }],
      score_cta: 'Has acertado {score}.',
      footer_button_label: 'Jugar ahora',
      seo_title: 'Quiz del Liverpool | QuizBall',
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
    vi.mocked(campaignQuizzesRepo.getQuestionSet).mockResolvedValue([
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
    vi.mocked(campaignQuizzesRepo.getQuestionSet).mockResolvedValue(clueRows);

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
    vi.mocked(campaignQuizzesRepo.getQuestionSet).mockResolvedValue(careerRows);

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

  it('only allows published pages in the hub merchandising order', async () => {
    vi.mocked(campaignQuizzesRepo.listAdminPages).mockResolvedValue([
      { ...quizRow, question_count: 15, is_hub_pinned: false },
    ]);

    await expect(campaignQuizzesService.updateHubOrder({
      items: [{ slug: 'draft-page', hub_order: 1, is_pinned: true }],
    }, 'admin-id')).rejects.toMatchObject({ statusCode: 400 });

    expect(campaignQuizzesRepo.updateHubOrder).not.toHaveBeenCalled();
  });

  it('returns a private revision timeline without exposing snapshots', async () => {
    vi.mocked(campaignQuizzesRepo.getAdminPage).mockResolvedValue({
      ...quizRow,
      question_count: 15,
      is_hub_pinned: false,
    });
    vi.mocked(campaignQuizzesRepo.listRevisions).mockResolvedValue([{
      id: '7',
      quiz_slug: 'liverpool',
      revision_number: 2,
      action: 'saved',
      snapshot: {
        internal_name: 'Liverpool Quiz',
        h1: 'Liverpool Quiz — Test Your LFC Knowledge',
        status: 'published',
        question_count: 15,
        manual_questions: [{ correct_option: 'b' }],
      },
      created_by: 'admin-id',
      created_at: '2026-08-12T08:00:00.000Z',
      editor_name: 'Admin',
    }]);

    await expect(campaignQuizzesService.listRevisions('liverpool')).resolves.toEqual([{
      id: 7,
      revision_number: 2,
      action: 'saved',
      created_at: '2026-08-12T08:00:00.000Z',
      created_by: 'admin-id',
      editor_name: 'Admin',
      summary: {
        internal_name: 'Liverpool Quiz',
        h1: 'Liverpool Quiz — Test Your LFC Knowledge',
        status: 'published',
        question_count: 15,
      },
    }]);
  });
});
