import { Router } from 'express';
import { validate } from '../middleware/index.js';
import { opsController } from '../../modules/ops/ops.controller.js';
import { clueGuessQuerySchema, dailyReportEmailSchema } from '../../modules/ops/ops.schemas.js';

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

/**
 * GET /api/v1/internal/ops/clue-guesses
 * Recent free-text clue guess evaluations for the "correct answers marked
 * WRONG" root-cause session. Requires questionId, userId or matchId.
 * Auth: same `x-ops-report-token` shared secret as the report relay.
 */
router.get(
  '/clue-guesses',
  validate({ query: clueGuessQuerySchema }),
  opsController.listClueGuesses,
);

export const opsRoutes = router;
