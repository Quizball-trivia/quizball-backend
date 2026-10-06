/** /partner/v1/games/{countdown|true-false|pick-em|career-path|higher-lower}: the server-authoritative Freecroco
 *  dailies. Mounted once per game behind partnerPlayerAuth (partner.routes.ts). */

import { Router } from 'express';
import { z } from 'zod';
import { parsePartnerInput } from '../../modules/partners/partner-errors.js';
import { partnerPlayer } from '../../modules/partners/games/kit.js';
import {
  answerItem,
  getOpenPlay,
  getPlay,
  nextItem,
  quitPlay,
  startPlay,
  type PartnerDailyGameId,
} from '../../modules/partners/games/dailies/index.js';

const locale = z.string().regex(/^[a-z]{2}$/).optional();
const playId = z.string().uuid();
const startBody = z.object({ startId: z.string().uuid(), locale });
const answerBody = z.object({ playId, index: z.number().int().min(0).max(20), answer: z.unknown(), locale });
const nextBody = z.object({ playId, index: z.number().int().min(0).max(20), locale });
const playBody = z.object({ playId, locale });
const query = z.object({ playId: playId.optional(), locale });

export function createPartnerDailyGameRouter(gameId: PartnerDailyGameId): Router {
  const router = Router();

  /** The open play (to resume after a reload) or one by id; `{ play: null }` when there is none. */
  router.get('/play', async (req, res) => {
    const partner = partnerPlayer(req);
    const q = parsePartnerInput(query, req.query);
    const lang = q.locale ?? partner.language;
    res.json({ play: q.playId ? await getPlay(partner, gameId, q.playId, lang) : await getOpenPlay(partner, gameId, lang) });
  });

  router.post('/start', async (req, res) => {
    const partner = partnerPlayer(req);
    const body = parsePartnerInput(startBody, req.body);
    res.json({ play: await startPlay(partner, gameId, body.startId, body.locale ?? partner.language) });
  });

  router.post('/answer', async (req, res) => {
    const partner = partnerPlayer(req);
    const body = parsePartnerInput(answerBody, req.body);
    const result = await answerItem(partner, gameId, body, body.locale ?? partner.language);
    res.json({ play: result.view, feedback: result.feedback, late: result.late ?? false });
  });

  router.post('/next', async (req, res) => {
    const partner = partnerPlayer(req);
    const body = parsePartnerInput(nextBody, req.body);
    res.json({ play: await nextItem(partner, gameId, body, body.locale ?? partner.language) });
  });

  router.post('/quit', async (req, res) => {
    const partner = partnerPlayer(req);
    const body = parsePartnerInput(playBody, req.body);
    res.json({ play: await quitPlay(partner, gameId, body.playId, body.locale ?? partner.language) });
  });

  return router;
}
