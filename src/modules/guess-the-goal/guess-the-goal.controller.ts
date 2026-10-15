import type { Request, Response } from 'express';
import { config } from '../../core/config.js';
import { AppError } from '../../core/errors.js';
import { guessTheGoalService } from './guess-the-goal.service.js';
import type { BonusRequest, GuessRequest, StartSessionRequest } from './guess-the-goal.schemas.js';
import type { GgtPlayer } from './guess-the-goal.types.js';

/**
 * Guess the Goal controller. HTTP <-> service only; all scoring and reward
 * logic lives in the service. Players are members (req.user) or guest sessions
 * (req.guest), set by the route's identify step; dev handlers are member-only.
 * Session payloads are per-player, answer-adjacent state: never cache.
 */
function playerOf(req: Request): GgtPlayer {
  if (req.user) return { kind: 'member', userId: req.user.id };
  if (req.guest) return { kind: 'guest', guestId: req.guest.id };
  throw new AppError('No player identity', 401);
}

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
    const state = await guessTheGoalService.startSession(playerOf(req), body.client_nonce ?? null);
    noStore(res).status(201).json(state);
  },

  async getCurrent(req: Request, res: Response): Promise<void> {
    noStore(res).json(await guessTheGoalService.getCurrent(playerOf(req)));
  },

  async guess(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as GuessRequest;
    const { sessionId } = req.validated.params as { sessionId: string };
    noStore(res).json(await guessTheGoalService.guess(playerOf(req), sessionId, body.option_id));
  },

  async answerBonus(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as BonusRequest;
    const { sessionId } = req.validated.params as { sessionId: string };
    noStore(res).json(
      await guessTheGoalService.answerBonus(playerOf(req), sessionId, body.option_id)
    );
  },

  /** Admin-only test lever: wipe today's attempts so the daily limit and the
   *  featured intro can be replayed without waiting for midnight. */
  async resetTodayDev(req: Request, res: Response): Promise<void> {
    const removed = await guessTheGoalService.resetTodayForUser(req.user!.id);
    res.json({ removed });
  },

  /** Admin-only content browser: every published goal with board + video,
   *  regardless of what the caller has solved — for auditing the pool. */
  async allGoalsDev(_req: Request, res: Response): Promise<void> {
    noStore(res).json(await guessTheGoalService.getAllGoalsDev());
  },

  async stats(req: Request, res: Response): Promise<void> {
    noStore(res).json(await guessTheGoalService.getStats(playerOf(req)));
  },

  async gallery(req: Request, res: Response): Promise<void> {
    noStore(res).json(await guessTheGoalService.getGallery(playerOf(req)));
  },
};
