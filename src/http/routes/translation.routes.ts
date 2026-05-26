import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import { authMiddleware } from '../middleware/auth.js';
import { requireRole } from '../middleware/require-role.js';
import { translationController, translateRequestSchema } from '../../modules/translation/index.js';

const router = Router();

/**
 * POST /api/v1/translation/translate
 * Generic LLM-backed translation. Admin-only — calls cost provider tokens.
 */
router.post(
  '/translate',
  authMiddleware,
  requireRole('admin'),
  validate({ body: translateRequestSchema }),
  translationController.translate,
);

export const translationRoutes = router;
