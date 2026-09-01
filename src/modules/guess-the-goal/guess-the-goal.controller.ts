import type { Request, Response } from 'express';
import { config } from '../../core/config.js';
import { AppError } from '../../core/errors.js';
import { guessTheGoalService } from './guess-the-goal.service.js';
import type { BonusRequest, GuessRequest, StartSessionRequest } from './guess-the-goal.schemas.js';

/**
 * Guess the Goal controller. HTTP <-> service only; all scoring and reward
 * logic lives in the service. Every handler assumes authMiddleware populated
 * req.user. Session payloads are per-user, answer-adjacent state: never cache.
 */
function noStore(res: Response): Response {
  return res.set('Cache-Control', 'private, no-store');
}

export const guessTheGoalController = {
  async startSession(req: Request, res: Response): Promise<void> {
    // Kill switch blocks only NEW sessions — open ones can always finish.
    if (!config.GUESS_THE_GOAL_ENABLED) {
      throw new AppError('Guess the Goal is currently disabled', 503);
    }
    const body = req.validated.body as StartSessionRequest;
    const state = await guessTheGoalService.startSession(req.user!.id, body.client_nonce ?? null);
    noStore(res).status(201).json(state);
  },

  async getCurrent(req: Request, res: Response): Promise<void> {
    noStore(res).json(await guessTheGoalService.getCurrent(req.user!.id));
  },

  async guess(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as GuessRequest;
    const { sessionId } = req.validated.params as { sessionId: string };
    noStore(res).json(await guessTheGoalService.guess(req.user!.id, sessionId, body.option_id));
  },

  async answerBonus(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as BonusRequest;
    const { sessionId } = req.validated.params as { sessionId: string };
    noStore(res).json(
      await guessTheGoalService.answerBonus(req.user!.id, sessionId, body.option_id)
    );
  },

  /** Admin-only test lever: wipe today's attempts so the daily limit and the
   *  featured intro can be replayed without waiting for midnight. */
  async resetTodayDev(req: Request, res: Response): Promise<void> {
    const removed = await guessTheGoalService.resetTodayForUser(req.user!.id);
    res.json({ removed });
  },

  async stats(req: Request, res: Response): Promise<void> {
    noStore(res).json(await guessTheGoalService.getStats(req.user!.id));
  },

  async gallery(req: Request, res: Response): Promise<void> {
    noStore(res).json(await guessTheGoalService.getGallery(req.user!.id));
  },
};
