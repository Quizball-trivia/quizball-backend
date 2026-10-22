import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/modules/campaign-quizzes/campaign-quizzes.repo.js', () => ({
  campaignQuizzesRepo: {
    getVisibleQuiz: vi.fn(),
    getQuestionSet: vi.fn(),
    getRelatedPages: vi.fn(),
    getRating: vi.fn(),
    listPublishedPages: vi.fn(),
    listPublishedPageQuestions: vi.fn(),
  },
}));

import { campaignQuizzesRepo } from '../../src/modules/campaign-quizzes/campaign-quizzes.repo.js';
import type { CampaignQuizRow } from '../../src/modules/campaign-quizzes/campaign-quizzes.repo.js';
import { campaignQuizzesService } from '../../src/modules/campaign-quizzes/campaign-quizzes.service.js';

const question = {
  id: '6c6b8d10-8b8e-4d12-9a10-000000000101',
  display_order: 1,
  difficulty: 'easy' as const,
  prompt: { en: 'Who managed Liverpool?', pt: 'Quem foi técnico do Liverpool?' },
  explanation: { en: 'Jürgen Klopp managed Liverpool.', pt: 'Jürgen Klopp foi técnico do Liverpool.' },
  payload: {
    type: 'mcq_single',
    options: [
      { id: 'a', text: { en: 'Rafael Benítez', pt: 'Rafael Benítez' }, is_correct: false },
      { id: 'b', text: { en: 'Jürgen Klopp', pt: 'Jürgen Klopp' }, is_correct: true },
      { id: 'c', text: { en: 'Brendan Rodgers', pt: 'Brendan Rodgers' }, is_correct: false },
      { id: 'd', text: { en: 'Steven Gerrard', pt: 'Steven Gerrard' }, is_correct: false },
    ],
  },
};

const ptPage = {
  pt_title: 'Quiz do Liverpool',
  pt_h1: 'Quiz do Liverpool: teste seus conhecimentos',
  pt_seo_title: 'Quiz do Liverpool: 10 perguntas | QuizBall',
  pt_meta_description: 'Quiz do Liverpool online e grátis.',
  pt_breadcrumb_label: 'Quiz do Liverpool',
  pt_lede: '{count} perguntas verificadas sobre o Liverpool',
  pt_about_heading: null,
  pt_about_blocks: [{ id: 'intro', type: 'paragraph' as const, text: 'Texto em português: {count}' }],
  pt_hero_image_alt: null,
  pt_og_image_alt: 'Prévia do quiz do Liverpool',
  pt_score_cta: 'Você acertou {score} de {total}.',
  pt_footer_banner_text: null,
  pt_footer_button_label: null,
};

const noRu = Object.fromEntries(
  ['title', 'h1', 'seo_title', 'meta_description', 'breadcrumb_label', 'lede', 'about_heading', 'about_blocks',
    'hero_image_alt', 'og_image_alt', 'score_cta', 'footer_banner_text', 'footer_button_label']
    .flatMap((field) => [[`ru_${field}`, null], [`es_${field}`, null]]),
);

const quizRow = {
  slug: 'liverpool',
  title: 'Liverpool Quiz',
  internal_name: 'Liverpool Quiz',
  page_category: 'team' as const,
  status: 'published' as const,
  question_source: 'existing' as const,
  question_set_slug: 'liverpool',
  h1: 'Liverpool Quiz',
  lede: 'English lede with {count} questions',
  about_heading: 'English heading',
  about_blocks: [{ id: 'intro', type: 'paragraph' as const, text: 'English body' }],
  score_cta: 'You scored {score}.',
  footer_banner_text: 'Play ranked.',
  footer_button_label: 'Play Ranked',
  hero_image_url: 'categories/liverpool-v2.webp',
  hero_image_alt: 'Liverpool artwork',
  seo_title: 'Liverpool Quiz',
  meta_description: 'English meta',
  og_image_url: null,
  og_image_alt: 'Liverpool quiz preview',
  breadcrumb_label: 'Liverpool Quiz',
  locale_mode: 'en_only' as const,
  ka_seo_title: null,
  ka_meta_description: null,
  ka_h1: null,
  ka_lede: null,
  ...noRu,
  ...ptPage,
  scheduled_publish_at: null,
  published_at: new Date().toISOString(),
  unpublished_at: null,
  preview_token: 'de6bd11f-27ee-4721-9586-7f561bfd27e2',
  hub_order: 1,
  is_hub_pinned: false,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
} as unknown as CampaignQuizRow;

