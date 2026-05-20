import '../../http/openapi/zod-init.js';
import { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { errorResponseSchema } from '../../http/openapi/common-schemas.js';
import { registerEndpoint } from '../../http/openapi/register-endpoint.js';
import { categoryResponseSchema } from '../categories/categories.openapi.js';

const featuredCategoryResponseSchema = z
  .object({
    id: z.string().uuid(),
    category_id: z.string().uuid(),
    sort_order: z.number().int(),
    created_at: z.string().datetime(),
    category: categoryResponseSchema,
  })
  .openapi('FeaturedCategoryResponse');

const featuredCategoryIdParamSchema = z.object({ id: z.string().uuid() });

export function registerFeaturedCategoriesOpenApi(registry: OpenAPIRegistry): void {
  registry.register('FeaturedCategoryResponse', featuredCategoryResponseSchema);

  registerEndpoint(registry, {
    method: 'get',
    path: '/api/v1/featured-categories',
    summary: 'List all featured categories',
    tags: ['Featured Categories'],
    responses: {
      200: {
        description: 'List of featured categories with joined category data',
        schema: z.array(featuredCategoryResponseSchema),
      },
    },
  });

  registerEndpoint(registry, {
    method: 'get',
    path: '/api/v1/featured-categories/{id}',
    summary: 'Get featured category by ID',
    tags: ['Featured Categories'],
    pathParams: featuredCategoryIdParamSchema,
    responses: {
      200: { description: 'Featured category found', schema: featuredCategoryResponseSchema },
      404: { description: 'Featured category not found', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'post',
    path: '/api/v1/featured-categories',
    summary: 'Add a category to featured',
    description: 'Requires admin role',
    tags: ['Featured Categories'],
    security: [{ bearerAuth: [] }],
    body: z.object({
      category_id: z.string().uuid(),
      sort_order: z.number().int().min(0).optional(),
    }),
    responses: {
      201: { description: 'Category added to featured', schema: featuredCategoryResponseSchema },
      400: { description: 'Invalid category ID', schema: errorResponseSchema },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
      403: { description: 'Insufficient permissions (admin role required)', schema: errorResponseSchema },
      409: { description: 'Category already featured', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'put',
    path: '/api/v1/featured-categories/reorder',
    summary: 'Bulk reorder featured categories',
    description: 'Requires admin role',
    tags: ['Featured Categories'],
    security: [{ bearerAuth: [] }],
    body: z.object({
      items: z.array(
        z.object({
          id: z.string().uuid(),
          sort_order: z.number().int().min(0),
        })
      ).min(1),
    }),
    responses: {
      200: { description: 'Featured categories reordered', schema: z.array(featuredCategoryResponseSchema) },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
      403: { description: 'Insufficient permissions (admin role required)', schema: errorResponseSchema },
      404: { description: 'One or more featured category IDs not found', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'put',
    path: '/api/v1/featured-categories/{id}',
    summary: 'Update featured category sort order',
    description: 'Requires admin role',
    tags: ['Featured Categories'],
    security: [{ bearerAuth: [] }],
    pathParams: featuredCategoryIdParamSchema,
    body: z.object({
      sort_order: z.number().int().min(0),
    }),
    responses: {
      200: { description: 'Featured category updated', schema: featuredCategoryResponseSchema },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
      403: { description: 'Insufficient permissions (admin role required)', schema: errorResponseSchema },
      404: { description: 'Featured category not found', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'delete',
    path: '/api/v1/featured-categories/{id}',
    summary: 'Remove category from featured',
    description: 'Requires admin role',
    tags: ['Featured Categories'],
    security: [{ bearerAuth: [] }],
    pathParams: featuredCategoryIdParamSchema,
    responses: {
      204: { description: 'Category removed from featured' },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
      403: { description: 'Insufficient permissions (admin role required)', schema: errorResponseSchema },
      404: { description: 'Featured category not found', schema: errorResponseSchema },
    },
  });
}
