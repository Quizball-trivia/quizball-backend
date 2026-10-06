import { Router } from 'express';
import { z } from 'zod';
import { parsePartnerInput } from '../../modules/partners/partner-errors.js';
import { partnerPlayer } from '../../modules/partners/games/kit.js';
import { partnerGuessTheGoalService } from '../../modules/partners/games/guess-the-goal/ggt-partner.service.js';

const startSchema = z.object({ client_nonce: z.string().trim().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/) });
const optionSchema = z.object({ option_id: z.string().min(1).max(16) });
const sessionParams = z.object({ sessionId: z.string().uuid() });

/** /partner/v1/games/guess-the-goal (mounted behind partnerPlayerAuth). */
export const partnerGuessTheGoalRouter = Router();

partnerGuessTheGoalRouter.get('/current', async (req, res) => {
  res.json(await partnerGuessTheGoalService.current(partnerPlayer(req)));
});

partnerGuessTheGoalRouter.post('/start', async (req, res) => {
  const { client_nonce } = parsePartnerInput(startSchema, req.body);
  res.status(201).json(await partnerGuessTheGoalService.start(partnerPlayer(req), client_nonce));
});

partnerGuessTheGoalRouter.get('/sessions/:sessionId', async (req, res) => {
  const { sessionId } = parsePartnerInput(sessionParams, req.params);
  res.json(await partnerGuessTheGoalService.get(partnerPlayer(req), sessionId));
});

partnerGuessTheGoalRouter.post('/sessions/:sessionId/guess', async (req, res) => {
  const { sessionId } = parsePartnerInput(sessionParams, req.params);
  const { option_id } = parsePartnerInput(optionSchema, req.body);
  res.json(await partnerGuessTheGoalService.guess(partnerPlayer(req), sessionId, option_id));
});

partnerGuessTheGoalRouter.post('/sessions/:sessionId/bonus', async (req, res) => {
  const { sessionId } = parsePartnerInput(sessionParams, req.params);
  const { option_id } = parsePartnerInput(optionSchema, req.body);
  res.json(await partnerGuessTheGoalService.answerBonus(partnerPlayer(req), sessionId, option_id));
});

partnerGuessTheGoalRouter.post('/sessions/:sessionId/expire', async (req, res) => {
  const { sessionId } = parsePartnerInput(sessionParams, req.params);
  res.json(await partnerGuessTheGoalService.expire(partnerPlayer(req), sessionId));
});
