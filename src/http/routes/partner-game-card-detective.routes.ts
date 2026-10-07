import { Router } from 'express';
import { z } from 'zod';
import { parsePartnerInput } from '../../modules/partners/partner-errors.js';
import { partnerPlayer } from '../../modules/partners/games/kit.js';
import { partnerCardDetectiveService } from '../../modules/partners/games/card-detective/cd-partner.service.js';
import { CD_CLUE_KEYS } from '../../modules/partners/games/card-detective/cd-partner.rules.js';

const startSchema = z.object({ clientNonce: z.string().trim().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/) });
const playParams = z.object({ playId: z.string().uuid() });
const cardAction = z.object({ ref: z.string().regex(/^[0-9a-f]{16}$/), version: z.number().int().min(0) });
const revealSchema = cardAction.extend({ clue: z.enum(CD_CLUE_KEYS as [string, ...string[]]) });
const guessSchema = cardAction.extend({ name: z.string().trim().min(1).max(80) });

/** /partner/v1/games/card-detective (mounted behind partnerPlayerAuth). */
export const partnerCardDetectiveRouter = Router();

partnerCardDetectiveRouter.get('/current', async (req, res) => {
  res.json(await partnerCardDetectiveService.current(partnerPlayer(req)));
});

partnerCardDetectiveRouter.post('/start', async (req, res) => {
  const { clientNonce } = parsePartnerInput(startSchema, req.body);
  res.status(201).json(await partnerCardDetectiveService.start(partnerPlayer(req), clientNonce));
});

partnerCardDetectiveRouter.get('/plays/:playId', async (req, res) => {
  const { playId } = parsePartnerInput(playParams, req.params);
  res.json(await partnerCardDetectiveService.get(partnerPlayer(req), playId));
});

partnerCardDetectiveRouter.post('/plays/:playId/reveal', async (req, res) => {
  const { playId } = parsePartnerInput(playParams, req.params);
  const body = parsePartnerInput(revealSchema, req.body);
  res.json(await partnerCardDetectiveService.reveal(partnerPlayer(req), playId, body as z.infer<typeof cardAction> & { clue: (typeof CD_CLUE_KEYS)[number] }));
});

partnerCardDetectiveRouter.post('/plays/:playId/guess', async (req, res) => {
  const { playId } = parsePartnerInput(playParams, req.params);
  res.json(await partnerCardDetectiveService.guess(partnerPlayer(req), playId, parsePartnerInput(guessSchema, req.body)));
});

partnerCardDetectiveRouter.post('/plays/:playId/skip', async (req, res) => {
  const { playId } = parsePartnerInput(playParams, req.params);
  res.json(await partnerCardDetectiveService.skip(partnerPlayer(req), playId, parsePartnerInput(cardAction, req.body)));
});

partnerCardDetectiveRouter.post('/plays/:playId/finish', async (req, res) => {
  const { playId } = parsePartnerInput(playParams, req.params);
  res.json(await partnerCardDetectiveService.finish(partnerPlayer(req), playId));
});
