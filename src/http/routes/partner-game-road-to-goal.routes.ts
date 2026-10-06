import { Router } from 'express';
import { z } from 'zod';
import { parsePartnerInput } from '../../modules/partners/partner-errors.js';
import { partnerPlayer } from '../../modules/partners/games/kit.js';
import { partnerRoadToGoalService as service } from '../../modules/partners/games/road-to-goal/partner-road-to-goal.service.js';

const runParams = z.object({ runId: z.string().uuid() });
const startBody = z.object({ start_id: z.string().uuid() });
const versionBody = z.object({ expected_version: z.number().int().min(1) });
const answerBody = versionBody.extend({ question_id: z.string().uuid(), option_id: z.string().min(1).max(64) });

/** /partner/v1/games/road-to-goal (behind partnerPlayerAuth). */
export const partnerRoadToGoalRouter = Router();

partnerRoadToGoalRouter.post('/runs', async (req, res) => {
  const { start_id } = parsePartnerInput(startBody, req.body);
  res.status(201).json(await service.start(partnerPlayer(req), start_id));
});

partnerRoadToGoalRouter.get('/runs/current', async (req, res) => {
  res.json(await service.current(partnerPlayer(req)));
});

partnerRoadToGoalRouter.get('/runs/:runId', async (req, res) => {
  const { runId } = parsePartnerInput(runParams, req.params);
  res.json(await service.get(partnerPlayer(req), runId));
});

partnerRoadToGoalRouter.post('/runs/:runId/answer', async (req, res) => {
  const { runId } = parsePartnerInput(runParams, req.params);
  const body = parsePartnerInput(answerBody, req.body);
  res.json(await service.answer(partnerPlayer(req), runId, {
    questionId: body.question_id,
    optionId: body.option_id,
    expectedVersion: body.expected_version,
  }));
});

partnerRoadToGoalRouter.post('/runs/:runId/continue', async (req, res) => {
  const { runId } = parsePartnerInput(runParams, req.params);
  const body = parsePartnerInput(versionBody, req.body);
  res.json(await service.continueRun(partnerPlayer(req), runId, body.expected_version));
});

partnerRoadToGoalRouter.post('/runs/:runId/cashout', async (req, res) => {
  const { runId } = parsePartnerInput(runParams, req.params);
  const body = parsePartnerInput(versionBody, req.body);
  res.json(await service.cashout(partnerPlayer(req), runId, body.expected_version));
});

partnerRoadToGoalRouter.post('/runs/:runId/leave', async (req, res) => {
  const { runId } = parsePartnerInput(runParams, req.params);
  res.json(await service.leave(partnerPlayer(req), runId));
});
