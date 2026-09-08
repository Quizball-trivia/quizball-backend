import type { Request, Response } from 'express';
import { z } from 'zod';
import { guestService } from './guest.service.js';
import { dailyChallengesService } from '../daily-challenges/daily-challenges.service.js';
import { resolveTrustedClientIp } from '../../http/client-ip.js';
import type { DailyChallengeType } from '../daily-challenges/daily-challenges.types.js';
import type { CompleteDailyChallengeBody, DailyChallengeParam } from '../daily-challenges/daily-challenges.schemas.js';

export const createGuestSessionSchema = z.object({
  locale: z.enum(['en', 'ka', 'es']).optional(),
});

export const guestController = {
  async createSession(req: Request, res: Response): Promise<void> {
    const body = (req.validated.body ?? {}) as z.infer<typeof createGuestSessionSchema>;
    const rawDevice = req.headers['x-client-instance-id'];
    const deviceId = Array.isArray(rawDevice) ? rawDevice[0] : rawDevice;
    const session = await guestService.createSession({
      locale: body.locale ?? null,
      ip: resolveTrustedClientIp(req) ?? null,
      deviceId: typeof deviceId === 'string' ? deviceId : null,
    });
    res.status(201).json({ token: session.token, guest_id: session.guestId });
  },

  /** Today's real daily set for a guest: same selection rules, no served-history, no completion gate. */
  async createDailySession(req: Request, res: Response): Promise<void> {
    const { challengeType } = req.validated.params as DailyChallengeParam;
    const { locale } = (req.validated.query ?? {}) as { locale?: string };
    res.json(await dailyChallengesService.getChallengeSession(req.guest!.id, challengeType as DailyChallengeType, locale, { guest: true }));
  },

  /** Records the guest's best score for the day. No coins, XP, streak or leaderboard row. */
  async completeDaily(req: Request, res: Response): Promise<void> {
    const { challengeType } = req.validated.params as DailyChallengeParam;
    const body = req.validated.body as CompleteDailyChallengeBody;
    res.json(await dailyChallengesService.completeChallengeForGuest(req.guest!.id, challengeType as DailyChallengeType, body.score));
  },

  async passChainLink(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as { puzzleId: string; fromPlayerId: string; text: string; locale?: string };
    res.json(await dailyChallengesService.linkPassChain(`guest:${req.guest!.id}`, body, body.locale));
  },

  async statSniperLeaderboard(_req: Request, res: Response): Promise<void> {
    res.json(await dailyChallengesService.getStatSniperLeaderboard(null));
  },
};
