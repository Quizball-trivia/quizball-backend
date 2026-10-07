import { Router, type RequestHandler } from 'express';
import { requirePartnerConfig } from '../../modules/partners/partner-machine-auth.js';
import { parsePartnerInput, partnerErrorHandler } from '../../modules/partners/partner-errors.js';
import { partnerStaffAuth } from '../../modules/partners/partner-staff-auth.js';
import {
  calendarBodySchema,
  calendarQuerySchema,
  gamesConfigBodySchema,
  getCalendar,
  getGamesConfig,
  getPlayerView,
  getRankedPoints,
  playerParamSchema,
  putCalendar,
  putGamesConfig,
  putRankedPoints,
  rankedPointsBodySchema,
} from '../../modules/partners/partner-admin.service.js';
import { getPartnerStats, statsQuerySchema } from '../../modules/partners/partner-stats.service.js';
import {
  addStaff,
  listStaff,
  removeStaff,
  staffAddBodySchema,
  staffParamSchema,
  staffPatchBodySchema,
  updateStaffRole,
} from '../../modules/partners/partner-staff.service.js';

const noStore: RequestHandler = (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
};

/** /partner-admin/v1/partners/freecroco (internal API §2). Routes carry their own auth, so paths this router does not
 *  define (the delivery stream's) fall through untouched. */
const router = Router();

router.get('/games', noStore, partnerStaffAuth('read'), async (_req, res) => {
  res.json(await getGamesConfig(requirePartnerConfig()));
});

router.put('/games', noStore, partnerStaffAuth('write'), async (req, res) => {
  const body = parsePartnerInput(gamesConfigBodySchema, req.body);
  res.json(await putGamesConfig(requirePartnerConfig(), req.partnerStaff!.userId, body));
});

router.get('/calendar', noStore, partnerStaffAuth('read'), async (req, res) => {
  const query = parsePartnerInput(calendarQuerySchema, req.query);
  res.json(await getCalendar(requirePartnerConfig(), query));
});

router.put('/calendar', noStore, partnerStaffAuth('write'), async (req, res) => {
  const body = parsePartnerInput(calendarBodySchema, req.body);
  res.json(await putCalendar(requirePartnerConfig(), req.partnerStaff!.userId, body));
});

router.get('/ranked-points', noStore, partnerStaffAuth('read'), async (_req, res) => {
  res.json(await getRankedPoints(requirePartnerConfig()));
});

// Quizball admins only: the table is what Freecroco is sent per match (contract §7.1), agreed between the two
// companies, so a partner editor cannot change it from the CMS.
router.put('/ranked-points', noStore, partnerStaffAuth('admin'), async (req, res) => {
  const body = parsePartnerInput(rankedPointsBodySchema, req.body);
  res.json(await putRankedPoints(requirePartnerConfig(), req.partnerStaff!.userId, body));
});

router.get('/players/:playerId', noStore, partnerStaffAuth('read'), async (req, res) => {
  const { playerId } = parsePartnerInput(playerParamSchema, req.params);
  res.json(await getPlayerView(requirePartnerConfig(), playerId));
});

router.get('/stats', noStore, partnerStaffAuth('read'), async (req, res) => {
  const query = parsePartnerInput(statsQuerySchema, req.query);
  res.json(await getPartnerStats(requirePartnerConfig(), query));
});

// Staff accounts: Quizball admins only. A partner editor cannot grant access to anyone.
router.get('/staff', noStore, partnerStaffAuth('admin'), async (_req, res) => {
  res.json(await listStaff(requirePartnerConfig()));
});

router.post('/staff', noStore, partnerStaffAuth('admin'), async (req, res) => {
  const body = parsePartnerInput(staffAddBodySchema, req.body);
  res.status(201).json(await addStaff(requirePartnerConfig(), req.partnerStaff!.userId, body));
});

router.patch('/staff/:userId', noStore, partnerStaffAuth('admin'), async (req, res) => {
  const { userId } = parsePartnerInput(staffParamSchema, req.params);
  const { role } = parsePartnerInput(staffPatchBodySchema, req.body);
  res.json(await updateStaffRole(requirePartnerConfig(), req.partnerStaff!.userId, userId, role));
});

router.delete('/staff/:userId', noStore, partnerStaffAuth('admin'), async (req, res) => {
  const { userId } = parsePartnerInput(staffParamSchema, req.params);
  await removeStaff(requirePartnerConfig(), req.partnerStaff!.userId, userId);
  res.status(204).end();
});

router.use(partnerErrorHandler);

export const partnerAdminRoutes = router;
