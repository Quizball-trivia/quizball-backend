import { z } from 'zod';

export const campaignQuizSlugParamsSchema = z.object({
  slug: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
});

export const campaignQuizLocaleQuerySchema = z.object({
  locale: z.enum(['en', 'ka', 'es']).optional().default('en'),
});

export const campaignQuizAnswerBodySchema = z.object({
  question_id: z.string().uuid(),
  selected_option_id: z.string().min(1).max(80),
  preview_token: z.string().uuid().optional(),
});

export const campaignQuizRatingBodySchema = z.object({
  rating: z.number().int().min(1).max(5),
});

export const campaignQuizPreviewQuerySchema = z.object({
  preview: z.string().uuid().optional(),
  locale: z.enum(['en', 'ka', 'es']).optional().default('en'),
});

export const campaignQuizListQuerySchema = z.object({
  locale: z.enum(['en', 'ka', 'es']).default('en'),
});

const nullableUrlSchema = z
  .union([z.string().trim().url().max(2_000), z.literal(''), z.null()])
  .transform((value) => value || null);

export const campaignQuizAboutBlockSchema = z.object({
  id: z.string().trim().min(1).max(80),
  type: z.enum(['paragraph', 'bullet']),
  text: z.string().trim().min(1).max(4_000),
});

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
  })
  .superRefine((page, ctx) => {
    if (page.question_source === 'manual' && page.question_set_slug !== page.slug) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Manually entered questions must use this page as their question set',
        path: ['question_set_slug'],
      });
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

export type CampaignQuizSlugParams = z.infer<typeof campaignQuizSlugParamsSchema>;
export type CampaignQuizLocaleQuery = z.infer<typeof campaignQuizLocaleQuerySchema>;
export type CampaignQuizAnswerBody = z.infer<typeof campaignQuizAnswerBodySchema>;
export type CampaignQuizRatingBody = z.infer<typeof campaignQuizRatingBodySchema>;
export type CampaignQuizPreviewQuery = z.infer<typeof campaignQuizPreviewQuerySchema>;
export type CampaignQuizListQuery = z.infer<typeof campaignQuizListQuerySchema>;
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
}

export interface AdminCampaignQuizPageResponse extends AdminCampaignQuizListItemResponse {
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
