import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import { authMiddleware } from '../middleware/auth.js';
import { categoriesController } from '../../modules/categories/index.js';
import {
  listCategoriesQuerySchema,
  createCategorySchema,
  updateCategorySchema,
  uuidParamSchema,
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
 * POST /api/v1/categories
 * Create a new category.
 * Protected endpoint.
 */
router.post(
  '/',
  authMiddleware,
  validate({ body: createCategorySchema }),
  categoriesController.create
);

/**
 * PUT /api/v1/categories/:id
 * Update a category.
 * Protected endpoint.
 */
router.put(
  '/:id',
  authMiddleware,
  validate({ params: uuidParamSchema, body: updateCategorySchema }),
  categoriesController.update
);

/**
 * DELETE /api/v1/categories/:id
 * Delete a category.
 * Protected endpoint.
 */
router.delete(
  '/:id',
  authMiddleware,
  validate({ params: uuidParamSchema }),
  categoriesController.delete
);

export const categoriesRoutes = router;