const hubRow = (slug: string, pt: Partial<typeof ptPage>) => ({
  slug, page_category: 'team' as const, h1: `${slug} quiz`, breadcrumb_label: `${slug} quiz`,
  hero_image_url: null, hero_image_alt: `${slug} artwork`, locale_mode: 'en_only' as const,
  updated_at: new Date().toISOString(), hub_order: 1, is_hub_pinned: false,
  es_h1: null, es_breadcrumb_label: null, es_hero_image_alt: null, es_seo_title: null, es_meta_description: null,
  ru_h1: null, ru_breadcrumb_label: null, ru_hero_image_alt: null, ru_seo_title: null, ru_meta_description: null,
  pt_h1: pt.pt_h1 ?? null, pt_breadcrumb_label: pt.pt_breadcrumb_label ?? null, pt_hero_image_alt: pt.pt_hero_image_alt ?? null,
  pt_seo_title: pt.pt_seo_title ?? null, pt_meta_description: pt.pt_meta_description ?? null,
});

describe('Brazilian Portuguese campaign quiz edition', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(campaignQuizzesRepo.getVisibleQuiz).mockResolvedValue(quizRow);
    vi.mocked(campaignQuizzesRepo.getQuestionSet).mockResolvedValue([question]);
    vi.mocked(campaignQuizzesRepo.getRelatedPages).mockResolvedValue([]);
    vi.mocked(campaignQuizzesRepo.getRating).mockResolvedValue({ average: null, count: 0 });
  });

  it('serves Portuguese page fields, prompts, options and explanations, falling back to English per field', async () => {
    const quiz = await campaignQuizzesService.getQuiz('liverpool', undefined, 'pt');

    expect(quiz.title).toBe('Quiz do Liverpool');
    expect(quiz.questions[0].prompt).toBe('Quem foi técnico do Liverpool?');
    expect(quiz.page).toMatchObject({
      h1: 'Quiz do Liverpool: teste seus conhecimentos',
      lede: '1 perguntas verificadas sobre o Liverpool',
      about_heading: 'English heading',
      about_blocks: [{ text: 'Texto em português: 1' }],
      score_cta: 'Você acertou {score} de {total}.',
      footer_banner_text: 'Play ranked.',
      seo_title: 'Quiz do Liverpool: 10 perguntas | QuizBall',
      og_image_alt: 'Prévia do quiz do Liverpool',
      breadcrumb_label: 'Quiz do Liverpool',
    });
    await expect(campaignQuizzesService.answer('liverpool', question.id, 'a', undefined, 'pt'))
      .resolves.toMatchObject({ explanation: 'Jürgen Klopp foi técnico do Liverpool.' });
  });

  it('has a pt edition only when the page copy and every question text are in Portuguese', async () => {
    expect((await campaignQuizzesService.getQuiz('liverpool', undefined, 'pt')).editions)
      .toEqual({ ka: false, es: false, ru: false, pt: true });

    // One option without pt would be served in English on the Portuguese page.
    const englishOption = {
      ...question,
      payload: {
        ...question.payload,
        options: question.payload.options.map((option, index) => (index === 3 ? { ...option, text: { en: option.text.en } } : option)),
      },
    };
    vi.mocked(campaignQuizzesRepo.getQuestionSet).mockResolvedValue([englishOption]);
    expect((await campaignQuizzesService.getQuiz('liverpool', undefined, 'pt')).editions.pt).toBe(false);

    // A Spanish-only option has no English either: it would be served in Spanish.
    const spanishOption = {
      ...question,
      payload: {
        ...question.payload,
        options: question.payload.options.map((option, index) => (index === 3 ? { ...option, text: { es: 'Steven Gerrard' } } : option)),
      },
    };
    vi.mocked(campaignQuizzesRepo.getQuestionSet).mockResolvedValue([spanishOption] as never);
    expect((await campaignQuizzesService.getQuiz('liverpool', undefined, 'pt')).editions.pt).toBe(false);

    vi.mocked(campaignQuizzesRepo.getQuestionSet).mockResolvedValue([{ ...question, explanation: { en: 'English only.' } }]);
    expect((await campaignQuizzesService.getQuiz('liverpool', undefined, 'pt')).editions.pt).toBe(false);

    vi.mocked(campaignQuizzesRepo.getQuestionSet).mockResolvedValue([question]);
    vi.mocked(campaignQuizzesRepo.getVisibleQuiz).mockResolvedValue({ ...quizRow, pt_meta_description: null });
    expect((await campaignQuizzesService.getQuiz('liverpool', undefined, 'pt')).editions.pt).toBe(false);
  });

  it('does not count a malformed question the page skips', async () => {
    const malformed = { ...question, id: '6c6b8d10-8b8e-4d12-9a10-000000000102', prompt: { en: 'Broken' }, payload: { type: 'mcq_single' } };
    vi.mocked(campaignQuizzesRepo.getQuestionSet).mockResolvedValue([question, malformed]);
    expect((await campaignQuizzesService.getQuiz('liverpool', undefined, 'pt')).editions.pt).toBe(true);
  });

  it('lists only pages whose pt page copy and questions are complete', async () => {
    vi.mocked(campaignQuizzesRepo.listPublishedPages).mockResolvedValue([
      hubRow('liverpool', ptPage),
      hubRow('arsenal', ptPage),
      hubRow('chelsea', { pt_h1: 'Quiz do Chelsea' }),
    ]);
    vi.mocked(campaignQuizzesRepo.listPublishedPageQuestions).mockResolvedValue([
      { ...question, page_slug: 'liverpool' },
      { ...question, page_slug: 'arsenal' },
      { ...question, id: '6c6b8d10-8b8e-4d12-9a10-000000000103', prompt: { en: 'Who won?' }, page_slug: 'arsenal' },
      { ...question, page_slug: 'chelsea' },
    ]);

    await expect(campaignQuizzesService.listPublished('pt')).resolves.toEqual([
      expect.objectContaining({ slug: 'liverpool', h1: 'Quiz do Liverpool: teste seus conhecimentos', breadcrumb_label: 'Quiz do Liverpool' }),
    ]);
  });

  it('other languages never read the question sets for the hub', async () => {
    vi.mocked(campaignQuizzesRepo.listPublishedPages).mockResolvedValue([hubRow('liverpool', {})]);
    await expect(campaignQuizzesService.listPublished('en')).resolves.toHaveLength(1);
    expect(campaignQuizzesRepo.listPublishedPageQuestions).not.toHaveBeenCalled();
  });

  it('labels a generated Portuguese answer when the question has no explanation', async () => {
    const careerRows = ['Luis Suárez', 'Fernando Torres', 'Mohamed Salah', 'Sadio Mané'].map((answer, index) => ({
      ...question,
      id: `6c6b8d10-8b8e-4d12-9a91-00000000010${index + 1}`,
      display_order: index + 1,
      prompt: { en: 'Name the player', pt: 'Adivinhe o jogador' },
      explanation: null,
      payload: {
        type: 'career_path' as const,
        clubs: [{ en: 'Ajax', pt: 'Ajax' }, { en: 'Liverpool', pt: 'Liverpool' }],
        display_answer: { en: answer, pt: answer },
        accepted_answers: [answer],
      },
    }));
    vi.mocked(campaignQuizzesRepo.getQuestionSet).mockResolvedValue(careerRows);

    const quiz = await campaignQuizzesService.getQuiz('career-path', undefined, 'pt');
    expect(quiz.editions.pt).toBe(true);
    const correct = quiz.questions[0].options.find((option) => option.text === 'Luis Suárez');
    await expect(campaignQuizzesService.answer('career-path', careerRows[0].id, correct?.id ?? '', undefined, 'pt'))
      .resolves.toMatchObject({ correct: true, explanation: 'Resposta correta: Luis Suárez.' });
  });
});
