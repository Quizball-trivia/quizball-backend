import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import { authMiddleware } from '../middleware/auth.js';
import { requireRole } from '../middleware/require-role.js';
import { questionsController } from '../../modules/questions/index.js';
import {
  listQuestionsQuerySchema,
  createQuestionSchema,
  updateQuestionSchema,
  updateStatusSchema,
  uuidParamSchema,
  bulkCreateQuestionsSchema,
  findDuplicatesQuerySchema,
  checkDuplicatesSchema,
} from '../../modules/questions/index.js';

const router = Router();

/**
 * GET /api/v1/questions
 * List questions with pagination and filters.
 * Public endpoint.
 */
router.get(
  '/',
  validate({ query: listQuestionsQuerySchema }),
  questionsController.list
);

/**
 * GET /api/v1/questions/duplicates
 * Find duplicate questions based on identical prompts.
 * Protected endpoint - requires admin role.
 * NOTE: Must be before GET /:id to avoid path conflict.
 */
router.get(
  '/duplicates',
  authMiddleware,
  requireRole('admin'),
  validate({ query: findDuplicatesQuerySchema }),
  questionsController.findDuplicates
);

/**
 * GET /api/v1/questions/:id
 * Get a single question by ID with payload.
 * Public endpoint.
 */
router.get(
  '/:id',
  validate({ params: uuidParamSchema }),
  questionsController.getById
);

/**
 * POST /api/v1/questions/bulk
 * Bulk create multiple questions in a single category.
 * Protected endpoint - requires admin role.
 * NOTE: /bulk is distinct from / and does not conflict.
 */
router.post(
  '/bulk',
  authMiddleware,
  requireRole('admin'),
  validate({ body: bulkCreateQuestionsSchema }),
  questionsController.bulkCreate
);

/**
 * POST /api/v1/questions/check-duplicates
 * Check if prompts already exist in database (for bulk upload preview).
 * Protected endpoint - requires admin role.
 */
router.post(
  '/check-duplicates',
  authMiddleware,
  requireRole('admin'),
  validate({ body: checkDuplicatesSchema }),
  questionsController.checkDuplicates
);

/**
 * POST /api/v1/questions/translate/backfill
 * Translate all untranslated questions from English to Georgian.
 * Protected endpoint - requires admin role.
 */
router.post(
  '/translate/backfill',
  authMiddleware,
  requireRole('admin'),
  questionsController.translateBackfill
);

/**
 * GET /api/v1/questions/translate/status
 * Check translation progress.
 * Protected endpoint - requires admin role.
 */
router.get(
  '/translate/status',
  authMiddleware,
  requireRole('admin'),
  questionsController.translateStatus
);

/**
 * POST /api/v1/questions
 * Create a new question with optional payload.
 * Protected endpoint - requires admin role.
 */
router.post(
  '/',
  authMiddleware,
  requireRole('admin'),
  validate({ body: createQuestionSchema }),
  questionsController.create
);

/**
 * PUT /api/v1/questions/:id
 * Update a question with optional payload update.
 * Protected endpoint - requires admin role.
 */
router.put(
  '/:id',
  authMiddleware,
  requireRole('admin'),
  validate({ params: uuidParamSchema, body: updateQuestionSchema }),
  questionsController.update
);

/**
 * DELETE /api/v1/questions/:id
 * Delete a question.
 * Protected endpoint - requires admin role.
 */
router.delete(
  '/:id',
  authMiddleware,
  requireRole('admin'),
  validate({ params: uuidParamSchema }),
  questionsController.delete
);

/**
 * PATCH /api/v1/questions/:id/status
 * Update question status only.
 * Protected endpoint - requires admin role.
 */
router.patch(
  '/:id/status',
  authMiddleware,
  requireRole('admin'),
  validate({ params: uuidParamSchema, body: updateStatusSchema }),
  questionsController.updateStatus
);

export const questionsRoutes = router;
