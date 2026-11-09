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
import { campaignQuizLocaleQuerySchema } from '../../src/modules/campaign-quizzes/campaign-quizzes.schemas.js';
import { existingOptionText, withKeptTranslations } from '../../src/modules/campaign-quizzes/campaign-quizzes.questions.js';

const texts = (en: string) => ({ en, ka: `ka ${en}`, tr: `tr ${en}` });

const question = {
  id: '6c6b8d10-8b8e-4d12-9a10-000000000201',
  display_order: 1,
  difficulty: 'easy' as const,
  prompt: texts('Who manages Northwick Rovers?'),
  explanation: texts('Ada Quill manages Northwick Rovers.'),
  payload: {
    type: 'mcq_single',
    options: [
      { id: 'a', text: texts('Ben Sorrel'), is_correct: false },
      { id: 'b', text: texts('Ada Quill'), is_correct: true },
      { id: 'c', text: texts('Cy Tarn'), is_correct: false },
      { id: 'd', text: texts('Dee Lark'), is_correct: false },
    ],
  },
};

const editionCopy = (locale: 'ka' | 'tr') => ({
  [`${locale}_title`]: `${locale} title`,
  [`${locale}_h1`]: `${locale} h1`,
  [`${locale}_seo_title`]: `${locale} seo`,
  [`${locale}_meta_description`]: `${locale} meta {count}`,
  [`${locale}_breadcrumb_label`]: `${locale} label`,
  [`${locale}_lede`]: `${locale} lede {count}`,
  [`${locale}_about_heading`]: `${locale} about`,
  [`${locale}_about_blocks`]: [{ id: 'intro', type: 'paragraph' as const, text: `${locale} body {count}` }],
  [`${locale}_hero_image_alt`]: `${locale} alt`,
  [`${locale}_og_image_alt`]: `${locale} og`,
  [`${locale}_score_cta`]: `${locale} {score}/{total}`,
  [`${locale}_footer_banner_text`]: `${locale} banner`,
  [`${locale}_footer_button_label`]: `${locale} button`,
});

const quizRow = {
  slug: 'northwick-rovers',
  title: 'Northwick Rovers Quiz',
  internal_name: 'Northwick Rovers Quiz',
  page_category: 'team' as const,
  status: 'published' as const,
  question_source: 'existing' as const,
  question_set_slug: 'northwick-rovers',
  h1: 'Northwick Rovers Quiz',
  lede: 'English lede with {count} questions',
  about_heading: 'English heading',
  about_blocks: [{ id: 'intro', type: 'paragraph' as const, text: 'English body' }],
  score_cta: 'You scored {score}.',
  footer_banner_text: 'Play ranked.',
  footer_button_label: 'Play Ranked',
  hero_image_url: 'categories/northwick.webp',
  hero_image_alt: 'Northwick Rovers artwork',
  seo_title: 'Northwick Rovers Quiz | QuizBall',
  meta_description: 'English meta',
  og_image_url: null,
  og_image_alt: null,
  breadcrumb_label: 'Northwick Rovers Quiz',
  locale_mode: 'en_only' as const,
  updated_at: '2026-11-06T00:00:00.000Z',
} as unknown as CampaignQuizRow;

const row = (overrides: Record<string, unknown> = {}) => ({ ...quizRow, ...overrides }) as CampaignQuizRow;
const hubRow = (overrides: Record<string, unknown> = {}) => row(overrides) as never;
const untranslated = (locale: 'ka' | 'tr') => ({ ...question, payload: { ...question.payload, options: question.payload.options.map((option, index) => (index === 0 ? { ...option, text: { en: option.text.en, [locale === 'ka' ? 'tr' : 'ka']: 'x' } } : option)) } });

