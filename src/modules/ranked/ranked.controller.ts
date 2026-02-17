import type { Request, Response } from 'express';
import { rankedService } from './ranked.service.js';
import type { RankedProfileResponse } from './ranked.schemas.js';

export const rankedController = {
  async getProfile(req: Request, res: Response): Promise<void> {
    const profile = await rankedService.ensureProfile(req.user!.id);
    const response: RankedProfileResponse = {
      rp: profile.rp,
      tier: profile.tier,
      placementStatus: profile.placement_status,
      placementPlayed: profile.placement_played,
      placementRequired: profile.placement_required,
      placementWins: profile.placement_wins,
      currentWinStreak: profile.current_win_streak,
      lastRankedMatchAt: profile.last_ranked_match_at,
    };
    res.json(response);
  },
};
