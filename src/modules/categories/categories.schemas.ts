import { z } from 'zod';
import type { Category, I18nField } from '../../db/types.js';

/**
 * i18n field schema - object with language codes as keys
 */
export const i18nFieldSchema = z.record(z.string(), z.string());

/**
 * Category response schema.
 */
export const categoryResponseSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  parent_id: z.string().uuid().nullable(),
  name: i18nFieldSchema,
  description: i18nFieldSchema.nullable(),
  icon: z.string().nullable(),
  image_url: z.string().nullable(),
  background_img_url: z.string().nullable(),
  is_active: z.boolean(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

export type CategoryResponse = z.infer<typeof categoryResponseSchema>;

/**
 * List categories query params schema.
 */
export const listCategoriesQuerySchema = z.object({
  parent_id: z.string().uuid().optional(),
  is_active: z
    .string()
    .transform((val) => val === 'true')
    .optional(),
});

export type ListCategoriesQuery = z.infer<typeof listCategoriesQuerySchema>;

/**
 * Create category request schema.
 */
export const createCategorySchema = z.object({
  slug: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9-]+$/, 'Slug must contain only lowercase letters, numbers, and hyphens'),
  parent_id: z.string().uuid().nullable().optional(),
  name: i18nFieldSchema,
  description: i18nFieldSchema.nullable().optional(),
  icon: z.string().max(100).nullable().optional(),
  image_url: z.string().url().nullable().optional(),
  background_img_url: z.string().url().nullable().optional(),
  is_active: z.boolean().optional().default(true),
});

export type CreateCategoryRequest = z.infer<typeof createCategorySchema>;

/**
 * Update category request schema.
 */
export const updateCategorySchema = z.object({
  slug: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9-]+$/, 'Slug must contain only lowercase letters, numbers, and hyphens')
    .optional(),
  parent_id: z.string().uuid().nullable().optional(),
  name: i18nFieldSchema.optional(),
  description: i18nFieldSchema.nullable().optional(),
  icon: z.string().max(100).nullable().optional(),
  image_url: z.string().url().nullable().optional(),
  background_img_url: z.string().url().nullable().optional(),
  is_active: z.boolean().optional(),
});

export type UpdateCategoryRequest = z.infer<typeof updateCategorySchema>;

/**
 * UUID param schema.
 */
export const uuidParamSchema = z.object({
  id: z.string().uuid(),
});

export type UuidParam = z.infer<typeof uuidParamSchema>;

/**
 * Convert database Category to API response format.
 */
export function toCategoryResponse(category: Category): CategoryResponse {
  return {
    id: category.id,
    slug: category.slug,
    parent_id: category.parent_id,
    name: (category.name as I18nField) ?? {},
    description: (category.description as I18nField | null) ?? null,
    icon: category.icon,
    image_url: category.image_url,
    background_img_url: category.background_img_url,
    is_active: category.is_active,
    created_at: category.created_at,
    updated_at: category.updated_at,
  };
}
