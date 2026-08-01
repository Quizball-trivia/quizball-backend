import { Router } from 'express';
import { z } from 'zod';
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
  syncQuestionsToStagingSchema,
} from '../../modules/questions/index.js';
import {
  imageMcqGeneratePreviewSchema,
  imageMcqSaveDraftsSchema,
} from '../../modules/questions/image-mcq.schemas.js';

const router = Router();

// Questions contain answer payloads and must never be anonymously accessible.
// Read routes remain available to authenticated players for the existing solo
// game flow; the controller restricts those callers to published questions.
// All CMS/write routes are explicitly admin-only below.
router.use(authMiddleware);

/**
 * GET /api/v1/questions
 * List questions with pagination and filters.
 * Protected endpoint. Players can only list published questions; admins can
 * use the complete CMS filter/search surface.
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
  requireRole('admin'),
  validate({ query: findDuplicatesQuerySchema }),
  questionsController.findDuplicates
);

/**
 * GET /api/v1/questions/:id
 * Get a single question by ID with payload.
 * Protected endpoint. Players can only retrieve published questions.
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
  requireRole('admin'),
  validate({ body: checkDuplicatesSchema }),
  questionsController.checkDuplicates
);

/**
 * POST /api/v1/questions/sync-staging
 * Copy selected questions from the current DB into the configured staging DB.
 */
router.post(
  '/sync-staging',
  requireRole('admin'),
  validate({ body: syncQuestionsToStagingSchema }),
  questionsController.syncQuestionsToStaging
);

/**
 * POST /api/v1/questions/image-mcq/generate-preview
 * Generate image-backed MCQ review cards. No questions or images are saved yet.
 */
router.post(
  '/image-mcq/generate-preview',
  requireRole('admin'),
  validate({ body: imageMcqGeneratePreviewSchema }),
  questionsController.generateImageMcqPreview
);

/**
 * POST /api/v1/questions/image-mcq/generate-preview-stream
 * Generate image-backed MCQ review cards and stream progress. No questions or images are saved yet.
 */
router.post(
  '/image-mcq/generate-preview-stream',
  requireRole('admin'),
  validate({ body: imageMcqGeneratePreviewSchema }),
  questionsController.generateImageMcqPreviewStream
);

/**
 * POST /api/v1/questions/image-mcq/save-drafts
 * Upload accepted generated images and save accepted cards as draft questions.
 */
router.post(
  '/image-mcq/save-drafts',
  requireRole('admin'),
  validate({ body: imageMcqSaveDraftsSchema }),
  questionsController.saveImageMcqDrafts
);

/**
 * POST /api/v1/questions/translate/backfill
 * Translate all untranslated questions from English to Georgian.
 * Protected endpoint - requires admin role.
 */
/**
 * POST /api/v1/questions/translate/redo-drafts
 * Re-translate all DRAFT questions from scratch (overwrites their Georgian).
 */
router.post(
  '/translate/redo-drafts',
  requireRole('admin'),
  validate({ body: z.object({}).strict().optional() }),
  questionsController.translateRedoDrafts
);

router.post(
  '/translate/backfill',
  requireRole('admin'),
  validate({ body: z.object({ scope: z.enum(['all', 'agents']).optional() }).strict().optional() }),
  questionsController.translateBackfill
);

/**
 * GET /api/v1/questions/translate/status
 * Check translation progress.
 * Protected endpoint - requires admin role.
 */
router.get(
  '/translate/status',
  requireRole('admin'),
  validate({ query: z.object({ cache_bust: z.coerce.number().optional(), scope: z.enum(['all', 'agents']).optional() }).strict() }),
  questionsController.translateStatus
);

/**
 * POST /api/v1/questions
 * Create a new question with optional payload.
 * Protected endpoint - requires admin role.
 */
router.post(
  '/',
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
  requireRole('admin'),
  validate({ params: uuidParamSchema, body: updateStatusSchema }),
  questionsController.updateStatus
);

export const questionsRoutes = router;
