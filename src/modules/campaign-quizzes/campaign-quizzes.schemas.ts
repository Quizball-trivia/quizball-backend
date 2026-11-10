import { z } from 'zod';
import { CAMPAIGN_QUIZ_LOCALES, EDITION_LOCALES, type CampaignLocale, type EditionLocale } from './campaign-quizzes.editions.js';

export const campaignQuizSlugParamsSchema = z.object({
  slug: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
});

export const campaignQuizLocaleQuerySchema = z.object({
  locale: z.enum(CAMPAIGN_QUIZ_LOCALES).optional().default('en'),
});

export const campaignQuizAnswerBodySchema = z.object({
  question_id: z.string().uuid(),
  selected_option_id: z.string().min(1).max(80),
  preview_token: z.string().uuid().optional(),
  /** The set version the round was served from; answers stay valid for a day after the set is rotated. */
  set_version: z.number().int().positive().optional(),
});

export const campaignQuizRatingBodySchema = z.object({
  rating: z.number().int().min(1).max(5),
});

export const campaignQuizPreviewQuerySchema = z.object({
  preview: z.string().uuid().optional(),
  locale: z.enum(CAMPAIGN_QUIZ_LOCALES).optional().default('en'),
});

/** Locale-aware route lookup: `public` is the slug as it appears in that language's URL. */
export const campaignQuizRouteQuerySchema = z.object({
  locale: z.enum(CAMPAIGN_QUIZ_LOCALES).optional(),
  public: z.string().min(1).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).optional(),
});

export const campaignQuizListQuerySchema = z.object({
  locale: z.enum(CAMPAIGN_QUIZ_LOCALES).default('en'),
});

const nullableUrlSchema = z
  .union([z.string().trim().url().max(2_000), z.literal(''), z.null()])
  .transform((value) => value || null);

export const campaignQuizAboutBlockSchema = z.object({
  id: z.string().trim().min(1).max(80),
  type: z.enum(['paragraph', 'bullet']),
  text: z.string().trim().min(1).max(4_000),
});

const publicSlugSchema = z.string().min(1).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

/** One language of a page: the same fields as the English form. A language sent replaces that language. */
export const campaignQuizEditionCopySchema = z.object({
  title: optionalText(180),
  h1: optionalText(180),
  seo_title: optionalText(180),
  meta_description: optionalText(500),
  breadcrumb_label: optionalText(120),
  lede: optionalText(1_200),
  about_heading: optionalText(220),
  hero_image_alt: optionalText(240),
  og_image_alt: optionalText(240),
  score_cta: optionalText(500),
  footer_banner_text: optionalText(500),
  footer_button_label: optionalText(80),
  about_blocks: z.array(z.lazy(() => campaignQuizAboutBlockSchema)).max(40).nullable().optional(),
}).strict();

export const campaignQuizEditionsSchema = z.object(
  Object.fromEntries(EDITION_LOCALES.map((locale) => [locale, campaignQuizEditionCopySchema.optional()])) as Record<
    EditionLocale,
    z.ZodOptional<typeof campaignQuizEditionCopySchema>
  >,
).strict();

export const campaignQuizPublicSlugsSchema = z.object(
  Object.fromEntries(CAMPAIGN_QUIZ_LOCALES.map((locale) => [locale, publicSlugSchema.optional()])) as Record<
    CampaignLocale,
    z.ZodOptional<typeof publicSlugSchema>
  >,
).strict();

export const adminCampaignQuizManualQuestionSchema = z
  .object({
    id: z.string().uuid().optional(),
    prompt: z.string().trim().min(1).max(500),
    difficulty: z.enum(['easy', 'medium', 'hard']),
    options: z.tuple([
      z.string().trim().min(1).max(240),
      z.string().trim().min(1).max(240),
      z.string().trim().min(1).max(240),
      z.string().trim().min(1).max(240),
    ]),
    correct_option: z.enum(['a', 'b', 'c', 'd']),
    explanation: z.string().trim().max(2_000).nullable().optional(),
  })
  .superRefine((question, ctx) => {
    const normalizedOptions = question.options.map((option) => option.toLocaleLowerCase('en'));
    if (new Set(normalizedOptions).size !== normalizedOptions.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Answer options must be unique',
        path: ['options'],
      });
    }
  });

