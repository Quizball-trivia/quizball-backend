import { z } from 'zod';
import type { Category, I18nField } from '../../db/types.js';
import type { CategoryDependencies } from './categories.service.js';

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
  is_active: z.boolean(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

export type CategoryResponse = z.infer<typeof categoryResponseSchema>;

/**
 * List categories query params schema with pagination.
 */
export const listCategoriesQuerySchema = z.object({
  parent_id: z.string().uuid().optional(),
  is_active: z
    .string()
    .transform((val) => val === 'true')
    .optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
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
 * Delete category query params schema.
 */
export const deleteCategoryQuerySchema = z.object({
  cascade: z
    .string()
    .transform((val) => val === 'true')
    .optional(),
});

export type DeleteCategoryQuery = z.infer<typeof deleteCategoryQuerySchema>;

/**
 * Category dependencies response schema.
 */
export const categoryDependenciesResponseSchema = z.object({
  children: z.array(
    z.object({
      id: z.string().uuid(),
      name: i18nFieldSchema,
      slug: z.string(),
    })
  ),
  questions: z.array(
    z.object({
      id: z.string().uuid(),
      prompt: i18nFieldSchema,
      type: z.string(),
      difficulty: z.string(),
    })
  ),
  featured: z.boolean(),
});

export type CategoryDependenciesResponse = z.infer<typeof categoryDependenciesResponseSchema>;

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
    is_active: category.is_active,
    created_at: category.created_at,
    updated_at: category.updated_at,
  };
}

/**
 * Convert category dependencies to API response format.
 */
export function toDependenciesResponse(deps: CategoryDependencies): CategoryDependenciesResponse {
  return {
    children: deps.children,
    questions: deps.questions,
    featured: deps.featured,
  };
}
