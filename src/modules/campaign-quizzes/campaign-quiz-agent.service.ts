import { createHash } from 'node:crypto';
import { ConflictError, NotFoundError, ValidationError } from '../../core/errors.js';
import type { Json } from '../../db/types.js';
import {
  normalizeCampaignQuizImageReference,
  publicCampaignQuizImageUrl,
} from './campaign-quiz-image-storage.service.js';
import {
  CAMPAIGN_QUIZ_LOCALES,
  EDITION_LOCALES,
  EDITION_TEXT_FIELDS,
  type CampaignLocale,
  type EditionTextField,
} from './campaign-quizzes.editions.js';
import { pageReadiness, type LocaleReadiness, type ReadinessPage } from './campaign-quizzes.readiness.js';
import {
  campaignQuizzesRepo,
  type CampaignQuizEditionColumns,
  type CampaignQuizQuestionRow,
  type CampaignQuizRow,
} from './campaign-quizzes.repo.js';
import type {
  AgentCampaignQuizCandidate,
  AgentCampaignQuizCommitBody,
  AgentCampaignQuizReviewBody,
  CampaignQuizEditionCopy,
} from './campaign-quizzes.schemas.js';

type AgentCopy = AgentCampaignQuizCandidate['copy']['en'];

/** What a write did, kept with the key: unchanged by later edits to the page. */
export interface AgentReceipt {
  idempotency_key: string;
  action: string;
  version: number | null;
  replayed: boolean;
}

/** The receipt always; the page's current state when the page still exists under this slug. */
export type AgentWriteResponse = Partial<AgentPageState> & { slug: string; receipt: AgentReceipt };

async function withReceipt(slug: string, receipt: AgentReceipt): Promise<AgentWriteResponse> {
  try {
    return { ...(await campaignQuizAgentService.state(slug)), receipt };
  } catch (error) {
    if (error instanceof NotFoundError) return { slug, receipt };
    throw error;
  }
}

export interface AgentValidationResult {
  ready: boolean;
  problems: string[];
  locales: LocaleReadiness[];
}

export interface AgentPageState {
  slug: string;
  status: CampaignQuizRow['status'];
  version: number;
  managed_by: CampaignQuizRow['managed_by'];
  agent_locked: boolean;
  internal_name: string;
  category: CampaignQuizRow['page_category'];
  content_modified_at: string;
  last_reviewed_at: string | null;
  next_refresh_at: string | null;
  refreshable: boolean;
  copy: Record<CampaignLocale, CampaignQuizEditionCopy>;
  public_slugs: Partial<Record<CampaignLocale, string>>;
  hero_image_url: string | null;
  og_image_url: string | null;
  related_slugs: string[];
  set_version: number;
  questions: Array<{ id: string; difficulty: 'easy' | 'medium' | 'hard' }>;
  locales: LocaleReadiness[];
}

const englishOf = (copy: AgentCopy) =>
  ({
    ...Object.fromEntries(EDITION_TEXT_FIELDS.map((field) => [field, copy[field] ?? null])),
    about_blocks: copy.about_blocks,
  }) as Record<EditionTextField, string | null> & { about_blocks: AgentCopy['about_blocks'] };

function editionsOf(candidate: AgentCampaignQuizCandidate): CampaignQuizEditionColumns {
  const columns: Record<string, unknown> = {};
  for (const locale of EDITION_LOCALES) {
    const copy = candidate.copy[locale];
    for (const field of EDITION_TEXT_FIELDS) columns[`${locale}_${field}`] = copy[field] ?? null;
    columns[`${locale}_about_blocks`] = copy.about_blocks;
  }
  return columns as CampaignQuizEditionColumns;
}

function readinessPageOf(candidate: AgentCampaignQuizCandidate): ReadinessPage {
  return {
    ...englishOf(candidate.copy.en),
    ...editionsOf(candidate),
    hero_image_url: candidate.hero_image_url,
    locale_mode: 'en_ka',
  } as ReadinessPage;
}

