import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { requireRole } from '../middleware/require-role.js';
import { validate } from '../middleware/validate.js';
import {
  footballGridAdminCoinParamsSchema,
  footballGridAdminController,
  footballGridAdminMatchParamsSchema,
  footballGridAdminPlayerParamsSchema,
  footballGridAdminRenamePlayerSchema,
  footballGridAdminReasonSchema,
  footballGridAdminQuarantineSchema,
  footballGridAdminQuarantinesQuerySchema,
  footballGridAdminReportDecisionSchema,
  footballGridAdminReportProposalSchema,
  footballGridAdminReportParamsSchema,
  footballGridAdminReportsQuerySchema,
  footballGridAdminPlayerSearchSchema,
  footballGridAdminProposalCheckQuerySchema,
} from '../../modules/football-grid/index.js';

const router = Router();
router.use(authMiddleware, requireRole('admin'));
router.get('/matches/:matchId/rewards', validate({ params: footballGridAdminMatchParamsSchema }), footballGridAdminController.inspectRewards);
router.post('/coin-events/:eventId/release', validate({ params: footballGridAdminCoinParamsSchema, body: footballGridAdminReasonSchema }), footballGridAdminController.releaseHeldCoin);
router.post('/coin-events/:eventId/reverse', validate({ params: footballGridAdminCoinParamsSchema, body: footballGridAdminReasonSchema }), footballGridAdminController.reverseCoin);
router.post('/point-events/:eventId/release', validate({ params: footballGridAdminCoinParamsSchema, body: footballGridAdminReasonSchema }), footballGridAdminController.releaseHeldPoints);
router.post('/point-events/:eventId/reverse', validate({ params: footballGridAdminCoinParamsSchema, body: footballGridAdminReasonSchema }), footballGridAdminController.reversePoints);
router.get('/missing-answer-reports', validate({ query: footballGridAdminReportsQuerySchema }), footballGridAdminController.listReports);
router.get('/players/search', validate({ query: footballGridAdminPlayerSearchSchema }), footballGridAdminController.searchPlayers);
router.get('/missing-answer-reports/:reportId/player-check', validate({ params: footballGridAdminReportParamsSchema, query: footballGridAdminProposalCheckQuerySchema }), footballGridAdminController.checkProposedPlayer);
router.put('/missing-answer-reports/:reportId/proposal', validate({ params: footballGridAdminReportParamsSchema, body: footballGridAdminReportProposalSchema }), footballGridAdminController.saveReportProposal);
router.patch('/missing-answer-reports/:reportId', validate({ params: footballGridAdminReportParamsSchema, body: footballGridAdminReportDecisionSchema }), footballGridAdminController.decideReport);
router.get('/content/quarantines', validate({ query: footballGridAdminQuarantinesQuerySchema }), footballGridAdminController.listQuarantines);
router.post('/content/quarantines', validate({ body: footballGridAdminQuarantineSchema }), footballGridAdminController.quarantineContent);
router.post('/players/:playerId/names', validate({ params: footballGridAdminPlayerParamsSchema, body: footballGridAdminRenamePlayerSchema }), footballGridAdminController.renamePlayer);

export const adminFootballGridRoutes = router;