export const adminCampaignQuizPageBodySchema = z
  .object({
    internal_name: z.string().trim().max(160),
    slug: campaignQuizSlugParamsSchema.shape.slug,
    category: z.enum(['team', 'league', 'quiz_type', 'article']),
    /** The quiz name in English (game title); left out, the H1 is used as before. */
    title: z.string().trim().max(180).nullable().optional(),
    h1: z.string().trim().max(180),
    lede: z.string().trim().max(1_200),
    question_source: z.enum(['existing', 'manual']).default('existing'),
    question_set_slug: campaignQuizSlugParamsSchema.shape.slug,
    manual_questions: z.array(adminCampaignQuizManualQuestionSchema).max(15).default([]),
    about_heading: z.string().trim().max(220),
    about_blocks: z.array(campaignQuizAboutBlockSchema).max(40),
    score_cta: z.string().trim().max(500),
    footer_banner_text: z.string().trim().max(500),
    footer_button_label: z.string().trim().max(80),
    related_slugs: z.array(campaignQuizSlugParamsSchema.shape.slug).max(6),
    hero_image_url: nullableUrlSchema,
    hero_image_alt: z.string().trim().max(240),
    seo_title: z.string().trim().max(180),
    meta_description: z.string().trim().max(500),
    og_image_url: nullableUrlSchema,
    og_image_alt: z.string().trim().max(240).nullable().optional(),
    breadcrumb_label: z.string().trim().max(120),
    locale_mode: z.enum(['en_only', 'en_ka']),
    ka_seo_title: z.string().trim().max(180).nullable().optional(),
    ka_meta_description: z.string().trim().max(500).nullable().optional(),
    ka_h1: z.string().trim().max(180).nullable().optional(),
    ka_lede: z.string().trim().max(1_200).nullable().optional(),
    /** Other languages and URLs; left out, they stay as they are (older CMS builds send English and Georgian only). */
    editions: campaignQuizEditionsSchema.optional(),
    public_slugs: campaignQuizPublicSlugsSchema.optional(),
    agent_locked: z.boolean().optional(),
    /** The page version the editor loaded; a save over a newer version is refused. */
    expected_version: z.number().int().positive().optional(),
  })
  .superRefine((page, ctx) => {
    if (page.question_source === 'manual' && page.question_set_slug !== page.slug) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Manually entered questions must use this page as their question set',
        path: ['question_set_slug'],
      });
    }

    for (const locale of ['en', 'ka'] as const) {
      if (page.public_slugs?.[locale] && page.public_slugs[locale] !== page.slug) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'English and Georgian use the page slug', path: ['public_slugs', locale] });
      }
    }

    if (page.question_source === 'existing' && page.manual_questions.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Manual questions can only be supplied when manual entry is selected',
        path: ['manual_questions'],
      });
    }

    const normalizedPrompts = page.manual_questions.map((question) =>
      question.prompt.toLocaleLowerCase('en'),
    );
    if (new Set(normalizedPrompts).size !== normalizedPrompts.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Question prompts must be unique within a manual set',
        path: ['manual_questions'],
      });
    }
  });

export const adminCampaignQuizListQuerySchema = z.object({
  status: z.enum(['draft', 'preview', 'published', 'archived']).optional(),
  category: z.enum(['team', 'league', 'quiz_type', 'article']).optional(),
  search: z.string().trim().max(160).optional(),
});

export const adminCampaignQuizPublishBodySchema = z.object({
  scheduled_publish_at: z.string().datetime({ offset: true }).nullable().optional(),
});

