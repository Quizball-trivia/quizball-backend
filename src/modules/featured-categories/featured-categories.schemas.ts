import { z } from 'zod';
import type { FeaturedCategory, Category, I18nField } from '../../db/types.js';

/**
 * i18n field schema - object with language codes as keys
 */
export const i18nFieldSchema = z.record(z.string(), z.string());

/**
 * Featured category response schema (with joined category data).
 */
export const featuredCategoryResponseSchema = z.object({
  id: z.string().uuid(),
  category_id: z.string().uuid(),
  sort_order: z.number().int(),
  created_at: z.string().datetime(),
  category: z.object({
    id: z.string().uuid(),
    slug: z.string(),
    parent_id: z.string().uuid().nullable(),
    name: i18nFieldSchema,
    description: i18nFieldSchema.nullable(),
    icon: z.string().nullable(),
    image_url: z.string().nullable(),
    is_active: z.boolean(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  }),
});

export type FeaturedCategoryResponse = z.infer<typeof featuredCategoryResponseSchema>;

/**
 * Create featured category request schema.
 */
export const createFeaturedCategorySchema = z.object({
  category_id: z.string().uuid(),
  sort_order: z.number().int().min(0).optional(),
});

export type CreateFeaturedCategoryRequest = z.infer<typeof createFeaturedCategorySchema>;

/**
 * Update featured category request schema.
 */
export const updateFeaturedCategorySchema = z.object({
  sort_order: z.number().int().min(0),
});

export type UpdateFeaturedCategoryRequest = z.infer<typeof updateFeaturedCategorySchema>;

/**
 * Reorder featured categories request schema.
 */
export const reorderFeaturedCategoriesSchema = z.object({
  items: z.array(
    z.object({
      id: z.string().uuid(),
      sort_order: z.number().int().min(0),
    })
  ).min(1),
});

export type ReorderFeaturedCategoriesRequest = z.infer<typeof reorderFeaturedCategoriesSchema>;

/**
 * UUID param schema.
 */
export const uuidParamSchema = z.object({
  id: z.string().uuid(),
});

export type UuidParam = z.infer<typeof uuidParamSchema>;

/**
 * Convert database FeaturedCategory with Category to API response format.
 */
export function toFeaturedCategoryResponse(
  featured: FeaturedCategory,
  category: Category
): FeaturedCategoryResponse {
  return {
    id: featured.id,
    category_id: featured.category_id,
    sort_order: featured.sort_order,
    created_at: featured.created_at,
    category: {
      id: category.id,
      slug: category.slug,
      parent_id: category.parent_id,
      name: (category.name as I18nField) ?? {},
      description: (category.description as I18nField | null) ?? null,
      icon: category.icon,
      image_url: category.image_url,
      is_active: category.is_active,
      created_at: category.created_at,
      updated_at: category.updated_at,
    },
  };
}
