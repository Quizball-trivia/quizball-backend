import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import { authMiddleware } from '../middleware/auth.js';
import { requireRole } from '../middleware/require-role.js';
import {
  clueCardIdParamSchema,
  bulkUpdateStatusRequestSchema,
  importCommitRequestSchema,
  importPreviewRequestSchema,
  playerClueCardsController,
  updateStatusRequestSchema,
} from '../../modules/auction/index.js';

const router = Router();

router.use(authMiddleware, requireRole('admin'));

router.post(
  '/import/preview',
  validate({ body: importPreviewRequestSchema }),
  playerClueCardsController.previewImport
);

router.post(
  '/import/commit',
  validate({ body: importCommitRequestSchema }),
  playerClueCardsController.commitImport
);

router.patch(
  '/status/bulk',
  validate({ body: bulkUpdateStatusRequestSchema }),
  playerClueCardsController.bulkUpdateStatus
);

router.patch(
  '/:id/status',
  validate({ params: clueCardIdParamSchema, body: updateStatusRequestSchema }),
  playerClueCardsController.updateStatus
);

export const adminPlayerClueCardsRoutes = router;