export const adminCampaignQuizRetireBodySchema = z.discriminatedUnion('route_mode', [
  z.object({
    route_mode: z.literal('redirect'),
    target_slug: campaignQuizSlugParamsSchema.shape.slug,
  }),
  z.object({
    route_mode: z.literal('gone'),
    target_slug: z.null().optional(),
  }),
]);

export const adminCampaignQuizImageBodySchema = z.object({
  data_url: z.string().min(32).max(16_000_000),
  kind: z.enum(['hero', 'og']),
  slug: campaignQuizSlugParamsSchema.shape.slug,
});

export const adminCampaignQuizImageGenerateBodySchema = z.object({
  prompt: z.string().trim().min(40).max(4_000),
});

export const adminCampaignQuizHubOrderBodySchema = z
  .object({
    items: z.array(z.object({
      slug: campaignQuizSlugParamsSchema.shape.slug,
      hub_order: z.number().int().min(0).max(10_000),
      is_pinned: z.boolean(),
    })).min(1).max(200),
  })
  .superRefine((value, ctx) => {
    const slugs = value.items.map((item) => item.slug);
    if (new Set(slugs).size !== slugs.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Each hub page can only appear once',
        path: ['items'],
      });
    }
  });

export const adminCampaignQuizRevisionParamsSchema = campaignQuizSlugParamsSchema.extend({
  revisionId: z.coerce.number().int().positive(),
});

const agentCopySchema = campaignQuizEditionCopySchema.extend({
  title: z.string().trim().min(1).max(180),
  h1: z.string().trim().min(1).max(180),
  seo_title: z.string().trim().min(1).max(180),
  meta_description: z.string().trim().min(1).max(500),
  breadcrumb_label: z.string().trim().min(1).max(120),
  lede: z.string().trim().min(1).max(1_200),
  about_heading: z.string().trim().min(1).max(220),
  hero_image_alt: z.string().trim().min(1).max(240),
  score_cta: z.string().trim().min(1).max(500),
  footer_banner_text: z.string().trim().min(1).max(500),
  footer_button_label: z.string().trim().min(1).max(80),
  about_blocks: z.array(campaignQuizAboutBlockSchema).min(1).max(40),
});

const idempotencyKeySchema = z.string().min(16).max(128).regex(/^[A-Za-z0-9:._-]+$/);
const futureDateSchema = z.string().datetime({ offset: true });

