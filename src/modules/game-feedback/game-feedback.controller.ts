import type { Request, Response, RequestHandler } from 'express';
import { playerOf } from '../wordgame-daily/wordgame-daily.shared.js';
import { gameFeedbackRepo } from './game-feedback.repo.js';
import type { GameFeedbackBody } from './game-feedback.schemas.js';

export function submitGameFeedback(game: 'tenable'): RequestHandler {
  return async (req: Request, res: Response): Promise<void> => {
    await gameFeedbackRepo.save(game, playerOf(req), req.validated.body as GameFeedbackBody);
    res.status(204).end();
  };
}
