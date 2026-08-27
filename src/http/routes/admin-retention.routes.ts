import { Router } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { requireRole } from '../middleware/require-role.js';
import { validate } from '../middleware/validate.js';
import {
  getReactivationJourneyDashboard,
  pauseReactivationJourney,
} from '../../modules/retention-email/retention-journey.service.js';

const router = Router();
router.use(authMiddleware, requireRole('admin'));

router.get('/reactivation', async (_req, res) => {
  const dashboard = await getReactivationJourneyDashboard();
  if (!dashboard) {
    res.status(404).json({ error: 'Reactivation journey is not installed' });
    return;
  }
  res.json(dashboard);
});

router.post(
  '/reactivation/pause',
  validate({ body: z.object({ confirmation: z.literal('PAUSE') }) }),
  async (req, res) => {
    const config = await pauseReactivationJourney(req.user!.id);
    if (!config) {
      res.status(409).json({ error: 'Journey is already paused or has not launched' });
      return;
    }
    res.json({ config });
  },
);

export const adminRetentionRoutes = router;
