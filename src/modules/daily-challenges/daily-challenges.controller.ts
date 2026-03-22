import type { Request, Response } from 'express';
import { AuthenticationError } from '../../core/errors.js';
import { dailyChallengesService } from './daily-challenges.service.js';
import type {
  CompleteDailyChallengeBody,
  DailyChallengeParam,
  UpdateDailyChallengeConfigBody,
} from './daily-challenges.schemas.js';

export const dailyChallengesController = {
  async list(req: Request, res: Response): Promise<void> {
    const items = await dailyChallengesService.listActiveChallenges(req.user!.id);
    res.json({ items });
  },

  async createSession(req: Request, res: Response): Promise<void> {
    const { challengeType } = req.validated.params as DailyChallengeParam;
    const session = await dailyChallengesService.getChallengeSession(req.user!.id, challengeType);
    res.json(session);
  },

  async complete(req: Request, res: Response): Promise<void> {
    const { challengeType } = req.validated.params as DailyChallengeParam;
    const body = req.validated.body as CompleteDailyChallengeBody;
    const result = await dailyChallengesService.completeChallenge(req.user!.id, challengeType, body.score);
    res.json(result);
  },

  async resetDev(req: Request, res: Response): Promise<void> {
    const { challengeType } = req.validated.params as DailyChallengeParam;
    const user = req.user;
    if (!user) {
      throw new AuthenticationError('Authentication required');
    }

    dailyChallengesService.assertDevResetAllowed(user.role);
    const result = await dailyChallengesService.resetChallengeForToday(user.id, challengeType);
    res.json(result);
  },

  async listAdmin(_req: Request, res: Response): Promise<void> {
    const items = await dailyChallengesService.listAdminConfigs();
    res.json({ items });
  },

  async updateAdmin(req: Request, res: Response): Promise<void> {
    const { challengeType } = req.validated.params as DailyChallengeParam;
    const body = req.validated.body as UpdateDailyChallengeConfigBody;
    const result = await dailyChallengesService.updateConfig(challengeType, {
      ...body,
      settings: body.settings ?? {},
    });
    res.json(result);
  },
};
