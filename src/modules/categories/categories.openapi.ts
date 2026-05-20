import '../../http/openapi/zod-init.js';
import { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { errorResponseSchema, i18nFieldSchema } from '../../http/openapi/common-schemas.js';
import { registerEndpoint } from '../../http/openapi/register-endpoint.js';
import { deleteCategoryResultSchema } from './categories.schemas.js';

export const categoryResponseSchema = z
  .object({
    id: z.string().uuid(),
    slug: z.string(),
    parent_id: z.string().uuid().nullable(),
    name: i18nFieldSchema,
    description: i18nFieldSchema.nullable(),
    icon: z.string().nullable(),
    image_url: z.string().url().nullable(),
    is_active: z.boolean(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  })
  .openapi('CategoryResponse');

const paginatedCategoriesResponseSchema = z
  .object({
    data: z.array(categoryResponseSchema),
    page: z.number().int().positive(),
    limit: z.number().int().positive(),
    total: z.number().int().nonnegative(),
    total_pages: z.number().int().nonnegative(),
  })
  .openapi('PaginatedCategoriesResponse');

const categoryDependenciesResponseSchema = z
  .object({
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
  })
  .openapi('CategoryDependenciesResponse');

const categoryIdParamSchema = z.object({ id: z.string().uuid() });

export function registerCategoriesOpenApi(registry: OpenAPIRegistry): void {
  registry.register('CategoryResponse', categoryResponseSchema);
  registry.register('DeleteCategoryResult', deleteCategoryResultSchema);
  registry.register('PaginatedCategoriesResponse', paginatedCategoriesResponseSchema);
  registry.register('CategoryDependenciesResponse', categoryDependenciesResponseSchema);

  registerEndpoint(registry, {
    method: 'get',
    path: '/api/v1/categories',
    summary: 'List all categories',
    tags: ['Categories'],
    query: z.object({
      parent_id: z.string().uuid().optional(),
      is_active: z.string().optional(),
      min_questions: z.coerce.number().int().min(1).optional(),
      page: z.coerce.number().int().min(1).optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    }),
    responses: {
      200: { description: 'List of categories', schema: paginatedCategoriesResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'get',
    path: '/api/v1/categories/{id}',
    summary: 'Get category by ID',
    tags: ['Categories'],
    pathParams: categoryIdParamSchema,
    responses: {
      200: { description: 'Category found', schema: categoryResponseSchema },
      404: { description: 'Category not found', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'get',
    path: '/api/v1/categories/{id}/dependencies',
    summary: 'Get category dependencies',
    description: 'Returns child categories, associated questions, and featured status',
    tags: ['Categories'],
    pathParams: categoryIdParamSchema,
    responses: {
      200: { description: 'Category dependencies', schema: categoryDependenciesResponseSchema },
      404: { description: 'Category not found', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'post',
    path: '/api/v1/categories',
    summary: 'Create a new category',
    description: 'Requires admin role',
    tags: ['Categories'],
    security: [{ bearerAuth: [] }],
    body: z.object({
      slug: z.string().min(1).max(100),
      parent_id: z.string().uuid().nullable().optional(),
      name: i18nFieldSchema,
      description: i18nFieldSchema.nullable().optional(),
      icon: z.string().max(100).nullable().optional(),
      image_url: z.string().url().nullable().optional(),
      is_active: z.boolean().optional(),
    }),
    responses: {
      201: { description: 'Category created', schema: categoryResponseSchema },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
      403: { description: 'Insufficient permissions (admin role required)', schema: errorResponseSchema },
      409: { description: 'Slug already exists', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'put',
    path: '/api/v1/categories/{id}',
    summary: 'Update a category',
    description: 'Requires admin role',
    tags: ['Categories'],
    security: [{ bearerAuth: [] }],
    pathParams: categoryIdParamSchema,
    body: z.object({
      slug: z.string().min(1).max(100).optional(),
      parent_id: z.string().uuid().nullable().optional(),
      name: i18nFieldSchema.optional(),
      description: i18nFieldSchema.nullable().optional(),
      icon: z.string().max(100).nullable().optional(),
      image_url: z.string().url().nullable().optional(),
      is_active: z.boolean().optional(),
    }),
    responses: {
      200: { description: 'Category updated', schema: categoryResponseSchema },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
      403: { description: 'Insufficient permissions (admin role required)', schema: errorResponseSchema },
      404: { description: 'Category not found', schema: errorResponseSchema },
      409: { description: 'Slug already exists', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'delete',
    path: '/api/v1/categories/{id}',
    summary: 'Delete a category',
    description: 'Delete a category. Use cascade=true to also delete associated questions. Requires admin role.',
    tags: ['Categories'],
    security: [{ bearerAuth: [] }],
    pathParams: categoryIdParamSchema,
    query: z.object({
      cascade: z.string().optional().openapi({
        description: 'Set to "true" to delete associated questions before deleting the category',
        example: 'true',
      }),
    }),
    responses: {
      200: { description: 'Category deleted or archived', schema: deleteCategoryResultSchema },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
      403: { description: 'Insufficient permissions (admin role required)', schema: errorResponseSchema },
      404: { description: 'Category not found', schema: errorResponseSchema },
      409: { description: 'Category has children or questions (when cascade=false)', schema: errorResponseSchema },
    },
  });
}
