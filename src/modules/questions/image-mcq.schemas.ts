import { z } from 'zod';
import { difficultyEnum, mcqOptionSchema, questionResponseSchema } from './questions.schemas.js';

export const imageMcqGeneratePreviewSchema = z.object({
  category_ids: z.array(z.string().uuid()).min(1).max(20).optional(),
  limit_categories: z.number().int().min(1).max(50).optional().default(8),
  images_per_category: z.number().int().min(1).max(25).optional().default(1),
  questions_per_image: z.number().int().min(6).max(6).optional().default(6),
  image_width: z.number().int().min(256).max(2400).optional().default(1440),
  image_height: z.number().int().min(256).max(2400).optional().default(1080),
  model: z.string().min(1).optional(),
});

export type ImageMcqGeneratePreviewRequest = z.infer<typeof imageMcqGeneratePreviewSchema>;

export const generatedImageMcqImageSchema = z.object({
  data_url: z.string().startsWith('data:image/png;base64,'),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  aspect_ratio: z.string(),
  source_url: z.string().url(),
  title: z.string(),
  author: z.string().nullable(),
  license: z.string().nullable(),
  license_url: z.string().url().nullable(),
  provider: z.string(),
});

export const generatedImageMcqCardSchema = z.object({
  id: z.string().min(1),
  category_id: z.string().uuid(),
  category_slug: z.string().min(1),
  category_name: z.string().min(1),
  prompt: z.object({ en: z.string().min(1) }),
  difficulty: difficultyEnum,
  options: z.array(mcqOptionSchema).length(4),
  explanation: z.object({ en: z.string().min(1) }),
  confidence: z.number().min(0).max(1),
  image: generatedImageMcqImageSchema,
});

export type GeneratedImageMcqCard = z.infer<typeof generatedImageMcqCardSchema>;

export const imageMcqGeneratePreviewResponseSchema = z.object({
  cards: z.array(generatedImageMcqCardSchema),
  skipped: z.array(
    z.object({
      category_id: z.string().uuid(),
      category_slug: z.string(),
      reason: z.string(),
    })
  ),
});

export type ImageMcqGeneratePreviewResponse = z.infer<typeof imageMcqGeneratePreviewResponseSchema>;

export const imageMcqSaveDraftsSchema = z.object({
  cards: z.array(generatedImageMcqCardSchema).min(1).max(200),
  translate_to_ka: z.boolean().optional().default(false),
});

export type ImageMcqSaveDraftsRequest = z.infer<typeof imageMcqSaveDraftsSchema>;

export const imageMcqSaveDraftsResponseSchema = z.object({
  total: z.number().int().nonnegative(),
  successful: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  created: z.array(questionResponseSchema),
  errors: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      error: z.string(),
    })
  ),
});

export type ImageMcqSaveDraftsResponse = z.infer<typeof imageMcqSaveDraftsResponseSchema>;
