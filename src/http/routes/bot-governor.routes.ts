import { Router } from 'express';
import { validate } from '../middleware/index.js';
import { governorController } from '../../modules/bots/governor/governor.controller.js';
import { governorTelemetryQuerySchema } from '../../modules/bots/governor/governor.schemas.js';

const router = Router();

/**
 * GET /api/v1/internal/bots/governor/telemetry?days=14
 * Per-day persistent-bot win/loss vs humans + current governor offset summary.
 * Auth: shared secret in the `x-ops-report-token` header (machine/operator
 * tooling, same scheme as the ops daily report).
 */
router.get(
  '/telemetry',
  validate({ query: governorTelemetryQuerySchema }),
  governorController.getTelemetry,
);

export const botGovernorRoutes = router;
