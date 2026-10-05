import { config } from '../../core/config.js';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { AuthenticationError } from '../../core/errors.js';
import { weekendLeagueService } from './weekend-league.service.js';
import { wlRewardsRepo } from './wl-rewards.js';
import type { WlRewardIdParam, WlRewardsResponse } from './weekend-league.schemas.js';

function requireUserId(req: Request): string {
  const userId = req.user?.id;
  if (!userId) throw new AuthenticationError('Authentication required');
  return userId;
}

const testTargetSchema = z.object({ tournament_id: z.string().uuid().optional() }).passthrough();

export const weekendLeagueController = {
  async current(req: Request, res: Response): Promise<void> {
    res.json(await weekendLeagueService.current(requireUserId(req)));
  },

  async standings(req: Request, res: Response): Promise<void> {
    requireUserId(req);
    res.json(await weekendLeagueService.standings());
  },

  // Public: same cached leaderboard for everyone, and the service takes no
  // caller. The old requireUserId() gated public data behind a 401.
  async hallOfFame(_req: Request, res: Response): Promise<void> {
    res.json(await weekendLeagueService.hallOfFame());
  },

  rewardPolicy(_req: Request, res: Response): void {
    res.json({ reward_frames: config.WL_REWARD_FRAMES_ENABLED });
  },

  async qp(req: Request, res: Response): Promise<void> {
    res.json(await weekendLeagueService.qp(requireUserId(req)));
  },

  async enter(req: Request, res: Response): Promise<void> {
    // Optional body.tournament_id targets an is_test event only (harness
    // affordance — see service.resolveTarget); ignored otherwise.
    const tournamentId = testTargetSchema.parse(req.body ?? {}).tournament_id;
    res.json(await weekendLeagueService.enter(requireUserId(req), tournamentId));
  },

  async checkin(req: Request, res: Response): Promise<void> {
    const tournamentId = testTargetSchema.parse(req.body ?? {}).tournament_id;
    res.json(await weekendLeagueService.checkin(requireUserId(req), tournamentId));
  },

  /** The caller's granted rewards. History stays after acknowledgement. */
  async rewards(req: Request, res: Response): Promise<void> {
    const rows = await wlRewardsRepo.listForUser(requireUserId(req));
    const body: WlRewardsResponse = {
      rewards: rows.map((row) => ({
        id: row.id,
        tournamentId: row.tournament_id,
        weekKey: row.week_key,
        band: row.band,
        finalRank: row.human_rank,
        coins: row.coins,
        items: row.items.map((item) => ({
          slug: item.slug,
          avatarPartId: item.avatarPartId,
          slot: item.slot,
          alreadyOwned: item.alreadyOwned === true,
        })),
        grantedAt: row.granted_at ?? '',
        seen: row.seen_at !== null,
      })),
    };
    res.json(body);
  },

  /** Marks the reveal as watched. Grants nothing: the reward is already owned. */
  async rewardSeen(req: Request, res: Response): Promise<void> {
    const { rewardId } = req.validated.params as WlRewardIdParam;
    res.json({ acknowledged: await wlRewardsRepo.markSeen(requireUserId(req), rewardId) });
  },
};
