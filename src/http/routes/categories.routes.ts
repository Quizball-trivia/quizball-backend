import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import { authMiddleware } from '../middleware/auth.js';
import { requireRole } from '../middleware/require-role.js';
import { categoriesController } from '../../modules/categories/index.js';
import {
  listCategoriesQuerySchema,
  createCategorySchema,
  updateCategorySchema,
  uuidParamSchema,
  deleteCategoryQuerySchema,
} from '../../modules/categories/index.js';

const router = Router();

/**
 * GET /api/v1/categories
 * List all categories with optional filters.
 * Public endpoint.
 */
router.get(
  '/',
  validate({ query: listCategoriesQuerySchema }),
  categoriesController.list
);

/**
 * GET /api/v1/categories/:id
 * Get a single category by ID.
 * Public endpoint.
 */
router.get(
  '/:id',
  validate({ params: uuidParamSchema }),
  categoriesController.getById
);

/**
 * GET /api/v1/categories/:id/dependencies
 * Get category dependencies (children, questions, featured status).
 * Public endpoint.
 */
router.get(
  '/:id/dependencies',
  validate({ params: uuidParamSchema }),
  categoriesController.getDependencies
);

/**
 * POST /api/v1/categories
 * Create a new category.
 * Protected endpoint - requires admin role.
 */
router.post(
  '/',
  authMiddleware,
  requireRole('admin'),
  validate({ body: createCategorySchema }),
  categoriesController.create
);

/**
 * PUT /api/v1/categories/:id
 * Update a category.
 * Protected endpoint - requires admin role.
 */
router.put(
  '/:id',
  authMiddleware,
  requireRole('admin'),
  validate({ params: uuidParamSchema, body: updateCategorySchema }),
  categoriesController.update
);

/**
 * DELETE /api/v1/categories/:id
 * Delete a category.
 * Protected endpoint - requires admin role.
 * Query params: cascade=true to delete associated questions.
 */
router.delete(
  '/:id',
  authMiddleware,
  requireRole('admin'),
  validate({ params: uuidParamSchema, query: deleteCategoryQuerySchema }),
  categoriesController.delete
);

export const categoriesRoutes = router;
