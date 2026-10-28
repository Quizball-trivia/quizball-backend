import { Router } from 'express';
import { z } from 'zod';
import { parsePartnerInput } from '../../modules/partners/partner-errors.js';
import { partnerPlayer } from '../../modules/partners/games/kit.js';
import { partnerFakeFactService } from '../../modules/partners/games/fake-fact/fake-fact.service.js';

const startSchema = z.object({ client_nonce: z.string().trim().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/) });
const answerSchema = z.object({ card: z.union([z.literal(0), z.literal(1)]), option: z.number().int().min(0).max(4) });
const playParams = z.object({ playId: z.string().uuid() });

/** /partner/v1/games/fake-fact (mounted behind partnerPlayerAuth). */
export const partnerFakeFactRouter = Router();

partnerFakeFactRouter.get('/current', async (req, res) => {
  res.json(await partnerFakeFactService.current(partnerPlayer(req)));
});

partnerFakeFactRouter.post('/start', async (req, res) => {
  const { client_nonce } = parsePartnerInput(startSchema, req.body);
  res.status(201).json(await partnerFakeFactService.start(partnerPlayer(req), client_nonce));
});

partnerFakeFactRouter.get('/plays/:playId', async (req, res) => {
  const { playId } = parsePartnerInput(playParams, req.params);
  res.json(await partnerFakeFactService.get(partnerPlayer(req), playId));
});

partnerFakeFactRouter.post('/plays/:playId/answer', async (req, res) => {
  const { playId } = parsePartnerInput(playParams, req.params);
  res.json(await partnerFakeFactService.answer(partnerPlayer(req), playId, parsePartnerInput(answerSchema, req.body)));
});

partnerFakeFactRouter.post('/plays/:playId/next', async (req, res) => {
  const { playId } = parsePartnerInput(playParams, req.params);
  res.json(await partnerFakeFactService.next(partnerPlayer(req), playId));
});
