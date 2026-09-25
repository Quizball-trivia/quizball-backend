import { Router } from 'express';
import { authMiddleware, optionalAuthMiddleware } from '../middleware/auth.js';
import { weekendLeagueController } from '../../modules/weekend-league/index.js';

const router = Router();

// Public: the hall of fame is the same cached leaderboard for everyone and the
// handler never reads the caller. Requiring auth made every logged-out visitor
// of the Weekend League page generate a 401 (275 errors / 115 users in 6h,
// 2026-09-25) and see an empty board. Optional auth still populates req.user
// when a session exists.
router.get('/hall-of-fame', optionalAuthMiddleware, weekendLeagueController.hallOfFame);

router.use(authMiddleware);

router.get('/current', weekendLeagueController.current);
router.get('/qp', weekendLeagueController.qp);
router.get('/standings', weekendLeagueController.standings);
router.post('/enter', weekendLeagueController.enter);
router.post('/checkin', weekendLeagueController.checkin);

export const weekendLeagueRoutes = router;
