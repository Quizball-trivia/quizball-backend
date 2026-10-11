import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { bucketIp } from '../../core/ip-bucket.js';
import { resolveTrustedClientIp } from '../client-ip.js';
import { footballGridSoloController } from '../../modules/football-grid/football-grid-solo.controller.js';
import {
  footballGridSoloAnswerSchema,
  footballGridSoloBoardSchema,
  footballGridSoloOptionsSchema,
} from '../../modules/football-grid/football-grid-solo.schemas.js';
import { authMiddleware, optionalAuthMiddleware } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { footballGridLeaderboardController } from '../../modules/football-grid/football-grid-leaderboard.controller.js';
import { footballGridTypeaheadController } from '../../modules/football-grid/football-grid-typeahead.controller.js';
import { footballGridPackPreviewController } from '../../modules/football-grid/football-grid-pack-preview.controller.js';
import {
  footballGridLeaderboardQuerySchema,
  footballGridUserRankQuerySchema,
} from '../../modules/football-grid/football-grid-leaderboard.schemas.js';

const router = Router();

// Per-process burst limits by address: these routes need no account.
const byAddress = (max: number) => rateLimit({
  windowMs: 60_000,
  max,
  keyGenerator: (req) => bucketIp(resolveTrustedClientIp(req)),
  standardHeaders: true,
  legacyHeaders: false,
  message: { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests, please try again later', details: null, request_id: null },
});

// Same-phone play: the two players keep the game on their device, the server deals boards and judges answers.
router.post('/solo/board', byAddress(20), validate({ body: footballGridSoloBoardSchema }), footballGridSoloController.dealBoard);
router.post('/solo/answer', byAddress(90), validate({ body: footballGridSoloAnswerSchema }), footballGridSoloController.answer);
router.post('/solo/options', byAddress(60), validate({ body: footballGridSoloOptionsSchema }), footballGridSoloController.options);

// Footballer names only, the same list for everyone: a guest needs suggestions as much as a member does.
router.get('/typeahead', byAddress(30), footballGridTypeaheadController.getPlayers);

// Readable without an account (signed-out visitors browse the board); the country scope needs a session.
router.get(
  '/leaderboard',
  optionalAuthMiddleware,
  validate({ query: footballGridLeaderboardQuerySchema }),
  footballGridLeaderboardController.getLeaderboard,
);

router.use(authMiddleware);

router.get(
  '/leaderboard/me',
  validate({ query: footballGridUserRankQuerySchema }),
  footballGridLeaderboardController.getUserRank,
);

router.get(
  '/pack-preview',
  footballGridPackPreviewController.getPreview,
);

export const footballGridRoutes = router;
