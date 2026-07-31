import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { weekendLeagueController } from '../../modules/weekend-league/index.js';

const router = Router();

router.use(authMiddleware);

router.get('/current', weekendLeagueController.current);
router.get('/qp', weekendLeagueController.qp);
router.post('/enter', weekendLeagueController.enter);
router.post('/checkin', weekendLeagueController.checkin);

export const weekendLeagueRoutes = router;
