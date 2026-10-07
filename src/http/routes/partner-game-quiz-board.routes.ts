import { Router } from 'express';
import { z } from 'zod';
import { parsePartnerInput } from '../../modules/partners/partner-errors.js';
import { partnerPlayer } from '../../modules/partners/games/kit.js';
import {
  answerBoardTile,
  currentBoard,
  leaveBoardPlay,
  pickBoardTile,
  startBoard,
} from '../../modules/partners/games/quiz-board/index.js';

const startSchema = z.object({ startId: z.string().uuid() });
const moveSchema = z.object({ playId: z.string().uuid(), turn: z.number().int().min(0) });
const pickSchema = moveSchema.extend({ tile: z.number().int().min(0).max(8) });
const answerSchema = moveSchema.extend({ choice: z.number().int().min(0).max(3) });
const leaveSchema = z.object({ playId: z.string().uuid() });

/** /partner/v1/games/quiz-board (behind partnerPlayerAuth). Every response is `{ board }`, the player's view. */
const router = Router();

const currentSchema = z.object({ playId: z.string().uuid().optional() });

router.get('/current', async (req, res) => {
  const { playId } = parsePartnerInput(currentSchema, req.query);
  res.json({ board: await currentBoard(partnerPlayer(req), playId) });
});

router.post('/start', async (req, res) => {
  const { startId } = parsePartnerInput(startSchema, req.body);
  res.json({ board: await startBoard(partnerPlayer(req), startId) });
});

router.post('/pick', async (req, res) => {
  const { playId, turn, tile } = parsePartnerInput(pickSchema, req.body);
  res.json({ board: await pickBoardTile(partnerPlayer(req), playId, turn, tile) });
});

router.post('/answer', async (req, res) => {
  const { playId, turn, choice } = parsePartnerInput(answerSchema, req.body);
  res.json({ board: await answerBoardTile(partnerPlayer(req), playId, turn, choice) });
});

router.post('/leave', async (req, res) => {
  const { playId } = parsePartnerInput(leaveSchema, req.body);
  res.json({ board: await leaveBoardPlay(partnerPlayer(req), playId) });
});

export const partnerQuizBoardRoutes = router;