/** The candidate's ten questions as the page would serve them, and what keeps any of them out. */
async function candidateRows(candidate: AgentCampaignQuizCandidate): Promise<{ rows: CampaignQuizQuestionRow[]; problems: string[] }> {
  const found = new Map((await campaignQuizzesRepo.getQuestionsByIds(candidate.questions.map((question) => question.id)))
    .map((row) => [row.id, row]));
  const problems: string[] = [];
  const rows: CampaignQuizQuestionRow[] = [];
  candidate.questions.forEach((question, index) => {
    const row = found.get(question.id);
    if (!row) {
      problems.push(`question ${question.id}: not found, not published or not public`);
      return;
    }
    if (row.set_slug && row.set_slug !== candidate.slug) {
      problems.push(`question ${question.id}: already on page ${row.set_slug}`);
    }
    rows.push({ id: row.id, prompt: row.prompt, explanation: row.explanation, payload: row.payload, difficulty: question.difficulty, display_order: index + 1 });
  });
  return { rows, problems };
}

function copyOf(page: CampaignQuizRow): Record<CampaignLocale, CampaignQuizEditionCopy> {
  const english = {
    ...Object.fromEntries(EDITION_TEXT_FIELDS.map((field) => [field, page[field] ?? null])),
    about_blocks: page.about_blocks,
  } as CampaignQuizEditionCopy;
  return {
    en: english,
    ...Object.fromEntries(EDITION_LOCALES.map((locale) => [locale, {
      ...Object.fromEntries(EDITION_TEXT_FIELDS.map((field) => [field, page[`${locale}_${field}`] ?? null])),
      about_blocks: page[`${locale}_about_blocks`] ?? null,
    }])),
  } as Record<CampaignLocale, CampaignQuizEditionCopy>;
}

/** A revision the CMS can restore exactly: the page body it parses, every language, the URLs and the question set. */
function revisionSnapshot(candidate: AgentCampaignQuizCandidate, heroImage: string, ogImage: string | null, related: string[]): Json {
  const english = candidate.copy.en;
  const georgian = candidate.copy.ka;
  return {
    slug: candidate.slug,
    internal_name: candidate.internal_name,
    category: candidate.category,
    status: 'published',
    question_count: candidate.questions.length,
    title: english.title,
    h1: english.h1,
    lede: english.lede,
    question_source: 'existing',
    question_set_slug: candidate.slug,
    manual_questions: [],
    about_heading: english.about_heading,
    about_blocks: english.about_blocks,
    score_cta: english.score_cta,
    footer_banner_text: english.footer_banner_text,
    footer_button_label: english.footer_button_label,
    related_slugs: related,
    hero_image_url: publicCampaignQuizImageUrl(heroImage),
    hero_image_alt: english.hero_image_alt,
    seo_title: english.seo_title,
    meta_description: english.meta_description,
    og_image_url: publicCampaignQuizImageUrl(ogImage),
    og_image_alt: english.og_image_alt ?? null,
    breadcrumb_label: english.breadcrumb_label,
    locale_mode: 'en_ka',
    ka_seo_title: georgian.seo_title,
    ka_meta_description: georgian.meta_description,
    ka_h1: georgian.h1,
    ka_lede: georgian.lede,
    editions: Object.fromEntries(EDITION_LOCALES.map((locale) => [locale, candidate.copy[locale]])),
    public_slugs: candidate.public_slugs,
    questions: candidate.questions,
    agent: { action: candidate.action },
  } as unknown as Json;
}

const requestHash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function relatedProblems(slugs: string[] | undefined): Promise<string[]> {
  const problems: string[] = [];
  for (const slug of slugs ?? []) {
    if (!(await campaignQuizzesRepo.getPublishedQuiz(slug))) problems.push(`related: ${slug} is not a published page`);
  }
  return problems;
}

