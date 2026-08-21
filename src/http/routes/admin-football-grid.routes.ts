import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { requireRole } from '../middleware/require-role.js';
import { validate } from '../middleware/validate.js';
import {
  footballGridAdminCoinParamsSchema,
  footballGridAdminController,
  footballGridAdminMatchParamsSchema,
  footballGridAdminReasonSchema,
  footballGridAdminQuarantineSchema,
  footballGridAdminQuarantinesQuerySchema,
  footballGridAdminReportDecisionSchema,
  footballGridAdminReportParamsSchema,
  footballGridAdminReportsQuerySchema,
} from '../../modules/football-grid/index.js';

const router = Router();
router.use(authMiddleware, requireRole('admin'));
router.get('/matches/:matchId/rewards', validate({ params: footballGridAdminMatchParamsSchema }), footballGridAdminController.inspectRewards);
router.post('/coin-events/:eventId/release', validate({ params: footballGridAdminCoinParamsSchema, body: footballGridAdminReasonSchema }), footballGridAdminController.releaseHeldCoin);
router.post('/coin-events/:eventId/reverse', validate({ params: footballGridAdminCoinParamsSchema, body: footballGridAdminReasonSchema }), footballGridAdminController.reverseCoin);
router.get('/missing-answer-reports', validate({ query: footballGridAdminReportsQuerySchema }), footballGridAdminController.listReports);
router.patch('/missing-answer-reports/:reportId', validate({ params: footballGridAdminReportParamsSchema, body: footballGridAdminReportDecisionSchema }), footballGridAdminController.decideReport);
router.get('/content/quarantines', validate({ query: footballGridAdminQuarantinesQuerySchema }), footballGridAdminController.listQuarantines);
router.post('/content/quarantines', validate({ body: footballGridAdminQuarantineSchema }), footballGridAdminController.quarantineContent);

export const adminFootballGridRoutes = router;
