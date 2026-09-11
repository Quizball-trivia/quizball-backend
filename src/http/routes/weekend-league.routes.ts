import { Router } from 'express';
import { authMiddleware, optionalAuthMiddleware } from '../middleware/auth.js';
import { weekendLeagueController } from '../../modules/weekend-league/index.js';

const router = Router();

// Signed-out visitors can read the league (schedule, counts, standings, hall
// of fame); their own entry state, QP, entering and check-in need a session.
router.get('/current', optionalAuthMiddleware, weekendLeagueController.current);
router.get('/standings', optionalAuthMiddleware, weekendLeagueController.standings);
router.get('/hall-of-fame', optionalAuthMiddleware, weekendLeagueController.hallOfFame);

router.use(authMiddleware);

router.get('/qp', weekendLeagueController.qp);
router.post('/enter', weekendLeagueController.enter);
router.post('/checkin', weekendLeagueController.checkin);

export const weekendLeagueRoutes = router;
