import { createHash } from 'node:crypto';
import { config } from '../../core/config.js';
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import { questionPayloadSchema } from '../questions/questions.schemas.js';
import type { Json } from '../../db/types.js';
import { campaignQuizGooglebotService } from './campaign-quiz-googlebot.service.js';
import {
  campaignQuizImageStorageService,
  normalizeCampaignQuizImageReference,
  publicCampaignQuizImageUrl,
} from './campaign-quiz-image-storage.service.js';
import { campaignQuizSearchConsoleService } from './campaign-quiz-search-console.service.js';
import {
  campaignQuizzesRepo,
  type AdminCampaignQuizListRow,
  type CampaignQuizQuestionRow,
  type CampaignQuizRelatedRow,
  type CampaignQuizRow,
} from './campaign-quizzes.repo.js';
import type {
  AdminCampaignQuizImageBody,
  AdminCampaignQuizGooglebotResponse,
  AdminCampaignQuizHubOrderBody,
  AdminCampaignQuizListItemResponse,
  AdminCampaignQuizListQuery,
  AdminCampaignQuizManualQuestion,
  AdminCampaignQuizPageBody,
  AdminCampaignQuizPageResponse,
  AdminCampaignQuizPublishBody,
  AdminCampaignQuizQuestionSetResponse,
  AdminCampaignQuizRevisionResponse,
  AdminCampaignQuizRetireBody,
  CampaignQuizAnswerResponse,
  CampaignQuizHubPageResponse,
  CampaignQuizPageContentResponse,
  CampaignQuizQuestionResponse,
  CampaignQuizRatingResponse,
  CampaignQuizResponse,
  CampaignQuizRouteResponse,
} from './campaign-quizzes.schemas.js';
import { adminCampaignQuizPageBodySchema } from './campaign-quizzes.schemas.js';