describe('Georgian and Turkish campaign quiz editions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(campaignQuizzesRepo.getVisibleQuiz).mockResolvedValue(row());
    vi.mocked(campaignQuizzesRepo.getQuestionSet).mockResolvedValue([question]);
    vi.mocked(campaignQuizzesRepo.getRelatedPages).mockResolvedValue([]);
    vi.mocked(campaignQuizzesRepo.getRating).mockResolvedValue({ average: null, count: 0 });
    vi.mocked(campaignQuizzesRepo.listPublishedPageQuestions).mockResolvedValue([{ ...question, page_slug: 'northwick-rovers' }]);
  });

  it('accepts ka and tr as locales and still refuses an unknown one', () => {
    expect(campaignQuizLocaleQuerySchema.parse({ locale: 'tr' }).locale).toBe('tr');
    expect(campaignQuizLocaleQuerySchema.parse({ locale: 'ka' }).locale).toBe('ka');
    expect(campaignQuizLocaleQuerySchema.safeParse({ locale: 'xx' }).success).toBe(false);
  });

  it('serves the Turkish page copy and questions when the edition is complete', async () => {
    vi.mocked(campaignQuizzesRepo.getVisibleQuiz).mockResolvedValue(row(editionCopy('tr')));
    const quiz = await campaignQuizzesService.getQuiz('northwick-rovers', undefined, 'tr');
    expect(quiz.editions.tr).toBe(true);
    expect(quiz.title).toBe('tr title');
    expect(quiz.page).toMatchObject({ h1: 'tr h1', seo_title: 'tr seo', lede: 'tr lede 1', breadcrumb_label: 'tr label', og_image_alt: 'tr og', footer_button_label: 'tr button' });
    expect(quiz.page?.about_blocks[0].text).toBe('tr body 1');
    expect(quiz.questions[0].prompt).toBe('tr Who manages Northwick Rovers?');
  });

  it('keeps the tr edition off until every question text is in Turkish', async () => {
    vi.mocked(campaignQuizzesRepo.getVisibleQuiz).mockResolvedValue(row(editionCopy('tr')));
    vi.mocked(campaignQuizzesRepo.getQuestionSet).mockResolvedValue([untranslated('tr')]);
    expect((await campaignQuizzesService.getQuiz('northwick-rovers', undefined, 'tr')).editions.tr).toBe(false);
  });

  it('keeps ka and tr off with the SEO fields alone, in the quiz and in the catalog', async () => {
    const seoOnly = (locale: 'ka' | 'tr') => ({ [`${locale}_h1`]: 'h1', [`${locale}_seo_title`]: 'seo', [`${locale}_meta_description`]: 'meta' });
    vi.mocked(campaignQuizzesRepo.getVisibleQuiz).mockResolvedValue(row({ ...seoOnly('ka'), ...seoOnly('tr'), locale_mode: 'en_ka' }));
    expect((await campaignQuizzesService.getQuiz('northwick-rovers', undefined, 'tr')).editions).toMatchObject({ ka: false, tr: false });

    vi.mocked(campaignQuizzesRepo.listPublishedPages).mockResolvedValue([hubRow({ ...seoOnly('ka'), ...seoOnly('tr'), locale_mode: 'en_ka' })]);
    expect(await campaignQuizzesService.listPublished('ka')).toEqual([]);
    expect(await campaignQuizzesService.listPublished('tr')).toEqual([]);

    const { tr_lede: _lede, ...noLede } = editionCopy('tr') as Record<string, unknown>;
    vi.mocked(campaignQuizzesRepo.getVisibleQuiz).mockResolvedValue(row(noLede));
    expect((await campaignQuizzesService.getQuiz('northwick-rovers', undefined, 'tr')).editions.tr).toBe(false);
  });

  it('does not need a field the English page leaves empty', async () => {
    const { tr_og_image_alt: _og, ...copy } = editionCopy('tr') as Record<string, unknown>;
    vi.mocked(campaignQuizzesRepo.getVisibleQuiz).mockResolvedValue(row({ ...copy, og_image_alt: null }));
    expect((await campaignQuizzesService.getQuiz('northwick-rovers', undefined, 'tr')).editions.tr).toBe(true);
  });

  it('keeps an edition off, and the page in English, when about_blocks is not an array', async () => {
    vi.mocked(campaignQuizzesRepo.getVisibleQuiz).mockResolvedValue(row({ ...editionCopy('tr'), tr_about_blocks: JSON.stringify([{ id: 'intro', type: 'paragraph', text: 'x' }]) }));
    const quiz = await campaignQuizzesService.getQuiz('northwick-rovers', undefined, 'tr');
    expect(quiz.editions.tr).toBe(false);
    expect(quiz.page?.about_blocks[0].text).toBe('English body');
  });

  it('keeps the tr edition off without its page copy', async () => {
    expect((await campaignQuizzesService.getQuiz('northwick-rovers', undefined, 'tr')).editions.tr).toBe(false);
  });

  it('needs locale_mode, page copy and every question for the Georgian edition', async () => {
    const copy = editionCopy('ka');
    vi.mocked(campaignQuizzesRepo.getVisibleQuiz).mockResolvedValue(row(copy));
    expect((await campaignQuizzesService.getQuiz('northwick-rovers', undefined, 'ka')).editions.ka).toBe(false);

    vi.mocked(campaignQuizzesRepo.getVisibleQuiz).mockResolvedValue(row({ locale_mode: 'en_ka' }));
    expect((await campaignQuizzesService.getQuiz('northwick-rovers', undefined, 'ka')).editions.ka).toBe(false);

    vi.mocked(campaignQuizzesRepo.getVisibleQuiz).mockResolvedValue(row({ ...copy, locale_mode: 'en_ka' }));
    vi.mocked(campaignQuizzesRepo.getQuestionSet).mockResolvedValue([untranslated('ka')]);
    expect((await campaignQuizzesService.getQuiz('northwick-rovers', undefined, 'ka')).editions.ka).toBe(false);

    vi.mocked(campaignQuizzesRepo.getQuestionSet).mockResolvedValue([question]);
    const quiz = await campaignQuizzesService.getQuiz('northwick-rovers', undefined, 'ka');
    expect(quiz.editions.ka).toBe(true);
    expect(quiz.page).toMatchObject({ h1: 'ka h1', breadcrumb_label: 'ka label', ka_h1: 'ka h1', locale_mode: 'en_ka' });
  });

  it('counts legacy string options and a plain string explanation as English, not as complete', async () => {
    vi.mocked(campaignQuizzesRepo.getVisibleQuiz).mockResolvedValue(row(editionCopy('tr')));
    vi.mocked(campaignQuizzesRepo.getQuestionSet).mockResolvedValue([{ ...question, explanation: 'Ada Quill manages Northwick Rovers.' }]);
    expect((await campaignQuizzesService.getQuiz('northwick-rovers', undefined, 'tr')).editions.tr).toBe(false);

    const legacyOptions = question.payload.options.map((option) => ({ id: option.id, text: option.text.en, is_correct: option.is_correct }));
    vi.mocked(campaignQuizzesRepo.getQuestionSet).mockResolvedValue([{ ...question, payload: { type: 'mcq_single', options: legacyOptions } }]);
    expect((await campaignQuizzesService.getQuiz('northwick-rovers', undefined, 'tr')).editions.tr).toBe(false);
  });

  it('leaves the older pt rule as it was: plain string explanations, legacy options and empty sets stay open', async () => {
    const ptCopy = { pt_h1: 'pt h1', pt_seo_title: 'pt seo', pt_meta_description: 'pt meta' };
    const pt = (node: { en: string }) => ({ ...node, pt: 'pt' });
    const ptQuestion = { ...question, prompt: pt(question.prompt), explanation: pt(question.explanation), payload: { ...question.payload, options: question.payload.options.map((option) => ({ ...option, text: pt(option.text) })) } };
    vi.mocked(campaignQuizzesRepo.getVisibleQuiz).mockResolvedValue(row(ptCopy));
    const edition = async () => (await campaignQuizzesService.getQuiz('northwick-rovers', undefined, 'pt')).editions.pt;

    vi.mocked(campaignQuizzesRepo.getQuestionSet).mockResolvedValue([{ ...ptQuestion, explanation: 'Plain English.' }]);
    expect(await edition()).toBe(true);
    vi.mocked(campaignQuizzesRepo.getQuestionSet).mockResolvedValue([{ ...ptQuestion, payload: { type: 'mcq_single', options: question.payload.options.map((option) => ({ id: option.id, text: option.text.en, is_correct: option.is_correct })) } }]);
    expect(await edition()).toBe(true);
    vi.mocked(campaignQuizzesRepo.getQuestionSet).mockResolvedValue([]);
    expect(await edition()).toBe(true);
  });

  it('keeps the editions off for a set with nothing to play', async () => {
    vi.mocked(campaignQuizzesRepo.getVisibleQuiz).mockResolvedValue(row({ ...editionCopy('ka'), ...editionCopy('tr'), locale_mode: 'en_ka' }));
    vi.mocked(campaignQuizzesRepo.getQuestionSet).mockResolvedValue([]);
    const { editions } = await campaignQuizzesService.getQuiz('northwick-rovers', undefined, 'tr');
    expect(editions).toMatchObject({ ka: false, tr: false });
  });

  it('lists a page in the ka and tr catalogs only when its edition is complete', async () => {
    const complete = { ...editionCopy('ka'), ...editionCopy('tr'), locale_mode: 'en_ka' };
    vi.mocked(campaignQuizzesRepo.listPublishedPages).mockResolvedValue([hubRow(complete)]);
    expect(await campaignQuizzesService.listPublished('tr')).toEqual([expect.objectContaining({ slug: 'northwick-rovers', h1: 'tr h1', breadcrumb_label: 'tr label', hero_image_alt: 'tr alt' })]);
    expect(await campaignQuizzesService.listPublished('ka')).toEqual([expect.objectContaining({ slug: 'northwick-rovers', h1: 'ka h1' })]);

    vi.mocked(campaignQuizzesRepo.listPublishedPageQuestions).mockResolvedValue([{ ...untranslated('tr'), page_slug: 'northwick-rovers' }]);
    expect(await campaignQuizzesService.listPublished('tr')).toEqual([]);

    vi.mocked(campaignQuizzesRepo.listPublishedPageQuestions).mockResolvedValue([{ ...question, page_slug: 'northwick-rovers' }]);
    vi.mocked(campaignQuizzesRepo.listPublishedPages).mockResolvedValue([hubRow({ ...complete, locale_mode: 'en_only' })]);
    expect(await campaignQuizzesService.listPublished('ka')).toEqual([]);
  });
});

