import { Router } from 'express';
import { validate } from '../middleware/index.js';
import { tuningController } from '../../modules/bots/tuning/tuning.controller.js';
import {
  updateBotTuningBodySchema,
  rosterOverviewQuerySchema,
  freezeBotBodySchema,
  botUserIdParamsSchema,
  zeroOffsetsBodySchema,
  patchBotBodySchema,
} from '../../modules/bots/tuning/tuning.schemas.js';

const router = Router();

/**
 * PR10 CMS live-tuning surface. All routes auth via the ops shared secret in
 * `x-ops-report-token` (same scheme as the governor telemetry endpoint).
 *
 * GET  /api/v1/internal/bots/tuning
 * PUT  /api/v1/internal/bots/tuning
 * GET   /api/v1/internal/bots/tuning/roster
 * PATCH /api/v1/internal/bots/tuning/roster/:botUserId
 * GET   /api/v1/internal/bots/tuning/roster/:botUserId/history
 * POST  /api/v1/internal/bots/tuning/roster/:botUserId/freeze
 * POST  /api/v1/internal/bots/tuning/governor/zero-offsets
 */
router.get('/', tuningController.getTuning);

router.put('/', validate({ body: updateBotTuningBodySchema }), tuningController.updateTuning);

router.get(
  '/roster',
  validate({ query: rosterOverviewQuerySchema }),
  tuningController.getRoster,
);

router.patch(
  '/roster/:botUserId',
  validate({ params: botUserIdParamsSchema, body: patchBotBodySchema }),
  tuningController.patchBot,
);

router.get(
  '/roster/:botUserId/history',
  validate({ params: botUserIdParamsSchema }),
  tuningController.getBotHistory,
);

router.post(
  '/roster/:botUserId/freeze',
  validate({ params: botUserIdParamsSchema, body: freezeBotBodySchema }),
  tuningController.setFreeze,
);

router.post(
  '/governor/zero-offsets',
  validate({ body: zeroOffsetsBodySchema }),
  tuningController.zeroOffsets,
);

export const botTuningRoutes = router;
