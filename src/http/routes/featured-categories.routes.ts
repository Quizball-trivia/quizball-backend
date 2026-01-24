import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import { authMiddleware } from '../middleware/auth.js';
import { requireRole } from '../middleware/require-role.js';
import { featuredCategoriesController } from '../../modules/featured-categories/index.js';
import {
  createFeaturedCategorySchema,
  updateFeaturedCategorySchema,
  reorderFeaturedCategoriesSchema,
  uuidParamSchema,
} from '../../modules/featured-categories/index.js';

const router = Router();

/**
 * GET /api/v1/featured-categories
 * List all featured categories with joined category data.
 * Public endpoint.
 */
router.get('/', featuredCategoriesController.list);

/**
 * GET /api/v1/featured-categories/:id
 * Get a single featured category by ID.
 * Public endpoint.
 */
router.get(
  '/:id',
  validate({ params: uuidParamSchema }),
  featuredCategoriesController.getById
);

/**
 * POST /api/v1/featured-categories
 * Add a category to featured.
 * Protected endpoint - requires admin role.
 */
router.post(
  '/',
  authMiddleware,
  requireRole('admin'),
  validate({ body: createFeaturedCategorySchema }),
  featuredCategoriesController.create
);

/**
 * PUT /api/v1/featured-categories/reorder
 * Bulk reorder featured categories.
 * Protected endpoint - requires admin role.
 * NOTE: This route must be defined before /:id to avoid conflict.
 */
router.put(
  '/reorder',
  authMiddleware,
  requireRole('admin'),
  validate({ body: reorderFeaturedCategoriesSchema }),
  featuredCategoriesController.reorder
);

/**
 * PUT /api/v1/featured-categories/:id
 * Update a featured category's sort_order.
 * Protected endpoint - requires admin role.
 */
router.put(
  '/:id',
  authMiddleware,
  requireRole('admin'),
  validate({ params: uuidParamSchema, body: updateFeaturedCategorySchema }),
  featuredCategoriesController.update
);

/**
 * DELETE /api/v1/featured-categories/:id
 * Remove a category from featured.
 * Protected endpoint - requires admin role.
 */
router.delete(
  '/:id',
  authMiddleware,
  requireRole('admin'),
  validate({ params: uuidParamSchema }),
  featuredCategoriesController.delete
);

export const featuredCategoriesRoutes = router;