describe('a CMS save of a manual question', () => {
  it('keeps the other languages of a text whose English did not change', () => {
    expect(withKeptTranslations({ en: 'Who won?', ka: 'ka', tr: 'tr' }, 'Who won?')).toEqual({ en: 'Who won?', ka: 'ka', tr: 'tr' });
    expect(withKeptTranslations({ en: 'Who won?', tr: 'tr' }, '  Who won? ')).toEqual({ en: '  Who won? ', tr: 'tr' });
  });

  it('drops them when the English changed, so the gated editions close instead of serving a stale translation', () => {
    expect(withKeptTranslations({ en: 'Who won?', ka: 'ka', tr: 'tr' }, 'Who lost?')).toEqual({ en: 'Who lost?' });
    expect(withKeptTranslations(null, 'New question')).toEqual({ en: 'New question' });
    expect(withKeptTranslations(undefined, 'New question')).toEqual({ en: 'New question' });
  });

  it('reads an old JSON-string column too, and ignores anything that is not a text', () => {
    expect(withKeptTranslations(JSON.stringify({ en: 'Who won?', tr: 'tr' }), 'Who won?')).toEqual({ en: 'Who won?', tr: 'tr' });
    expect(withKeptTranslations({ en: 'Who won?', tr: 'tr', extra: 1 }, 'Who won?')).toEqual({ en: 'Who won?', tr: 'tr' });
  });

  it('finds an option by id, whatever its position', () => {
    const payload = { type: 'mcq_single', options: [{ id: 'b', text: { en: 'B', tr: 'b' } }, { id: 'a', text: { en: 'A', tr: 'a' } }] };
    expect(existingOptionText(payload, 'a')).toEqual({ en: 'A', tr: 'a' });
    expect(existingOptionText(payload, 'd')).toBeNull();
    expect(existingOptionText(null, 'a')).toBeNull();
  });
});