/** A complete page in all eight languages with its ten questions, as the agent builds it. */
export const agentCampaignQuizCandidateSchema = z
  .object({
    action: z.enum(['create', 'refresh']),
    slug: campaignQuizSlugParamsSchema.shape.slug,
    expected_version: z.number().int().positive().nullable(),
    internal_name: z.string().trim().min(1).max(160),
    category: z.enum(['team', 'league', 'quiz_type']),
    copy: z.object(
      Object.fromEntries(CAMPAIGN_QUIZ_LOCALES.map((locale) => [locale, agentCopySchema])) as Record<CampaignLocale, typeof agentCopySchema>,
    ).strict(),
    public_slugs: z.object(
      Object.fromEntries(CAMPAIGN_QUIZ_LOCALES.map((locale) => [locale, publicSlugSchema])) as Record<CampaignLocale, typeof publicSlugSchema>,
    ).strict(),
    hero_image_url: z.string().trim().min(1).max(2_000),
    og_image_url: z.string().trim().min(1).max(2_000).nullable().optional(),
    questions: z.array(z.object({ id: z.string().uuid(), difficulty: z.enum(['easy', 'medium', 'hard']) })).length(10),
    related_slugs: z.array(campaignQuizSlugParamsSchema.shape.slug).max(6).optional(),
    next_refresh_at: futureDateSchema,
    /** The work-list claim a create is built under: the commit checks it is still this runner's, then finishes it. */
    claim: z.object({ backlog_id: z.string().uuid(), lease_token: z.string().uuid() }).strict().optional(),
    /** The HQ report the commit files for the Director: the work it did, and the HQ task it was for (a rework or a requested refresh). */
    hq: z.object({
      action: z.enum(['create', 'refresh', 'repair']),
      title: z.string().trim().min(3).max(200),
      result: z.string().trim().min(1).max(20_000),
      task: z.object({ id: z.string().uuid(), claim_token: z.string().uuid() }).strict().optional(),
    }).strict().optional(),
  })
  .superRefine((candidate, ctx) => {
    if ((candidate.action === 'create') !== (candidate.expected_version === null)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'create has no expected_version; refresh needs one', path: ['expected_version'] });
    }
    const ids = candidate.questions.map((question) => question.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Questions must be distinct', path: ['questions'] });
    }
    const count = (difficulty: string) => candidate.questions.filter((question) => question.difficulty === difficulty).length;
    if (count('easy') !== 4 || count('medium') !== 3 || count('hard') !== 3) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A round is 4 easy, 3 medium and 3 hard questions', path: ['questions'] });
    }
    // English and Georgian share /football-quiz and are served under the page's own slug.
    if (candidate.public_slugs.en !== candidate.slug || candidate.public_slugs.ka !== candidate.slug) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'en and ka use the page slug', path: ['public_slugs'] });
    }
    if (candidate.related_slugs?.includes(candidate.slug)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A quiz cannot be related to itself', path: ['related_slugs'] });
    }
    if (candidate.action !== 'create' && candidate.claim) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Only a create runs under a work-list claim', path: ['claim'] });
    }
    if (candidate.hq && (candidate.hq.action === 'create') !== (candidate.action === 'create')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'The HQ report must describe the same action', path: ['hq', 'action'] });
    }
    if (candidate.hq?.task && candidate.action === 'create') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A new page reports to its task through the work list', path: ['hq', 'task'] });
    }
  });

export const agentCampaignQuizCommitBodySchema = z.object({
  idempotency_key: idempotencyKeySchema,
  candidate: agentCampaignQuizCandidateSchema,
});

export const agentCampaignQuizReviewBodySchema = z.object({
  idempotency_key: idempotencyKeySchema,
  expected_version: z.number().int().positive(),
  next_refresh_at: futureDateSchema,
});

export const agentCampaignQuizLockBodySchema = z.object({
  reason: z.string().trim().min(3).max(1_000),
});

export const agentCampaignQuizDueQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

export type CampaignQuizSlugParams = z.infer<typeof campaignQuizSlugParamsSchema>;
export type CampaignQuizEditionCopy = z.infer<typeof campaignQuizEditionCopySchema>;
export type AgentCampaignQuizCandidate = z.infer<typeof agentCampaignQuizCandidateSchema>;
export type AgentCampaignQuizCommitBody = z.infer<typeof agentCampaignQuizCommitBodySchema>;
export type AgentCampaignQuizReviewBody = z.infer<typeof agentCampaignQuizReviewBodySchema>;
export type AgentCampaignQuizDueQuery = z.infer<typeof agentCampaignQuizDueQuerySchema>;
export type AgentCampaignQuizLockBody = z.infer<typeof agentCampaignQuizLockBodySchema>;
export type CampaignQuizLocaleQuery = z.infer<typeof campaignQuizLocaleQuerySchema>;
export type CampaignQuizAnswerBody = z.infer<typeof campaignQuizAnswerBodySchema>;
export type CampaignQuizRatingBody = z.infer<typeof campaignQuizRatingBodySchema>;
export type CampaignQuizPreviewQuery = z.infer<typeof campaignQuizPreviewQuerySchema>;
export type CampaignQuizListQuery = z.infer<typeof campaignQuizListQuerySchema>;
export type CampaignQuizRouteQuery = z.infer<typeof campaignQuizRouteQuerySchema>;
export type AdminCampaignQuizPageBody = z.infer<typeof adminCampaignQuizPageBodySchema>;
export type AdminCampaignQuizListQuery = z.infer<typeof adminCampaignQuizListQuerySchema>;
export type AdminCampaignQuizPublishBody = z.infer<typeof adminCampaignQuizPublishBodySchema>;
export type AdminCampaignQuizRetireBody = z.infer<typeof adminCampaignQuizRetireBodySchema>;
export type AdminCampaignQuizImageBody = z.infer<typeof adminCampaignQuizImageBodySchema>;
export type AdminCampaignQuizImageGenerateBody = z.infer<typeof adminCampaignQuizImageGenerateBodySchema>;
export type AdminCampaignQuizHubOrderBody = z.infer<typeof adminCampaignQuizHubOrderBodySchema>;
export type AdminCampaignQuizRevisionParams = z.infer<typeof adminCampaignQuizRevisionParamsSchema>;
export type CampaignQuizAboutBlock = z.infer<typeof campaignQuizAboutBlockSchema>;
export type AdminCampaignQuizManualQuestion = z.infer<typeof adminCampaignQuizManualQuestionSchema>;

