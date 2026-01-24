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
