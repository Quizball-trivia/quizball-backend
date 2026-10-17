import type { Request, Response } from 'express';

import { normalizeSupportedCountryCode } from '../../core/country.js';
import { usersRepo } from '../users/users.repo.js';
import { leaderboardClubs } from './leaderboard-clubs.js';
import type { StandingsQuery } from './standings.schemas.js';
import { standingsService } from './standings.service.js';

export const standingsController = {
  async list(req: Request, res: Response): Promise<void> {
    const { mode, kind } = req.validated.query as StandingsQuery;
    const rows = await standingsService.list(mode, kind);

    let viewer = null;
    if (req.user) {
      const user = await usersRepo.getById(req.user.id);
      const mine = kind === 'country'
        ? normalizeSupportedCountryCode(user?.country)
        : await leaderboardClubs.resolve(user?.favorite_club);
      if (mine) viewer = await standingsService.viewer(mode, kind, mine, req.user.id);
    }

    res.json({
      standings: rows.map((row, index) => ({
        key: row.key,
        rank: index + 1,
        players: row.players,
        score: row.score,
        topPlayer: row.topUsername !== null && row.topPoints !== null
          ? { username: row.topUsername, points: row.topPoints }
          : null,
      })),
      viewer,
    });
  },
};
