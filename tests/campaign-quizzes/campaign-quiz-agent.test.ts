import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/modules/campaign-quizzes/campaign-quizzes.repo.js', () => ({
  campaignQuizzesRepo: {
    getVisibleQuiz: vi.fn(),
    getQuestionSet: vi.fn().mockResolvedValue([]),
    loadSetVersion: vi.fn().mockResolvedValue(null),
    getQuestionsByIds: vi.fn().mockResolvedValue([]),
    getPageSlugs: vi.fn().mockResolvedValue({}),
    listPublishedSlugs: vi.fn().mockResolvedValue([]),
    findPublicSlugConflicts: vi.fn().mockResolvedValue([]),
    getPage: vi.fn().mockResolvedValue(null),
    getPublishedQuiz: vi.fn().mockResolvedValue({}),
    slugExists: vi.fn().mockResolvedValue(false),
    listAdminRelatedSlugs: vi.fn().mockResolvedValue([]),
    findAgentCommit: vi.fn().mockResolvedValue(null),
    agentCommit: vi.fn().mockResolvedValue({ kind: 'committed', version: 2 }),
    agentReview: vi.fn().mockResolvedValue({ kind: 'committed', version: 3 }),
    listDueForRefresh: vi.fn().mockResolvedValue([]),
    getRating: vi.fn().mockResolvedValue({ average: null, count: 0 }),
    getRelatedPages: vi.fn().mockResolvedValue([]),
    getAdminPage: vi.fn(),
    isAttachableQuestionSet: vi.fn().mockResolvedValue(true),
    getQuestionSetHealth: vi.fn().mockResolvedValue({ count: 10, public_only_count: 10 }),
    countQuestionSetConsumers: vi.fn().mockResolvedValue(0),
    updateAdminPage: vi.fn().mockResolvedValue(undefined),
    createRevision: vi.fn().mockResolvedValue(undefined),
    listManualQuestions: vi.fn().mockResolvedValue([]),
  },
}));



import { config } from '../../src/core/config.js';
import { campaignAgentAuth } from '../../src/http/middleware/campaign-agent-auth.js';
import { campaignQuizSlugFromPageUrl } from '../../src/modules/campaign-quizzes/campaign-quiz-search-console.service.js';
import { campaignQuizAgentService } from '../../src/modules/campaign-quizzes/campaign-quiz-agent.service.js';
import { CAMPAIGN_QUIZ_LOCALES, EDITION_LOCALES } from '../../src/modules/campaign-quizzes/campaign-quizzes.editions.js';
import { pageReadiness, type ReadinessPage } from '../../src/modules/campaign-quizzes/campaign-quizzes.readiness.js';
import { campaignQuizzesRepo, type CampaignQuizQuestionRow, type CampaignQuizRow } from '../../src/modules/campaign-quizzes/campaign-quizzes.repo.js';
import { agentCampaignQuizCandidateSchema, type AgentCampaignQuizCandidate } from '../../src/modules/campaign-quizzes/campaign-quizzes.schemas.js';
import { campaignQuizzesService } from '../../src/modules/campaign-quizzes/campaign-quizzes.service.js';

const repo = vi.mocked(campaignQuizzesRepo);
const all = (en: string) => Object.fromEntries(CAMPAIGN_QUIZ_LOCALES.map((locale) => [locale, locale === 'en' ? en : `${locale} ${en}`]));
const id = (n: number) => `6c6b8d10-8b8e-4d12-9a10-${String(n).padStart(12, '0')}`;
const DIFFICULTIES = ['easy', 'easy', 'easy', 'easy', 'medium', 'medium', 'medium', 'hard', 'hard', 'hard'] as const;

function questionRow(n: number, texts: (en: string) => Record<string, string> = all): CampaignQuizQuestionRow {
  return {
    id: id(n),
    display_order: n,
    difficulty: DIFFICULTIES[n - 1] ?? 'easy',
    prompt: texts(`Northwick question ${n}?`),
    explanation: texts(`Northwick answer ${n}.`),
    payload: {
      type: 'mcq_single',
      options: ['a', 'b', 'c', 'd'].map((option, index) => ({
        id: option,
        text: texts(`Option ${n}${option}`),
        is_correct: index === 1,
      })),
    },
  };
}