export interface CampaignQuizOptionResponse {
  id: string;
  text: string;
}

export interface CampaignQuizQuestionResponse {
  id: string;
  position: number;
  difficulty: 'easy' | 'medium' | 'hard';
  type: 'mcq_single' | 'true_false' | 'clue_chain' | 'career_path';
  prompt: string;
  details: string[];
  image_url: string | null;
  options: CampaignQuizOptionResponse[];
}

export interface CampaignQuizRatingResponse {
  average: number | null;
  count: number;
}

export interface CampaignQuizRelatedPageResponse {
  slug: string;
  breadcrumb_label: string;
  hero_image_url: string | null;
  hero_image_alt: string;
}

export interface CampaignQuizPageContentResponse {
  category: 'team' | 'league' | 'quiz_type' | 'article';
  h1: string;
  lede: string;
  about_heading: string;
  about_blocks: CampaignQuizAboutBlock[];
  score_cta: string;
  footer_banner_text: string;
  footer_button_label: string;
  hero_image_url: string | null;
  hero_image_alt: string;
  seo_title: string;
  meta_description: string;
  og_image_url: string | null;
  og_image_alt: string | null;
  breadcrumb_label: string;
  locale_mode: 'en_only' | 'en_ka';
  ka_seo_title: string | null;
  ka_meta_description: string | null;
  ka_h1: string | null;
  ka_lede: string | null;
  related_pages: CampaignQuizRelatedPageResponse[];
  updated_at: string;
  /** Last real change of what the page shows (copy, images or questions): the date search engines are given. */
  content_modified_at: string;
}

export interface CampaignQuizHubPageResponse {
  slug: string;
  category: 'team' | 'league' | 'quiz_type' | 'article';
  h1: string;
  breadcrumb_label: string;
  hero_image_url: string | null;
  hero_image_alt: string;
  locale_mode: 'en_only' | 'en_ka';
  updated_at: string;
  content_modified_at: string;
  public_slugs: Partial<Record<CampaignLocale, string>>;
}

export interface CampaignQuizSlugsResponse {
  pages: Array<{ slug: string; public_slugs: Partial<Record<CampaignLocale, string>> }>;
}

export interface CampaignQuizResponse {
  slug: string;
  title: string;
  total_questions: number;
  difficulty_counts: {
    easy: number;
    medium: number;
    hard: number;
  };
  questions: CampaignQuizQuestionResponse[];
  rating: CampaignQuizRatingResponse;
  page: CampaignQuizPageContentResponse | null;
  /**
   * Which language editions the page has (the catalog's rule); a missing edition is served in English.
   * QUESTION_GATED_LOCALES also need every question of the set in their language.
   */
  editions: Record<EditionLocale, boolean>;
  /** The question set version this round comes from; send it back with each answer. */
  set_version: number;
  public_slugs: Partial<Record<CampaignLocale, string>>;
}