export const campaignQuizAgentService = {
  /** The same checks the commit runs, without writing: what would keep this page from going live, per language. */
  async validate(candidate: AgentCampaignQuizCandidate): Promise<AgentValidationResult> {
    const { rows, problems } = await candidateRows(candidate);
    problems.push(...await relatedProblems(candidate.related_slugs));
    for (const [label, value] of [['hero_image_url', candidate.hero_image_url], ['og_image_url', candidate.og_image_url ?? null]] as const) {
      try {
        publicCampaignQuizImageUrl(normalizeCampaignQuizImageReference(value));
      } catch (error) {
        problems.push(`${label}: ${error instanceof Error ? error.message : 'invalid'}`);
      }
    }
    const existing = await campaignQuizzesRepo.getPage(candidate.slug);
    if (candidate.action === 'create') {
      if (existing || await campaignQuizzesRepo.slugExists(candidate.slug)) problems.push(`slug: ${candidate.slug} is already in use`);
      if ((await campaignQuizzesRepo.findPublicSlugConflicts(candidate.slug, Object.fromEntries(CAMPAIGN_QUIZ_LOCALES.map((locale) => [locale, candidate.slug])))).length > 0) {
        problems.push(`slug: ${candidate.slug} is another page's URL`);
      }
      const conflicts = await campaignQuizzesRepo.findPublicSlugConflicts(candidate.slug, candidate.public_slugs);
      problems.push(...conflicts.map((conflict) => `slug: ${conflict} is used by another page`));
    } else {
      if (!existing) problems.push(`page: ${candidate.slug} does not exist`);
      else {
        if (existing.version !== candidate.expected_version) problems.push(`page: changed since read (version ${existing.version})`);
        if (existing.agent_locked) problems.push('page: locked by the owner');
        if (existing.question_source !== 'existing' || existing.question_set_slug !== existing.slug) {
          problems.push('page: does not own its question set');
        }
        const current = await campaignQuizzesRepo.getPageSlugs(candidate.slug);
        for (const locale of CAMPAIGN_QUIZ_LOCALES) {
          if (current[locale] && current[locale] !== candidate.public_slugs[locale]) problems.push(`slug: ${locale} URL cannot change`);
        }
      }
    }
    const locales = pageReadiness(readinessPageOf(candidate), rows, candidate.public_slugs);
    const ready = problems.length === 0 && locales.every((locale) => locale.ready);
    return { ready, problems, locales };
  },

  async commit(body: AgentCampaignQuizCommitBody, userId: string): Promise<AgentWriteResponse> {
    const { candidate } = body;
    const hash = requestHash(candidate);
    const receiptFor = (version: number | null, replayed: boolean) =>
      withReceipt(candidate.slug, { idempotency_key: body.idempotency_key, action: candidate.action, version, replayed });
    const replay = await campaignQuizzesRepo.findAgentCommit(body.idempotency_key);
    if (replay) {
      if (replay.request_hash !== hash) throw new ConflictError('This idempotency key was used for a different request');
      return receiptFor(replay.version, true);
    }
    const validation = await campaignQuizAgentService.validate(candidate);
    if (!validation.ready) {
      // The same request may have just committed in parallel (its page is no longer "new" or its version moved).
      const committed = await campaignQuizzesRepo.findAgentCommit(body.idempotency_key);
      if (committed?.request_hash === hash) return receiptFor(committed.version, true);
      throw new ValidationError('The page is not ready to publish', validation);
    }
    const heroImage = normalizeCampaignQuizImageReference(candidate.hero_image_url)!;
    const ogImage = normalizeCampaignQuizImageReference(candidate.og_image_url ?? null);
    const related = candidate.related_slugs ?? (await campaignQuizzesRepo.listAdminRelatedSlugs(candidate.slug));
    const result = await campaignQuizzesRepo.agentCommit({
      idempotencyKey: body.idempotency_key,
      action: candidate.action,
      slug: candidate.slug,
      expectedVersion: candidate.expected_version,
      internalName: candidate.internal_name,
      category: candidate.category,
      english: englishOf(candidate.copy.en),
      editions: editionsOf(candidate),
      heroImageUrl: heroImage,
      ogImageUrl: ogImage,
      publicSlugs: candidate.public_slugs,
      questions: candidate.questions,
      relatedSlugs: candidate.related_slugs ?? null,
      nextRefreshAt: candidate.next_refresh_at,
      userId,
      revisionSnapshot: () => revisionSnapshot(candidate, heroImage, ogImage, related),
      requestHash: hash,
      claim: candidate.claim ? { backlogId: candidate.claim.backlog_id, leaseToken: candidate.claim.lease_token } : undefined,
      verify: (rows) => {
        const missing = candidate.questions.length - rows.length;
        const locales = pageReadiness(readinessPageOf(candidate), rows, candidate.public_slugs).filter((locale) => !locale.ready);
        return [
          ...(missing > 0 ? [`questions: ${missing} no longer published or public`] : []),
          ...locales.flatMap((locale) => locale.problems.map((problem) => `${locale.locale} ${problem}`)),
        ];
      },
    });
    if (result.kind === 'replayed' && result.slug !== candidate.slug) {
      throw new ConflictError('This idempotency key belongs to another page');
    }
    return receiptFor(result.version, result.kind === 'replayed');
  },

  async review(slug: string, body: AgentCampaignQuizReviewBody): Promise<AgentWriteResponse> {
    const result = await campaignQuizzesRepo.agentReview({
      idempotencyKey: body.idempotency_key,
      requestHash: requestHash({ slug, ...body, idempotency_key: undefined }),
      slug,
      expectedVersion: body.expected_version,
      nextRefreshAt: body.next_refresh_at,
    });
    if (result.kind === 'replayed' && result.slug !== slug) throw new ConflictError('This idempotency key belongs to another page');
    return withReceipt(slug, { idempotency_key: body.idempotency_key, action: 'review', version: result.version, replayed: result.kind === 'replayed' });
  },

  async state(slug: string): Promise<AgentPageState> {
    const page = await campaignQuizzesRepo.getPage(slug);
    if (!page) throw new NotFoundError('Quiz page not found');
    const [publicSlugs, related, latest] = await Promise.all([
      campaignQuizzesRepo.getPageSlugs(slug),
      campaignQuizzesRepo.listAdminRelatedSlugs(slug),
      campaignQuizzesRepo.loadSetVersion(page.question_set_slug),
    ]);
    const rows = latest ? latest.rows : await campaignQuizzesRepo.getQuestionSet(page.question_set_slug);
    return {
      slug: page.slug,
      status: page.status,
      version: page.version,
      managed_by: page.managed_by,
      agent_locked: page.agent_locked,
      internal_name: page.internal_name,
      category: page.page_category,
      content_modified_at: page.content_modified_at ?? page.updated_at,
      last_reviewed_at: page.last_reviewed_at,
      next_refresh_at: page.next_refresh_at,
      refreshable: page.status === 'published' && !page.agent_locked
        && page.question_source === 'existing' && page.question_set_slug === page.slug,
      copy: copyOf(page),
      public_slugs: publicSlugs,
      hero_image_url: publicCampaignQuizImageUrl(page.hero_image_url),
      og_image_url: publicCampaignQuizImageUrl(page.og_image_url),
      related_slugs: related,
      set_version: latest?.version ?? 0,
      questions: rows.map((row) => ({ id: row.id, difficulty: row.difficulty })),
      locales: pageReadiness(page, rows, publicSlugs),
    };
  },

  async due(limit: number): Promise<Array<Pick<AgentPageState, 'slug' | 'version' | 'last_reviewed_at' | 'next_refresh_at'>>> {
    return (await campaignQuizzesRepo.listDueForRefresh(limit)).map((page) => ({
      slug: page.slug,
      version: page.version,
      last_reviewed_at: page.last_reviewed_at,
      next_refresh_at: page.next_refresh_at,
    }));
  },
};
