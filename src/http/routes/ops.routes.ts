import { Router } from 'express';
import { validate } from '../middleware/index.js';
import { opsController } from '../../modules/ops/ops.controller.js';
import { dailyReportEmailSchema } from '../../modules/ops/ops.schemas.js';

const router = Router();

/**
 * POST /api/v1/internal/ops/daily-report
 * Relays the scheduled morning ops/health report to Resend.
 * Auth: shared secret in the `x-ops-report-token` header (not user JWT) — this
 * is a machine-to-machine endpoint called by the scheduled report agent.
 */
router.post(
  '/daily-report',
  validate({ body: dailyReportEmailSchema }),
  opsController.sendDailyReport,
);

export const opsRoutes = router;