const rows = () => Array.from({ length: 10 }, (_, index) => questionRow(index + 1));

const copy = (locale: string) => ({
  title: `${locale} Northwick quiz`,
  h1: `${locale} Northwick quiz`,
  seo_title: `${locale} Northwick quiz | QuizBall`,
  meta_description: `${locale} ten questions {count}`,
  breadcrumb_label: `${locale} Northwick`,
  lede: `${locale} lede {count}`,
  about_heading: `${locale} about`,
  hero_image_alt: `${locale} artwork`,
  og_image_alt: null,
  score_cta: `${locale} you scored {score}`,
  footer_banner_text: `${locale} banner`,
  footer_button_label: `${locale} play`,
  about_blocks: [{ id: 'intro', type: 'paragraph' as const, text: `${locale} body` }],
});

const slugs = Object.fromEntries(CAMPAIGN_QUIZ_LOCALES.map((locale) => [locale, locale === 'en' ? 'northwick' : `${locale}-northwick`])) as AgentCampaignQuizCandidate['public_slugs'];

function candidate(overrides: Partial<AgentCampaignQuizCandidate> = {}): AgentCampaignQuizCandidate {
  return {
    action: 'create',
    slug: 'northwick',
    expected_version: null,
    internal_name: 'Northwick Rovers',
    category: 'team',
    copy: Object.fromEntries(CAMPAIGN_QUIZ_LOCALES.map((locale) => [locale, copy(locale)])) as AgentCampaignQuizCandidate['copy'],
    public_slugs: slugs,
    hero_image_url: 'campaign-quizzes/northwick.webp',
    og_image_url: null,
    questions: rows().map((row) => ({ id: row.id, difficulty: row.difficulty })),
    next_refresh_at: '2099-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function readinessPage(): ReadinessPage {
  const page: Record<string, unknown> = { ...copy('en'), hero_image_url: 'x.webp', locale_mode: 'en_ka' };
  for (const locale of EDITION_LOCALES) {
    for (const [field, value] of Object.entries(copy(locale))) page[`${locale}_${field}`] = value;
  }
  return page as ReadinessPage;
}

beforeEach(() => {
  vi.clearAllMocks();
  repo.getQuestionsByIds.mockImplementation(async (ids: string[]) =>
    rows().filter((row) => ids.includes(row.id)).map((row) => ({ ...row, set_slug: null })));
});

describe('pageReadiness', () => {
  it('is ready in all eight languages with full copy, slugs and a 4/3/3 round', () => {
    const result = pageReadiness(readinessPage(), rows(), slugs);
    expect(result.map((locale) => [locale.locale, locale.problems])).toEqual(CAMPAIGN_QUIZ_LOCALES.map((locale) => [locale, []]));
  });

  it('names the language whose copy, placeholder or question is missing', () => {
    const page = { ...readinessPage(), fr_lede: null, de_score_cta: 'de you scored', ru_about_blocks: [] } as ReadinessPage;
    const untranslated = rows();
    untranslated[3] = questionRow(4, (en) => Object.fromEntries(Object.entries(all(en)).filter(([locale]) => locale !== 'tr')));
    const byLocale = Object.fromEntries(pageReadiness(page, untranslated, slugs).map((locale) => [locale.locale, locale]));
    expect(byLocale.fr.problems).toContain('copy: lede is not translated');
    expect(byLocale.de.problems).toContain('copy: score_cta lost {score}');
    expect(byLocale.ru.problems).toContain('copy: about_blocks is not translated');
    expect(byLocale.tr.problems).toContain(`question ${id(4)}: 6 text(s) not in tr`);
    expect(byLocale.es.ready).toBe(true);
  });

  it('catches options left null in a language even when other languages are filled (served in English otherwise)', () => {
    const nullOptions = rows();
    nullOptions[0] = questionRow(1, (en) => ({ ...all(en), es: null as unknown as string }));
    const result = Object.fromEntries(pageReadiness(readinessPage(), nullOptions, slugs).map((locale) => [locale.locale, locale]));
    expect(result.es.problems).toContain(`question ${id(1)}: 6 text(s) not in es`);
    expect(result.fr.ready).toBe(true);
    const englishGap = rows();
    englishGap[0] = questionRow(1, (en) => ({ ...all(en), en: '' }));
    expect(pageReadiness(readinessPage(), englishGap, slugs)[0].problems).toContain(`question ${id(1)}: 6 text(s) not in en`);
  });

  it('needs ten questions in the 4/3/3 mix with distinct options, and a valid slug per language', () => {
    const short = rows().slice(0, 9);
    expect(pageReadiness(readinessPage(), short, slugs)[0].problems).toEqual(
      expect.arrayContaining(['round: 9 playable questions, needs 10', 'round: 2 hard, needs 3']),
    );
    const repeated = rows();
    repeated[0] = { ...repeated[0], payload: { type: 'mcq_single', options: ['a', 'b', 'c', 'd'].map((option, index) => ({ id: option, text: all('Same'), is_correct: index === 0 })) } };
    expect(pageReadiness(readinessPage(), repeated, slugs)[0].problems).toContain(`question ${id(1)}: options repeat`);
    expect(pageReadiness(readinessPage(), rows(), { ...slugs, fr: 'Bad Slug' }).find((locale) => locale.locale === 'fr')?.problems)
      .toContain('slug: missing or invalid');
  });
});

describe('agent candidate schema', () => {
  it('accepts a full candidate and refuses a wrong mix, a create with a version, repeats and a past refresh date', () => {
    expect(agentCampaignQuizCandidateSchema.safeParse(candidate()).success).toBe(true);
    const mix = candidate({ questions: candidate().questions.map((question) => ({ ...question, difficulty: 'easy' as const })) });
    expect(agentCampaignQuizCandidateSchema.safeParse(mix).success).toBe(false);
    expect(agentCampaignQuizCandidateSchema.safeParse(candidate({ expected_version: 3 })).success).toBe(false);
    expect(agentCampaignQuizCandidateSchema.safeParse(candidate({ action: 'refresh', expected_version: null })).success).toBe(false);
    const repeated = candidate();
    repeated.questions[1] = { ...repeated.questions[0] };
    expect(agentCampaignQuizCandidateSchema.safeParse(repeated).success).toBe(false);
    expect(agentCampaignQuizCandidateSchema.safeParse(candidate({ next_refresh_at: '2020-01-01T00:00:00.000Z' })).success).toBe(false);
    const missingLanguage = candidate();
    delete (missingLanguage.copy as Partial<AgentCampaignQuizCandidate['copy']>).fr;
    expect(agentCampaignQuizCandidateSchema.safeParse(missingLanguage).success).toBe(false);
  });
});

describe('campaignQuizAgentService', () => {
  it('validates a ready page and reports what keeps one out', async () => {
    expect(await campaignQuizAgentService.validate(candidate())).toMatchObject({ ready: true, problems: [] });

    repo.getQuestionsByIds.mockImplementationOnce(async (ids: string[]) =>
      rows().filter((row) => ids.includes(row.id)).map((row, index) => ({ ...row, set_slug: index === 0 ? 'other-page' : null })));
    repo.findPublicSlugConflicts.mockResolvedValueOnce([]).mockResolvedValueOnce(['fr:fr-northwick']);
    const blocked = await campaignQuizAgentService.validate(candidate());
    expect(blocked.ready).toBe(false);
    expect(blocked.problems).toEqual(expect.arrayContaining([
      `question ${id(1)}: already on page other-page`,
      'slug: fr:fr-northwick is used by another page',
    ]));
  });

  it('refuses a refresh of a page that changed, is locked, or would change its URLs', async () => {
    repo.getPage.mockResolvedValue({ slug: 'northwick', version: 7, agent_locked: true, question_source: 'existing', question_set_slug: 'northwick' } as CampaignQuizRow);
    repo.getPageSlugs.mockResolvedValueOnce({ ...slugs, fr: 'quiz-northwick' });
    const result = await campaignQuizAgentService.validate(candidate({ action: 'refresh', expected_version: 6 }));
    expect(result.problems).toEqual(expect.arrayContaining([
      'page: changed since read (version 7)',
      'page: locked by the owner',
      'slug: fr URL cannot change',
    ]));
    repo.getPage.mockResolvedValue(null);
  });

  it('commits only a ready page, with a restorable snapshot, and replays a known key without writing', async () => {
    repo.getPage.mockResolvedValueOnce(null).mockResolvedValue({ slug: 'northwick', version: 2, status: 'published', question_source: 'existing', question_set_slug: 'northwick', about_blocks: [], updated_at: 'x' } as unknown as CampaignQuizRow);
    await campaignQuizAgentService.commit({ idempotency_key: 'agent:0123456789abcdef', candidate: candidate() }, 'agent-user');
    const input = repo.agentCommit.mock.calls[0][0];
    expect(input).toMatchObject({ action: 'create', slug: 'northwick', heroImageUrl: 'campaign-quizzes/northwick.webp', userId: 'agent-user' });
    expect(input.editions).toMatchObject({ fr_lede: 'fr lede {count}', ka_h1: 'ka Northwick quiz' });
    const snapshot = input.revisionSnapshot(null) as Record<string, unknown>;
    expect(snapshot).toMatchObject({ question_source: 'existing', question_set_slug: 'northwick', public_slugs: slugs });
    expect((snapshot.questions as unknown[]).length).toBe(10);

    repo.agentCommit.mockClear();
    const hash = createHash('sha256').update(JSON.stringify(candidate())).digest('hex');
    repo.findAgentCommit.mockResolvedValueOnce({ slug: 'northwick', action: 'create', request_hash: hash });
    await campaignQuizAgentService.commit({ idempotency_key: 'agent:0123456789abcdef', candidate: candidate() }, 'agent-user');
    expect(repo.agentCommit).not.toHaveBeenCalled();

    repo.findAgentCommit.mockResolvedValueOnce({ slug: 'northwick', action: 'create', request_hash: 'f'.repeat(64) });
    await expect(campaignQuizAgentService.commit({ idempotency_key: 'agent:0123456789abcdef', candidate: candidate() }, 'agent-user'))
      .rejects.toMatchObject({ statusCode: 409 });

    repo.getQuestionsByIds.mockResolvedValueOnce([]);
    await expect(campaignQuizAgentService.commit({ idempotency_key: 'agent:fedcba9876543210', candidate: candidate() }, 'agent-user'))
      .rejects.toMatchObject({ statusCode: 422 });
    expect(repo.agentCommit).not.toHaveBeenCalled();
    repo.getPage.mockResolvedValue(null);
  });
});

describe('rounds pinned to a set version', () => {
  const page = { slug: 'northwick', question_set_slug: 'northwick' } as CampaignQuizRow;

  it('serves the newest set version and answers against the version the round started on', async () => {
    repo.getVisibleQuiz.mockResolvedValue({ ...page, about_blocks: [], locale_mode: 'en_only', updated_at: 'x' } as unknown as CampaignQuizRow);
    repo.loadSetVersion.mockResolvedValueOnce({ version: 4, superseded_at: null, rows: rows() });
    expect((await campaignQuizzesService.getQuiz('northwick')).set_version).toBe(4);

    repo.loadSetVersion.mockResolvedValueOnce({ version: 3, superseded_at: new Date().toISOString(), rows: rows() });
    const answer = await campaignQuizzesService.answer('northwick', id(2), 'b', undefined, 'en', 3);
    expect(answer.correct).toBe(true);
    expect(repo.loadSetVersion).toHaveBeenLastCalledWith('northwick', 3);
  });

  it('refuses a version replaced more than a day ago and a version the set never had', async () => {
    repo.getVisibleQuiz.mockResolvedValue({ ...page } as CampaignQuizRow);
    repo.loadSetVersion.mockResolvedValueOnce({ version: 1, superseded_at: '2026-01-01T00:00:00.000Z', rows: rows() });
    await expect(campaignQuizzesService.answer('northwick', id(2), 'b', undefined, 'en', 1)).rejects.toMatchObject({ statusCode: 404 });
    repo.loadSetVersion.mockResolvedValueOnce(null);
    await expect(campaignQuizzesService.answer('northwick', id(2), 'b', undefined, 'en', 99)).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('CMS saves of agent pages', () => {
  const agentPage = () => ({
    ...readinessPage(),
    slug: 'northwick', internal_name: 'Northwick Rovers', page_category: 'team', status: 'published', managed_by: 'agent',
    version: 5, last_reviewed_at: '2026-11-10T00:00:00.000Z', question_source: 'existing', question_set_slug: 'northwick',
    title: 'en Northwick quiz', og_image_url: null, question_count: 10, updated_at: 'x', content_modified_at: 'x',
    hero_image_url: 'campaign-quizzes/northwick.webp',
  }) as unknown as Awaited<ReturnType<typeof campaignQuizzesRepo.getAdminPage>>;
  const form = (overrides: Record<string, unknown> = {}) => ({
    ...copy('en'), internal_name: 'Northwick Rovers', slug: 'northwick', category: 'team' as const, question_source: 'existing' as const,
    question_set_slug: 'northwick', manual_questions: [], related_slugs: [], hero_image_url: 'campaign-quizzes/northwick.webp',
    og_image_url: null, locale_mode: 'en_ka' as const, ka_h1: 'ka Northwick quiz', ka_lede: 'ka lede {count}',
    ka_seo_title: 'ka Northwick quiz | QuizBall', ka_meta_description: 'ka ten questions {count}', ...overrides,
  }) as Parameters<typeof campaignQuizzesService.updateAdmin>[1];

  beforeEach(() => {
    repo.getAdminPage.mockResolvedValue(agentPage());
    repo.loadSetVersion.mockResolvedValue({ version: 2, superseded_at: null, rows: rows() });
    repo.getPageSlugs.mockResolvedValue(slugs);
  });

  it('refuses a save that does not say which version it edits (an old CMS form)', async () => {
    await expect(campaignQuizzesService.updateAdmin('northwick', form(), 'owner')).rejects.toMatchObject({ statusCode: 409 });
    expect(repo.updateAdminPage).not.toHaveBeenCalled();
  });

  it('refuses a save that would leave a language incomplete and passes a complete one through with its version', async () => {
    const french = { ...copy('fr'), lede: '' };
    await expect(campaignQuizzesService.updateAdmin('northwick', form({ expected_version: 5, editions: { fr: french } }), 'owner'))
      .rejects.toMatchObject({ statusCode: 422 });
    expect(repo.updateAdminPage).not.toHaveBeenCalled();
    await campaignQuizzesService.updateAdmin('northwick', form({ expected_version: 5, editions: { fr: copy('fr') } }), 'owner');
    expect(repo.updateAdminPage.mock.calls[0][3]).toMatchObject({ expectedVersion: 5 });
  });
});

describe('campaignAgentAuth', () => {
  const run = (authorization?: string) => {
    const next = vi.fn();
    campaignAgentAuth({ headers: { authorization } } as never, {} as never, next);
    return next.mock.calls[0][0];
  };

  it('is off without configuration and accepts only the token whose hash is configured', () => {
    (config as Record<string, unknown>).CAMPAIGN_AGENT_TOKEN_SHA256 = undefined;
    expect(run('Bearer anything')).toMatchObject({ statusCode: 404 });
    (config as Record<string, unknown>).CAMPAIGN_AGENT_TOKEN_SHA256 = createHash('sha256').update('agent-secret').digest('hex');
    (config as Record<string, unknown>).CAMPAIGN_AGENT_USER_ID = '6c6b8d10-8b8e-4d12-9a10-000000000999';
    expect(run('Bearer agent-secret')).toBeUndefined();
    expect(run('Bearer wrong')).toMatchObject({ statusCode: 401 });
    expect(run(undefined)).toMatchObject({ statusCode: 401 });
  });
});

describe('Search Console page mapping', () => {
  it('maps every language folder through the slug registry, French and Turkish included', () => {
    const registry = new Map([['fr:quiz-northwick', 'northwick'], ['tr:northwick-testi', 'northwick'], ['es:quiz-northwick', 'northwick']]);
    expect(campaignQuizSlugFromPageUrl('https://quizball.io/fr/quiz-foot/quiz-northwick', 'https://quizball.io', registry)).toBe('northwick');
    expect(campaignQuizSlugFromPageUrl('https://quizball.io/tr/futbol-bilgi-yarismasi/northwick-testi', 'https://quizball.io', registry)).toBe('northwick');
    expect(campaignQuizSlugFromPageUrl('https://quizball.io/es/quiz-de-futbol/quiz-northwick', 'https://quizball.io', registry)).toBe('northwick');
    expect(campaignQuizSlugFromPageUrl('https://quizball.io/fr/football-quiz/quiz-northwick', 'https://quizball.io', registry)).not.toBe('northwick');
  });
});
