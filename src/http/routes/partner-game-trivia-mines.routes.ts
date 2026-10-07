import { Router } from 'express';
import { z } from 'zod';
import { parsePartnerInput } from '../../modules/partners/partner-errors.js';
import { partnerPlayer } from '../../modules/partners/games/kit.js';
import { partnerTriviaMinesService as service } from '../../modules/partners/games/trivia-mines/partner-trivia-mines.service.js';

const runParams = z.object({ runId: z.string().uuid() });
const startBody = z.object({ start_id: z.string().uuid() });
const versionBody = z.object({ expected_version: z.number().int().min(1) });
const pickBody = versionBody.extend({ tile: z.number().int().min(0).max(24) });
const answerBody = versionBody.extend({ question_id: z.string().uuid(), option_id: z.string().min(1).max(64) });

/** /partner/v1/games/trivia-mines (behind partnerPlayerAuth). */
export const partnerTriviaMinesRouter = Router();

partnerTriviaMinesRouter.post('/runs', async (req, res) => {
  const { start_id } = parsePartnerInput(startBody, req.body);
  res.status(201).json(await service.start(partnerPlayer(req), start_id));
});

partnerTriviaMinesRouter.get('/runs/current', async (req, res) => {
  res.json(await service.current(partnerPlayer(req)));
});

partnerTriviaMinesRouter.get('/runs/latest', async (req, res) => {
  res.json(await service.latest(partnerPlayer(req)));
});

partnerTriviaMinesRouter.post('/runs/heartbeat', async (req, res) => {
  await service.heartbeat(partnerPlayer(req));
  res.status(204).end();
});

partnerTriviaMinesRouter.get('/runs/:runId', async (req, res) => {
  const { runId } = parsePartnerInput(runParams, req.params);
  res.json(await service.get(partnerPlayer(req), runId));
});

partnerTriviaMinesRouter.post('/runs/:runId/pick', async (req, res) => {
  const { runId } = parsePartnerInput(runParams, req.params);
  const body = parsePartnerInput(pickBody, req.body);
  res.json(await service.pick(partnerPlayer(req), runId, { tile: body.tile, expectedVersion: body.expected_version }));
});

partnerTriviaMinesRouter.post('/runs/:runId/question', async (req, res) => {
  const { runId } = parsePartnerInput(runParams, req.params);
  const body = parsePartnerInput(versionBody, req.body);
  res.json(await service.deal(partnerPlayer(req), runId, body.expected_version));
});

partnerTriviaMinesRouter.post('/runs/:runId/answer', async (req, res) => {
  const { runId } = parsePartnerInput(runParams, req.params);
  const body = parsePartnerInput(answerBody, req.body);
  res.json(await service.answer(partnerPlayer(req), runId, {
    questionId: body.question_id,
    optionId: body.option_id,
    expectedVersion: body.expected_version,
  }));
});

partnerTriviaMinesRouter.post('/runs/:runId/cashout', async (req, res) => {
  const { runId } = parsePartnerInput(runParams, req.params);
  const body = parsePartnerInput(versionBody, req.body);
  res.json(await service.cashout(partnerPlayer(req), runId, body.expected_version));
});

partnerTriviaMinesRouter.post('/runs/:runId/leave', async (req, res) => {
  const { runId } = parsePartnerInput(runParams, req.params);
  res.json(await service.leave(partnerPlayer(req), runId));
});
