import type { Request, Response } from 'express';
import { z } from 'zod';
import { guestService } from './guest.service.js';
import { usersService } from '../users/users.service.js';
import { config } from '../../core/config.js';
import { AuthenticationError } from '../../core/errors.js';
import { GUEST_IDENTITY_PROVIDER } from './guest-identity.js';
import { dailyChallengesService } from '../daily-challenges/daily-challenges.service.js';
import { resolveTrustedClientIp } from '../../http/client-ip.js';
import { NotFoundError, RateLimitError } from '../../core/errors.js';
import { allowGuestOperation } from './guest-rate-limit.js';
import { bucketIp } from '../../core/ip-bucket.js';
import { detectCountryFromHeaders } from '../../core/geo.js';
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

  /**
   * Friend lobbies: resolves (or, when provisioning is on, creates) the users row
   * behind this guest token BEFORE the socket connects, so the client knows its
   * user id, name and kit up front. Zero balances, no account_created event.
   */
  async principal(req: Request, res: Response): Promise<void> {
    // Same drain rule as socket auth: reconnect off refuses every guest principal.
    if (!config.GUEST_LOBBIES_RECONNECT_ENABLED) {
      throw new AuthenticationError('Guest play is not available');
    }
    const clientIp = resolveTrustedClientIp(req) ?? null;
    if (!(await allowGuestOperation(`ip:${bucketIp(clientIp)}`, 'principal'))) {
      throw new RateLimitError('Too many guest sessions from this address');
    }
    // Country is detected once here (socket auth skips geo for a known country).
    const country = await detectCountryFromHeaders(req.headers, clientIp).catch(() => null);
    const { user, created } = await usersService.getOrCreateGuest(
      { provider: GUEST_IDENTITY_PROVIDER, subject: req.guest!.id, claims: {} },
      country,
      { allowCreate: config.GUEST_LOBBIES_PROVISIONING_ENABLED },
    );
    res.status(created ? 201 : 200).json({
      user_id: user.id,
      nickname: user.nickname,
      avatar_customization: user.avatar_customization,
      is_guest: true,
    });
  },
  /** Today's real daily set for a guest: same selection rules, no served-history, no completion gate. */
  async createDailySession(req: Request, res: Response): Promise<void> {
    const { challengeType } = req.validated.params as DailyChallengeParam;
    const { locale } = (req.validated.query ?? {}) as { locale?: string };
    res.json(await dailyChallengesService.getGuestChallengeSession(challengeType as DailyChallengeType, locale));
  },

  /** Records the guest's best score for the day. No coins, XP, streak or leaderboard row. */
  async completeDaily(req: Request, res: Response): Promise<void> {
    const { challengeType } = req.validated.params as DailyChallengeParam;
    const body = req.validated.body as CompleteDailyChallengeBody;
    res.json(await dailyChallengesService.completeChallengeForGuest(req.guest!.id, challengeType as DailyChallengeType, body.score));
  },

  async passChainLink(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as { puzzleId: string; fromPlayerId: string; text: string; locale?: string };
    // Only today's frozen guest puzzles: a stored puzzle id must not become a permanent lookup oracle.
    if (!(await dailyChallengesService.isGuestPuzzleToday(body.puzzleId))) throw new NotFoundError('Puzzle not found');
    res.json(await dailyChallengesService.linkPassChain(`guest:${req.guest!.id}`, body, body.locale));
  },

  /** Public projection of the day's board: alias, rank, score only. */
  async statSniperLeaderboard(_req: Request, res: Response): Promise<void> {
    const board = await dailyChallengesService.getStatSniperLeaderboard(null);
    res.json({ challengeDay: board.challengeDay, entries: board.entries.map((e) => ({ rank: e.rank, alias: e.username, score: e.score })), me: null });
  },
};