export interface CampaignQuizAnswerResponse {
  correct: boolean;
  correct_option_id: string;
  explanation: string | null;
}

export interface CampaignQuizRouteResponse {
  kind: 'page' | 'redirect' | 'gone' | 'missing';
  slug: string;
  target_slug: string | null;
  /** With ?locale=: the page's (kind page) or the target's (kind redirect) public slug in that language. */
  public_slug?: string | null;
}

export interface AdminCampaignQuizQuestionSetResponse {
  slug: string;
  name: string;
  count: number;
  easy: number;
  medium: number;
  hard: number;
  public_only: boolean;
}

export interface AdminCampaignQuizListItemResponse {
  slug: string;
  internal_name: string;
  category: 'team' | 'league' | 'quiz_type' | 'article';
  status: 'draft' | 'preview' | 'published' | 'archived';
  question_count: number;
  hero_image_url: string | null;
  locale_mode: 'en_only' | 'en_ka';
  scheduled_publish_at: string | null;
  published_at: string | null;
  updated_at: string;
  hub_order: number;
  is_hub_pinned: boolean;
  version: number;
  content_modified_at: string;
  last_reviewed_at: string | null;
  next_refresh_at: string | null;
  agent_locked: boolean;
  managed_by: 'cms' | 'agent';
}

export interface AdminCampaignQuizPageResponse extends AdminCampaignQuizListItemResponse {
  title: string;
  h1: string;
  lede: string;
  question_source: 'existing' | 'manual';
  question_set_slug: string;
  manual_questions: AdminCampaignQuizManualQuestion[];
  about_heading: string;
  about_blocks: CampaignQuizAboutBlock[];
  score_cta: string;
  footer_banner_text: string;
  footer_button_label: string;
  related_slugs: string[];
  hero_image_alt: string;
  seo_title: string;
  meta_description: string;
  og_image_url: string | null;
  og_image_alt: string | null;
  breadcrumb_label: string;
  ka_seo_title: string | null;
  ka_meta_description: string | null;
  ka_h1: string | null;
  ka_lede: string | null;
  preview_token: string;
  preview_url: string;
  warnings: string[];
  editions: Partial<Record<EditionLocale, CampaignQuizEditionCopy>>;
  public_slugs: Partial<Record<CampaignLocale, string>>;
  locale_readiness: Array<{ locale: CampaignLocale; ready: boolean; problems: string[] }>;
  version: number;
  content_modified_at: string;
  last_reviewed_at: string | null;
  next_refresh_at: string | null;
  agent_locked: boolean;
  managed_by: 'cms' | 'agent';
  set_version: number;
  questions: Array<{ id: string; difficulty: 'easy' | 'medium' | 'hard' }>;
}

export interface AdminCampaignQuizRevisionResponse {
  id: number;
  revision_number: number;
  action: 'created' | 'saved' | 'previewed' | 'published' | 'scheduled' | 'unpublished' | 'restored';
  created_at: string;
  created_by: string | null;
  editor_name: string | null;
  summary: {
    internal_name: string;
    h1: string;
    status: string;
    question_count: number;
  };
}

export interface AdminCampaignQuizGooglebotResponse {
  url: string;
  fetched_at: string;
  status_code: number;
  html: string;
  checks: Array<{
    key: 'http_response' | 'title' | 'meta_description' | 'canonical' | 'hreflang' | 'webpage_schema' | 'breadcrumb_schema' | 'game_schema' | 'question_html';
    label: string;
    passed: boolean;
    detail: string;
  }>;
}

export interface AdminCampaignQuizSearchConsoleResponse {
  configured: boolean;
  reason: string | null;
  property: string | null;
  start_date: string | null;
  end_date: string | null;
  pages: Array<{
    slug: string;
    clicks: number;
    impressions: number;
    ctr: number;
    position: number | null;
  }>;
}