function localizedText(value: unknown, locale = 'en'): string | null {
  if (typeof value === 'string') {
    try {
      return localizedText(JSON.parse(value), locale);
    } catch {
      return value.trim() || null;
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const field = value as Record<string, unknown>;
  const preferred = field[locale];
  if (typeof preferred === 'string' && preferred.trim()) return preferred.trim();
  const english = field.en;
  if (typeof english === 'string' && english.trim()) return english.trim();
  const fallback = Object.values(field).find(
    (entry): entry is string => typeof entry === 'string' && entry.trim().length > 0,
  );
  return fallback?.trim() ?? null;
}

type ParsedQuestionPayload = ReturnType<typeof questionPayloadSchema.parse>;
type CampaignPayload = Extract<
  ParsedQuestionPayload,
  { type: 'mcq_single' | 'true_false' | 'clue_chain' | 'career_path' }
>;

function parseCampaignQuestion(row: CampaignQuizQuestionRow): CampaignPayload {
  const parsed = questionPayloadSchema.safeParse(row.payload);
  if (!parsed.success) throw new BadRequestError('Campaign quiz question payload is invalid');
  const payload = parsed.data;
  if (
    payload.type !== 'mcq_single'
    && payload.type !== 'true_false'
    && payload.type !== 'clue_chain'
    && payload.type !== 'career_path'
  ) {
    throw new BadRequestError('Campaign quiz question type is not supported');
  }
  return payload as CampaignPayload;
}

function stableHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function guestRatingKey(slug: string, clientIp: string): string {
  return stableHash(`campaign-rating:${config.SUPABASE_JWT_SECRET}:${slug}:${clientIp}`);
}

function generatedAnswer(payload: CampaignPayload): string | null {
  if (payload.type !== 'clue_chain' && payload.type !== 'career_path') return null;
  return localizedText(payload.display_answer);
}

function generatedOptions(row: CampaignQuizQuestionRow, rows: CampaignQuizQuestionRow[]) {
  const payload = parseCampaignQuestion(row);
  const correctAnswer = generatedAnswer(payload);
  if (!correctAnswer) throw new BadRequestError('Campaign quiz question has no display answer');

  const distractors = rows
    .filter((candidate) => candidate.id !== row.id)
    .map((candidate) => {
      try {
        return generatedAnswer(parseCampaignQuestion(candidate));
      } catch (error) {
        if (error instanceof BadRequestError) return null;
        throw error;
      }
    })
    .filter((answer): answer is string => Boolean(answer && answer !== correctAnswer))
    .filter((answer, index, answers) => answers.indexOf(answer) === index)
    .sort((left, right) =>
      stableHash(`${row.id}:distractor:${left}`)
        .localeCompare(stableHash(`${row.id}:distractor:${right}`)),
    )
    .slice(0, 3);

  if (distractors.length < 3) {
    throw new BadRequestError('Campaign quiz question needs three answer distractors');
  }

  return [correctAnswer, ...distractors]
    .sort((left, right) =>
      stableHash(`${row.id}:option:${left}`)
        .localeCompare(stableHash(`${row.id}:option:${right}`)),
    )
    .map((text, index) => ({
      id: String.fromCharCode(97 + index),
      text,
      isCorrect: text === correctAnswer,
    }));
}

function toPublicQuestion(
  row: CampaignQuizQuestionRow,
  rows: CampaignQuizQuestionRow[],
): CampaignQuizQuestionResponse {
  const payload = parseCampaignQuestion(row);
  const prompt = localizedText(row.prompt);
  if (!prompt) throw new BadRequestError('Campaign quiz question has no English prompt');

  if (payload.type === 'mcq_single' || payload.type === 'true_false') {
    return {
      id: row.id,
      position: row.display_order,
      difficulty: row.difficulty,
      type: payload.type,
      prompt,
      details: [],
      image_url: payload.type === 'mcq_single' ? payload.image?.url ?? null : null,
      options: payload.options.map((option) => ({
        id: option.id,
        text: localizedText(option.text) ?? '',
      })),
    };
  }

  const options = generatedOptions(row, rows);
  return {
    id: row.id,
    position: row.display_order,
    difficulty: row.difficulty,
    type: payload.type,
    prompt,
    details:
      payload.type === 'clue_chain'
        ? payload.clues
            .map((clue) => localizedText(clue.content))
            .filter((clue): clue is string => Boolean(clue))
            .filter((clue) => clue !== prompt)
        : payload.clubs
            .map((club) => localizedText(club))
            .filter((club): club is string => Boolean(club)),
    image_url: null,
    options: options.map((option) => ({ id: option.id, text: option.text })),
  };
}

function normalizeRating(
  rating: Awaited<ReturnType<typeof campaignQuizzesRepo.getRating>>,
): CampaignQuizRatingResponse {
  const average = rating.average === null ? null : Number(rating.average);
  return {
    average: average !== null && Number.isFinite(average) ? average : null,
    count: Number(rating.count) || 0,
  };
}

function interpolateCount(value: string | null, count: number): string {
  return (value ?? '').replaceAll('{count}', String(count));
}

function hasManagedContent(quiz: CampaignQuizRow): boolean {
  return Boolean(
    quiz.lede
    && quiz.about_heading
    && quiz.about_blocks.length > 0
    && quiz.score_cta
    && quiz.footer_banner_text
    && quiz.footer_button_label
    && quiz.hero_image_url
    && quiz.hero_image_alt
    && quiz.seo_title
    && quiz.meta_description
    && quiz.breadcrumb_label,
  );
}

function toPageContent(
  quiz: CampaignQuizRow,
  related: CampaignQuizRelatedRow[],
  count: number,
): CampaignQuizPageContentResponse | null {
  if (!hasManagedContent(quiz)) return null;
  return {
    category: quiz.page_category,
    h1: quiz.h1,
    lede: interpolateCount(quiz.lede, count),
    about_heading: quiz.about_heading ?? '',
    about_blocks: quiz.about_blocks.map((block) => ({
      ...block,
      text: interpolateCount(block.text, count),
    })),
    score_cta: interpolateCount(quiz.score_cta, count),
    footer_banner_text: quiz.footer_banner_text ?? '',
    footer_button_label: quiz.footer_button_label,
    hero_image_url: publicCampaignQuizImageUrl(quiz.hero_image_url),
    hero_image_alt: quiz.hero_image_alt ?? '',
    seo_title: quiz.seo_title,
    meta_description: interpolateCount(quiz.meta_description, count),
    og_image_url: publicCampaignQuizImageUrl(quiz.og_image_url),
    og_image_alt: quiz.og_image_alt,
    breadcrumb_label: quiz.breadcrumb_label,
    locale_mode: quiz.locale_mode,
    ka_seo_title: quiz.ka_seo_title,
    ka_meta_description: quiz.ka_meta_description
      ? interpolateCount(quiz.ka_meta_description, count)
      : null,
    ka_h1: quiz.ka_h1,
    ka_lede: quiz.ka_lede ? interpolateCount(quiz.ka_lede, count) : null,
    related_pages: related.map((page) => ({
      slug: page.slug,
      breadcrumb_label: page.breadcrumb_label,
      hero_image_url: publicCampaignQuizImageUrl(page.hero_image_url),
      hero_image_alt: page.hero_image_alt ?? '',
    })),
    updated_at: quiz.updated_at,
  };
}

function wordCount(value: string | null): number {
  return (value ?? '').trim().split(/\s+/).filter(Boolean).length;
}

function toAdminManualQuestion(
  row: Awaited<ReturnType<typeof campaignQuizzesRepo.listManualQuestions>>[number],
): AdminCampaignQuizManualQuestion {
  const parsed = questionPayloadSchema.safeParse(row.payload);
  const prompt = localizedText(row.prompt);
  if (!parsed.success || parsed.data.type !== 'mcq_single' || !prompt) {
    throw new BadRequestError('A manually managed campaign question is invalid');
  }

  const options = parsed.data.options.map((option) => localizedText(option.text) ?? '');
  const correct = parsed.data.options.find((option) => option.is_correct)?.id;
  if (options.length !== 4 || !correct || !['a', 'b', 'c', 'd'].includes(correct)) {
    throw new BadRequestError('A manually managed campaign question has invalid answers');
  }

  return {
    id: row.id,
    prompt,
    difficulty: row.difficulty,
    options: options as [string, string, string, string],
    correct_option: correct as 'a' | 'b' | 'c' | 'd',
    explanation: localizedText(row.explanation),
  };
}

function uniqueRelated(input: AdminCampaignQuizPageBody): string[] {
  const related = [...new Set(input.related_slugs)];
  if (related.includes(input.slug)) {
    throw new BadRequestError('A quiz cannot be related to itself');
  }
  return related;
}

function normalizeAdminInput(input: AdminCampaignQuizPageBody): AdminCampaignQuizPageBody {
  return {
    ...input,
    hero_image_url: normalizeCampaignQuizImageReference(input.hero_image_url),
    og_image_url: normalizeCampaignQuizImageReference(input.og_image_url),
    question_source: input.question_source ?? 'existing',
    manual_questions: input.manual_questions ?? [],
    related_slugs: uniqueRelated(input),
  };
}

function revisionInput(snapshot: unknown, currentSlug: string): AdminCampaignQuizPageBody {
  const parsed = adminCampaignQuizPageBodySchema.safeParse(snapshot);
  if (!parsed.success) throw new BadRequestError('This revision can no longer be restored');
  const input = parsed.data;
  return {
    ...input,
    slug: currentSlug,
    question_set_slug: input.question_source === 'manual' ? currentSlug : input.question_set_slug,
    // A question removed after this snapshot may no longer exist. Recreating
    // the restored manual set without historic IDs keeps rollback deterministic.
    manual_questions: input.manual_questions.map(({ id: _id, ...question }) => question),
    related_slugs: input.related_slugs.filter((slug) => slug !== currentSlug),
  };
}

async function recordRevision(
  slug: string,
  action: Parameters<typeof campaignQuizzesRepo.createRevision>[1],
  userId: string,
): Promise<void> {
  const page = await campaignQuizzesRepo.getAdminPage(slug);
  if (!page) return;
  const snapshot = await toAdminPage(page);
  await campaignQuizzesRepo.createRevision(
    slug,
    action,
    snapshot as unknown as Json,
    userId,
  );
}

async function validateAttachedContent(
  input: AdminCampaignQuizPageBody,
  relatedSlugs: string[],
): Promise<void> {
  if (input.question_source === 'existing') {
    if (!(await campaignQuizzesRepo.isAttachableQuestionSet(input.question_set_slug))) {
      throw new BadRequestError('Choose a reusable public-only campaign question set');
    }
    const health = await campaignQuizzesRepo.getQuestionSetHealth(input.question_set_slug);
    if (health.count === 0) throw new BadRequestError('Choose an existing campaign question set');
    if (health.public_only_count !== health.count) {
      throw new BadRequestError('Only public-only question sets excluded from ranked play can be attached');
    }
  }

  const relatedPages = await Promise.all(
    relatedSlugs.map((slug) => campaignQuizzesRepo.getPublishedQuiz(slug)),
  );
  if (relatedPages.some((page) => page === null)) {
    throw new BadRequestError('Related quizzes must be published pages');
  }
}

async function adminWarnings(
  page: AdminCampaignQuizListRow,
  relatedSlugs: string[],
): Promise<string[]> {
  const health = await campaignQuizzesRepo.getQuestionSetHealth(page.question_set_slug);
  const warnings: string[] = [];
  if (page.seo_title.length > 60) warnings.push(`Title tag is ${page.seo_title.length} characters; recommended maximum is 60.`);
  const renderedMetaDescription = interpolateCount(page.meta_description, health.count);
  if (renderedMetaDescription.length > 155) warnings.push(`Meta description is ${renderedMetaDescription.length} characters after inserting the question count; recommended maximum is 155.`);
  const ledeWords = wordCount(page.lede);
  if (ledeWords < 40 || ledeWords > 60) warnings.push(`Lede is ${ledeWords} words; recommended range is 40–60.`);
  if (relatedSlugs.length < 3) warnings.push('Choose at least three related quizzes before publishing.');
  if (health.count < 10) warnings.push(`Question set has ${health.count} questions; publishing requires at least 10.`);
  if (health.public_only_count !== health.count) warnings.push('Question set contains ranked-eligible or non-public questions.');
  if (page.locale_mode === 'en_ka' && (!page.ka_h1 || !page.ka_lede || !page.ka_seo_title || !page.ka_meta_description)) {
    warnings.push('Georgian is enabled but one or more Georgian SEO fields are empty.');
  }
  return warnings;
}

function publicationBlockers(
  page: AdminCampaignQuizListRow,
  health: Awaited<ReturnType<typeof campaignQuizzesRepo.getQuestionSetHealth>>,
): string[] {
  const blockers: string[] = [];
  if (!page.internal_name.trim()) blockers.push('Internal name is required.');
  if (!page.h1.trim()) blockers.push('H1 is required.');
  if (!page.lede?.trim()) blockers.push('Lede is required.');
  if (!page.about_heading?.trim() || page.about_blocks.length === 0) blockers.push('About section heading and content are required.');
  if (!page.score_cta?.includes('{score}')) blockers.push('Score-screen CTA must include {score}.');
  if (!page.footer_banner_text?.trim() || !page.footer_button_label.trim()) blockers.push('Footer banner text and button label are required.');
  if (!page.hero_image_url || !page.hero_image_alt?.trim()) blockers.push('Hero artwork and alt text are required.');
  if (!page.seo_title.trim() || !page.meta_description?.trim() || !page.breadcrumb_label.trim()) blockers.push('SEO title, meta description, and breadcrumb label are required.');
  if (page.og_image_url && !page.og_image_alt?.trim()) blockers.push('OG image alt text is required when an OG override is uploaded.');
  if (health.count < 10) blockers.push('Question set must contain at least 10 questions.');
  if (health.public_only_count !== health.count) blockers.push('Question set must contain public-only questions excluded from ranked play.');
  if (page.locale_mode === 'en_ka' && (!page.ka_h1 || !page.ka_lede || !page.ka_seo_title || !page.ka_meta_description)) {
    blockers.push('All Georgian fields are required when the Georgian variant is enabled.');
  }
  return blockers;
}

async function publishBlockers(page: AdminCampaignQuizListRow): Promise<string[]> {
  const health = await campaignQuizzesRepo.getQuestionSetHealth(page.question_set_slug);
  return publicationBlockers(page, health);
}

async function toAdminPage(page: AdminCampaignQuizListRow): Promise<AdminCampaignQuizPageResponse> {
  const [relatedSlugs, manualQuestionRows] = await Promise.all([
    campaignQuizzesRepo.listAdminRelatedSlugs(page.slug),
    page.question_source === 'manual'
      ? campaignQuizzesRepo.listManualQuestions(page.slug)
      : Promise.resolve([]),
  ]);
  return {
    slug: page.slug,
    internal_name: page.internal_name,
    category: page.page_category,
    status: page.status,
    question_count: page.question_count,
    hero_image_url: publicCampaignQuizImageUrl(page.hero_image_url),
    locale_mode: page.locale_mode,
    scheduled_publish_at: page.scheduled_publish_at,
    published_at: page.published_at,
    updated_at: page.updated_at,
    hub_order: page.hub_order,
    is_hub_pinned: page.is_hub_pinned,
    h1: page.h1,
    lede: page.lede ?? '',
    question_source: page.question_source,
    question_set_slug: page.question_set_slug,
    manual_questions: manualQuestionRows.map(toAdminManualQuestion),
    about_heading: page.about_heading ?? '',
    about_blocks: page.about_blocks,
    score_cta: page.score_cta ?? '',
    footer_banner_text: page.footer_banner_text ?? '',
    footer_button_label: page.footer_button_label,
    related_slugs: relatedSlugs,
    hero_image_alt: page.hero_image_alt ?? '',
    seo_title: page.seo_title,
    meta_description: page.meta_description ?? '',
    og_image_url: publicCampaignQuizImageUrl(page.og_image_url),
    og_image_alt: page.og_image_alt,
    breadcrumb_label: page.breadcrumb_label,
    ka_seo_title: page.ka_seo_title,
    ka_meta_description: page.ka_meta_description,
    ka_h1: page.ka_h1,
    ka_lede: page.ka_lede,
    preview_token: page.preview_token,
    preview_url: `${config.CAMPAIGN_QUIZ_PREVIEW_BASE_URL.replace(/\/+$/, '')}/en/football-quiz/${page.slug}?preview=${page.preview_token}`,
    warnings: await adminWarnings(page, relatedSlugs),
  };
}

export const campaignQuizzesService = {
  async listPublished(locale: 'en' | 'ka'): Promise<CampaignQuizHubPageResponse[]> {
    const pages = await campaignQuizzesRepo.listPublishedPages();
    return pages
      .filter((page) => locale === 'en' || page.locale_mode === 'en_ka')
      .map((page) => ({
        slug: page.slug,
        category: page.page_category,
        h1: page.h1,
        breadcrumb_label: page.breadcrumb_label,
        hero_image_url: publicCampaignQuizImageUrl(page.hero_image_url),
        hero_image_alt: page.hero_image_alt ?? '',
        locale_mode: page.locale_mode,
        updated_at: page.updated_at,
      }));
  },

  async resolveRoute(slug: string): Promise<CampaignQuizRouteResponse> {
    if (await campaignQuizzesRepo.getPublishedQuiz(slug)) {
      return { kind: 'page', slug, target_slug: null };
    }
    const route = await campaignQuizzesRepo.resolveRoute(slug);
    if (!route) return { kind: 'missing', slug, target_slug: null };
    return {
      kind: route.status_code === 301 ? 'redirect' : 'gone',
      slug,
      target_slug: route.target_slug,
    };
  },

  async getQuiz(slug: string, previewToken?: string): Promise<CampaignQuizResponse> {
    const quiz = await campaignQuizzesRepo.getVisibleQuiz(slug, previewToken);
    if (!quiz) throw new NotFoundError('Campaign quiz not found');

    const [rows, rating, related] = await Promise.all([
      campaignQuizzesRepo.getQuestionSet(quiz.question_set_slug),
      campaignQuizzesRepo.getRating(slug),
      campaignQuizzesRepo.getRelatedPages(slug),
    ]);
    const questions = rows.flatMap((row) => {
      try {
        return [toPublicQuestion(row, rows)];
      } catch (error) {
        if (!(error instanceof BadRequestError)) throw error;
        logger.warn({ quizSlug: slug, questionId: row.id, errorMessage: error.message }, 'Skipping invalid campaign quiz question');
        return [];
      }
    });

    return {
      slug: quiz.slug,
      title: quiz.title,
      total_questions: questions.length,
      difficulty_counts: {
        easy: questions.filter((question) => question.difficulty === 'easy').length,
        medium: questions.filter((question) => question.difficulty === 'medium').length,
        hard: questions.filter((question) => question.difficulty === 'hard').length,
      },
      questions,
      rating: normalizeRating(rating),
      page: toPageContent(quiz, related, questions.length),
    };
  },

  async answer(
    slug: string,
    questionId: string,
    selectedOptionId: string,
    previewToken?: string,
  ): Promise<CampaignQuizAnswerResponse> {
    const quiz = await campaignQuizzesRepo.getVisibleQuiz(slug, previewToken);
    if (!quiz) throw new NotFoundError('Campaign quiz not found');
    const rows = await campaignQuizzesRepo.getQuestionSet(quiz.question_set_slug);
    const row = rows.find((candidate) => candidate.id === questionId);
    if (!row) throw new NotFoundError('Campaign quiz question not found');

    const payload = parseCampaignQuestion(row);
    const options = payload.type === 'mcq_single' || payload.type === 'true_false'
      ? payload.options.map((option) => ({ id: option.id, isCorrect: option.is_correct }))
      : generatedOptions(row, rows);
    const selected = options.find((option) => option.id === selectedOptionId);
    if (!selected) throw new BadRequestError('Selected option is not valid for this question');
    const correct = options.find((option) => option.isCorrect);
    if (!correct) throw new BadRequestError('Campaign quiz question has no correct option');
    const generated = generatedAnswer(payload);
    return {
      correct: selected.isCorrect,
      correct_option_id: correct.id,
      explanation: localizedText(row.explanation) ?? (generated ? `Correct answer: ${generated}.` : null),
    };
  },

  async rate(slug: string, userId: string, rating: number): Promise<CampaignQuizRatingResponse> {
    if (!(await campaignQuizzesRepo.getPublishedQuiz(slug))) throw new NotFoundError('Campaign quiz not found');
    await campaignQuizzesRepo.upsertRating(slug, userId, rating);
    return normalizeRating(await campaignQuizzesRepo.getRating(slug));
  },

  async rateAsGuest(slug: string, clientIp: string | undefined, rating: number): Promise<CampaignQuizRatingResponse> {
    if (!(await campaignQuizzesRepo.getPublishedQuiz(slug))) throw new NotFoundError('Campaign quiz not found');
    if (!clientIp) throw new BadRequestError('Could not verify this rating request');
    await campaignQuizzesRepo.upsertGuestRating(slug, guestRatingKey(slug, clientIp), rating);
    return normalizeRating(await campaignQuizzesRepo.getRating(slug));
  },

  async listAdmin(query: AdminCampaignQuizListQuery): Promise<AdminCampaignQuizListItemResponse[]> {
    const pages = await campaignQuizzesRepo.listAdminPages(query);
    return pages.map((page) => ({
      slug: page.slug,
      internal_name: page.internal_name,
      category: page.page_category,
      status: page.status,
      question_count: page.question_count,
      hero_image_url: publicCampaignQuizImageUrl(page.hero_image_url),
      locale_mode: page.locale_mode,
      scheduled_publish_at: page.scheduled_publish_at,
      published_at: page.published_at,
      updated_at: page.updated_at,
      hub_order: page.hub_order,
      is_hub_pinned: page.is_hub_pinned,
    }));
  },

  async getAdmin(slug: string): Promise<AdminCampaignQuizPageResponse> {
    const page = await campaignQuizzesRepo.getAdminPage(slug);
    if (!page) throw new NotFoundError('Quiz page not found');
    return toAdminPage(page);
  },

  async listQuestionSets(): Promise<AdminCampaignQuizQuestionSetResponse[]> {
    return campaignQuizzesRepo.listQuestionSets();
  },

  async createAdmin(input: AdminCampaignQuizPageBody, userId: string): Promise<AdminCampaignQuizPageResponse> {
    const normalized = normalizeAdminInput(input);
    if (await campaignQuizzesRepo.slugExists(input.slug)) throw new ConflictError('That quiz slug is already in use');
    await validateAttachedContent(normalized, normalized.related_slugs);
    await campaignQuizzesRepo.createAdminPage(normalized, userId);
    await recordRevision(input.slug, 'created', userId);
    return campaignQuizzesService.getAdmin(input.slug);
  },

  async updateAdmin(
    currentSlug: string,
    input: AdminCampaignQuizPageBody,
    userId: string,
    revisionAction: 'saved' | 'restored' = 'saved',
  ): Promise<AdminCampaignQuizPageResponse> {
    const normalized = normalizeAdminInput(input);
    const currentPage = await campaignQuizzesRepo.getAdminPage(currentSlug);
    if (!currentPage) throw new NotFoundError('Quiz page not found');
    if (await campaignQuizzesRepo.slugExists(input.slug, currentSlug)) throw new ConflictError('That quiz slug is already in use');
    if (
      currentPage.question_source === 'manual'
      && normalized.question_source === 'existing'
      && (normalized.question_set_slug === currentSlug || normalized.question_set_slug === normalized.slug)
    ) {
      throw new BadRequestError('Choose a different existing set before switching away from manual questions');
    }
    const overwritesOwnedQuestionSet = currentPage.question_set_slug === currentSlug
      && (
        normalized.question_source === 'manual'
        || currentPage.question_source === 'manual'
      );
    if (
      overwritesOwnedQuestionSet
      && await campaignQuizzesRepo.countQuestionSetConsumers(currentSlug, currentSlug) > 0
    ) {
      throw new BadRequestError('This page question set is used by another page and cannot be replaced');
    }
    await validateAttachedContent(normalized, normalized.related_slugs);
    if (currentPage.status === 'published') {
      const health = normalized.question_source === 'manual'
        ? {
            count: normalized.manual_questions.length,
            public_only_count: normalized.manual_questions.length,
          }
        : await campaignQuizzesRepo.getQuestionSetHealth(normalized.question_set_slug);
      const pendingPage: AdminCampaignQuizListRow = {
        ...currentPage,
        slug: normalized.slug,
        internal_name: normalized.internal_name,
        page_category: normalized.category,
        question_source: normalized.question_source,
        question_set_slug: normalized.question_source === 'manual'
          ? normalized.slug
          : normalized.question_set_slug,
        h1: normalized.h1,
        lede: normalized.lede,
        about_heading: normalized.about_heading,
        about_blocks: normalized.about_blocks,
        score_cta: normalized.score_cta,
        footer_banner_text: normalized.footer_banner_text,
        footer_button_label: normalized.footer_button_label,
        hero_image_url: normalized.hero_image_url,
        hero_image_alt: normalized.hero_image_alt,
        seo_title: normalized.seo_title,
        meta_description: normalized.meta_description,
        og_image_url: normalized.og_image_url,
        og_image_alt: normalized.og_image_alt ?? null,
        breadcrumb_label: normalized.breadcrumb_label,
        locale_mode: normalized.locale_mode,
        ka_seo_title: normalized.ka_seo_title ?? null,
        ka_meta_description: normalized.ka_meta_description ?? null,
        ka_h1: normalized.ka_h1 ?? null,
        ka_lede: normalized.ka_lede ?? null,
        question_count: health.count,
      };
      const blockers = publicationBlockers(pendingPage, health);
      if (blockers.length > 0) {
        throw new ValidationError('Published changes would make this quiz invalid', { blockers });
      }
    }
    await campaignQuizzesRepo.updateAdminPage(currentSlug, normalized, userId);
    await recordRevision(input.slug, revisionAction, userId);
    return campaignQuizzesService.getAdmin(input.slug);
  },

  async preview(slug: string, userId: string): Promise<AdminCampaignQuizPageResponse> {
    if (!(await campaignQuizzesRepo.getAdminPage(slug))) throw new NotFoundError('Quiz page not found');
    await campaignQuizzesRepo.setPreview(slug, userId);
    await recordRevision(slug, 'previewed', userId);
    return campaignQuizzesService.getAdmin(slug);
  },

  async publish(
    slug: string,
    input: AdminCampaignQuizPublishBody,
    userId: string,
  ): Promise<AdminCampaignQuizPageResponse> {
    const page = await campaignQuizzesRepo.getAdminPage(slug);
    if (!page) throw new NotFoundError('Quiz page not found');
    const blockers = await publishBlockers(page);
    if (blockers.length > 0) throw new ValidationError('Quiz page is not ready to publish', { blockers });
    const scheduledAt = input.scheduled_publish_at ?? null;
    if (scheduledAt && new Date(scheduledAt).getTime() <= Date.now()) {
      throw new BadRequestError('Scheduled publish time must be in the future');
    }
    await campaignQuizzesRepo.publish(slug, scheduledAt, userId);
    await recordRevision(slug, scheduledAt ? 'scheduled' : 'published', userId);
    return campaignQuizzesService.getAdmin(slug);
  },

  async retire(
    slug: string,
    input: AdminCampaignQuizRetireBody,
    userId: string,
    remove: boolean,
  ): Promise<void> {
    const page = await campaignQuizzesRepo.getAdminPage(slug);
    if (!page) throw new NotFoundError('Quiz page not found');
    if (input.route_mode === 'redirect') {
      if (input.target_slug === slug) throw new BadRequestError('Redirect target must be a different quiz');
      if (!(await campaignQuizzesRepo.getPublishedQuiz(input.target_slug))) {
        throw new BadRequestError('Redirect target must be a published quiz');
      }
    }
    if (
      remove
      && page.question_source === 'manual'
      && await campaignQuizzesRepo.countQuestionSetConsumers(slug, slug) > 0
    ) {
      throw new BadRequestError('This manual question set is used by another page and cannot be deleted');
    }
    await campaignQuizzesRepo.retire(slug, input, userId, remove);
    if (!remove) await recordRevision(slug, 'unpublished', userId);
  },

  async updateHubOrder(input: AdminCampaignQuizHubOrderBody, userId: string): Promise<void> {
    const pages = await campaignQuizzesRepo.listAdminPages({ status: 'published' });
    const publishedSlugs = new Set(pages.map((page) => page.slug));
    const invalid = input.items.find((item) => !publishedSlugs.has(item.slug));
    if (invalid) throw new BadRequestError(`${invalid.slug} is not a published quiz page`);
    await campaignQuizzesRepo.updateHubOrder(input.items, userId);
  },

  async listRevisions(slug: string): Promise<AdminCampaignQuizRevisionResponse[]> {
    if (!(await campaignQuizzesRepo.getAdminPage(slug))) throw new NotFoundError('Quiz page not found');
    const revisions = await campaignQuizzesRepo.listRevisions(slug);
    return revisions.map((revision) => {
      const snapshot = revision.snapshot && typeof revision.snapshot === 'object'
        ? revision.snapshot as Record<string, unknown>
        : {};
      return {
        id: Number(revision.id),
        revision_number: revision.revision_number,
        action: revision.action,
        created_at: revision.created_at,
        created_by: revision.created_by,
        editor_name: revision.editor_name,
        summary: {
          internal_name: String(snapshot.internal_name ?? slug),
          h1: String(snapshot.h1 ?? ''),
          status: String(snapshot.status ?? 'draft'),
          question_count: Number(snapshot.question_count) || 0,
        },
      };
    });
  },

  async restoreRevision(
    slug: string,
    revisionId: number,
    userId: string,
  ): Promise<AdminCampaignQuizPageResponse> {
    const revision = await campaignQuizzesRepo.getRevision(slug, revisionId);
    if (!revision) throw new NotFoundError('Quiz page revision not found');
    return campaignQuizzesService.updateAdmin(
      slug,
      revisionInput(revision.snapshot, slug),
      userId,
      'restored',
    );
  },

  async inspectAsGooglebot(slug: string): Promise<AdminCampaignQuizGooglebotResponse> {
    return campaignQuizGooglebotService.inspect(await campaignQuizzesService.getAdmin(slug));
  },

  async searchConsoleMetrics() {
    return campaignQuizSearchConsoleService.metrics();
  },

  async uploadImage(input: AdminCampaignQuizImageBody) {
    return campaignQuizImageStorageService.upload({
      dataUrl: input.data_url,
      slug: input.slug,
      kind: input.kind,
    });
  },
};
