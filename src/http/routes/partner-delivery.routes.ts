import { Router, type Request, type RequestHandler, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { logger } from '../../core/logger.js';
import {
  DELIVERIES_MAX_LIMIT,
  SCORE_EVENT_ID,
  decodeDeliveriesCursor,
  listDeliveryAttempts,
  listPartnerDeliveries,
  resendPartnerScoreEvent,
} from '../../modules/partners/delivery/deliveries.js';
import { PARTNER_GAME_IDS } from '../../modules/partners/delivery/score-events.js';
import { wakePartnerDelivery } from '../../modules/partners/delivery/worker.js';

const PARTNER = 'freecroco';
const BASE = `/partner-admin/v1/partners/${PARTNER}/deliveries`;

const tbilisiDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().startsWith(d));

const listQuerySchema = z.object({
  status: z.enum(['pending', 'sent', 'dead']).optional(),
  gameId: z.enum(PARTNER_GAME_IDS).optional(),
  playerId: z.string().min(1).max(64).optional(),
  from: tbilisiDay.optional(),
  to: tbilisiDay.optional(),
  cursor: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(DELIVERIES_MAX_LIMIT).optional(),
}).strict();

const resendBodySchema = z.object({ reason: z.string().trim().max(200).optional() }).strict();

function fail(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

const invalid = (res: Response) => fail(res, 400, 'invalid_request', 'The request is not valid');

export interface PartnerDeliveryAdminRouterOptions {
  /** Runs after `authMw` on the resend only: Quizball admins (internal API §2). */
  resendGuard?: RequestHandler;
  /** The audited actor (a users.id); defaults to the authenticated Quizball user. */
  actorId?: (req: Request) => string | null | undefined;
  /** Per actor, per replica. */
  resendLimit?: { windowMs: number; max: number };
}

const quizballAdminOnly: RequestHandler = (req, res, next) => {
  if (req.user?.role !== 'admin') {
    fail(res, 403, 'forbidden', 'Only Quizball admins can resend score events');
    return;
  }
  next();
};

/**
 * Freecroco deliveries in our CMS (internal API §2). Paths are absolute: mount at the API root
 * (`router.use(createPartnerDeliveryAdminRouter(auth))`). `authMw` must admit Quizball admins and this partner's
 * staff only; nothing here is reachable without it.
 */
export function createPartnerDeliveryAdminRouter(
  authMw: RequestHandler | RequestHandler[],
  options: PartnerDeliveryAdminRouterOptions = {},
): Router {
  const auth = Array.isArray(authMw) ? authMw : [authMw];
  if (!auth.length) throw new Error('createPartnerDeliveryAdminRouter needs an auth middleware');
  const actorOf = options.actorId ?? ((req: Request) => req.user?.id);
  const resendLimiter = rateLimit({
    windowMs: options.resendLimit?.windowMs ?? 60 * 60 * 1000,
    max: options.resendLimit?.max ?? 60,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `partner-resend:${actorOf(req) ?? 'unknown'}`,
    handler: (_req, res) => fail(res, 429, 'rate_limited', 'Too many resends; try again later'),
  });

  const router = Router();
  router.use(BASE, ...auth, (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.get(BASE, async (req, res) => {
    const q = listQuerySchema.safeParse(req.query);
    if (!q.success) return invalid(res);
    if (q.data.cursor && !decodeDeliveriesCursor(q.data.cursor)) return invalid(res);
    if (q.data.from && q.data.to && q.data.from > q.data.to) return invalid(res);
    const page = await listPartnerDeliveries({
      partnerSlug: PARTNER,
      status: q.data.status,
      gameId: q.data.gameId,
      playerId: q.data.playerId,
      from: q.data.from,
      to: q.data.to,
      cursor: q.data.cursor,
      limit: q.data.limit,
    });
    res.json(page);
  });

  router.get(`${BASE}/:eventId/attempts`, async (req, res) => {
    const eventId = req.params.eventId ?? '';
    if (!SCORE_EVENT_ID.test(eventId)) return fail(res, 404, 'not_found', 'No such event');
    const attempts = await listDeliveryAttempts(PARTNER, eventId);
    if (!attempts) return fail(res, 404, 'not_found', 'No such event');
    res.json({ items: attempts });
  });

  router.post(
    `${BASE}/:eventId/resend`,
    options.resendGuard ?? quizballAdminOnly,
    resendLimiter,
    async (req, res) => {
      const eventId = req.params.eventId ?? '';
      if (!SCORE_EVENT_ID.test(eventId)) return fail(res, 404, 'not_found', 'No such event');
      const body = resendBodySchema.safeParse(req.body ?? {});
      if (!body.success) return invalid(res);
      const actorId = actorOf(req);
      if (!actorId) return fail(res, 403, 'forbidden', 'No audited actor for this request');
      const result = await resendPartnerScoreEvent({ partnerSlug: PARTNER, eventId, actorId, reason: body.data.reason });
      if (!result.ok) return fail(res, result.code === 'not_found' ? 404 : 409, result.code, result.message);
      logger.info({ eventId, actorId }, 'Partner score event resent by hand');
      wakePartnerDelivery();
      res.status(202).json({ eventId: result.eventId, status: result.status });
    },
  );

  return router;
}
