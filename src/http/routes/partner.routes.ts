import { createHash } from 'node:crypto';
import { Router, type Request, type RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import { resolveTrustedClientIp } from '../client-ip.js';
import {
  parsePartnerInput,
  partnerErrorHandler,
  PartnerError,
  sendPartnerError,
} from '../../modules/partners/partner-errors.js';
import { partnerMachineAuth, requirePartnerConfig } from '../../modules/partners/partner-machine-auth.js';
import { partnerPlayerAuth } from '../../modules/partners/partner-player-auth.js';
import { meGames } from '../../modules/partners/partner-quota.service.js';
import {
  initBodySchema,
  initSession,
  PARTNER_IDENTIFIER,
  playerStatusBodySchema,
  redeemBodySchema,
  redeemSession,
  refreshSession,
  setPlayerStatus,
} from '../../modules/partners/partner-sessions.service.js';
import { partnerStatus } from '../../modules/partners/partner-status.js';
import { partnerAdminRoutes } from './partner-admin.routes.js';
import { createPartnerDeliveryAdminRouter } from './partner-delivery.routes.js';
import { partnerStaffAuth } from '../../modules/partners/partner-staff-auth.js';
import { listRecentResultsForPlayer } from '../../modules/partners/delivery/index.js';
import { createPartnerDailyGameRouter } from './partner-game-dailies.routes.js';
import { partnerQuizBoardRoutes } from './partner-game-quiz-board.routes.js';
import { partnerRoadToGoalRouter } from './partner-game-road-to-goal.routes.js';
import { partnerTriviaMinesRouter } from './partner-game-trivia-mines.routes.js';
import { partnerGuessTheGoalRouter } from './partner-game-guess-the-goal.routes.js';
import { partnerCardDetectiveRouter } from './partner-game-card-detective.routes.js';
import { partnerGameRankedRoutes } from './partner-game-ranked.routes.js';

const noStore: RequestHandler = (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
};

// The browser exchange is the only unauthenticated partner call; per address, per process.
const redeemLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  keyGenerator: (req) => `redeem:${resolveTrustedClientIp(req) ?? req.ip}`,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => sendPartnerError(res, new PartnerError('rate_limited', undefined, 60)),
});

/** Per session (the bearer token) rather than per address: Georgian carriers put whole audiences behind one IP.
 *  Counted before auth, so a flood with a valid token stops before its database check. */
function bearerOrAddressKey(prefix: string) {
  return (req: Request): string => {
    // Parsed exactly as the auth middlewares do, so spelling variants of one token share a bucket.
    const token = /^Bearer\s+(\S+)$/i.exec(req.get('authorization')?.trim() ?? '')?.[1];
    if (token) return `${prefix}:t:${createHash('sha256').update(token).digest('hex').slice(0, 32)}`;
    return `${prefix}:ip:${resolveTrustedClientIp(req) ?? req.ip}`;
  };
}

function bearerLimiter(prefix: string, max: number): RequestHandler {
  return rateLimit({
    windowMs: 60_000,
    max,
    keyGenerator: bearerOrAddressKey(prefix),
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => sendPartnerError(res, new PartnerError('rate_limited', undefined, 60)),
  });
}

const playerLimiter = bearerLimiter('player', 240);
const staffLimiter = bearerLimiter('staff', 300);

function playerIdParam(raw: string): string {
  if (!PARTNER_IDENTIFIER.test(raw)) throw new PartnerError('invalid_request', 'playerId: invalid');
  return raw;
}

/** /partner/v1: machine (partner's server), browser exchange and player classes, at the API root. */
const v1 = Router();
v1.use(noStore);

v1.post('/sessions/init', ...partnerMachineAuth, async (req, res) => {
  const body = parsePartnerInput(initBodySchema, req.body);
  res.json(await initSession(req.partnerMachine!.config, body));
});

for (const [action, target] of [['block', 'blocked'], ['unblock', 'active']] as const) {
  v1.post(`/players/:playerId/${action}`, ...partnerMachineAuth, async (req, res) => {
    const playerId = playerIdParam(req.params.playerId);
    const body = parsePartnerInput(playerStatusBodySchema, req.body);
    res.json(
      await setPlayerStatus(req.partnerMachine!.config, playerId, target, {
        at: new Date(body.at),
        reason: body.reason?.trim() || null,
      }),
    );
  });
}

v1.get('/status', ...partnerMachineAuth, async (_req, res) => {
  const status = await partnerStatus();
  res.status(status.status === 'down' ? 503 : 200).json(status);
});

v1.post('/sessions/redeem', redeemLimiter, async (req, res) => {
  res.setHeader('Referrer-Policy', 'no-referrer');
  const config = requirePartnerConfig();
  const { token } = parsePartnerInput(redeemBodySchema, req.body);
  res.json(await redeemSession(config, token));
});

v1.use(['/sessions/refresh', '/me', '/games'], playerLimiter);

v1.post('/sessions/refresh', partnerPlayerAuth, async (req, res) => {
  res.json(await refreshSession(requirePartnerConfig(), req.partner!));
});

v1.get('/me/games', partnerPlayerAuth, async (req, res) => {
  res.json(await meGames(req.partner!));
});

v1.get('/me/results', partnerPlayerAuth, async (req, res) => {
  const limit = Number(req.query.limit ?? 20);
  res.json(await listRecentResultsForPlayer(req.partner!, limit));
});

v1.use('/games/countdown', partnerPlayerAuth, createPartnerDailyGameRouter('countdown'));
v1.use('/games/true-false', partnerPlayerAuth, createPartnerDailyGameRouter('true-false'));
v1.use('/games/pick-em', partnerPlayerAuth, createPartnerDailyGameRouter('pick-em'));
v1.use('/games/career-path', partnerPlayerAuth, createPartnerDailyGameRouter('career-path'));
v1.use('/games/higher-lower', partnerPlayerAuth, createPartnerDailyGameRouter('higher-lower'));
v1.use('/games/quiz-board', partnerPlayerAuth, partnerQuizBoardRoutes);
v1.use('/games/road-to-goal', partnerPlayerAuth, partnerRoadToGoalRouter);
v1.use('/games/trivia-mines', partnerPlayerAuth, partnerTriviaMinesRouter);
v1.use('/games/guess-the-goal', partnerPlayerAuth, partnerGuessTheGoalRouter);
v1.use('/games/card-detective', partnerPlayerAuth, partnerCardDetectiveRouter);
v1.use('/games/ranked', partnerPlayerAuth, partnerGameRankedRoutes);

v1.use(partnerErrorHandler);

const router = Router();
router.use('/partner/v1', v1);
router.use('/partner-admin', staffLimiter);
router.use('/partner-admin/v1/partners/freecroco', partnerAdminRoutes);
// Deliveries: staff read; resend stays Quizball-admin only (the router's own guard).
router.use(createPartnerDeliveryAdminRouter(partnerStaffAuth('read'), { actorId: (req) => req.partnerStaff?.userId }));

export const partnerRoutes = router;
