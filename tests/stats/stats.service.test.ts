import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('../../src/modules/stats/stats.repo.js', () => ({
  statsRepo: {
    getUserModeStats: vi.fn(),
  },
}));

import { statsRepo } from '../../src/modules/stats/stats.repo.js';
import { statsService } from '../../src/modules/stats/stats.service.js';

describe('statsService.getUserStatsSummary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns zero summary when user has no stats rows', async () => {
    (statsRepo.getUserModeStats as Mock).mockResolvedValue([]);

    const summary = await statsService.getUserStatsSummary('user-1');

    expect(summary).toEqual({
      overall: { gamesPlayed: 0, wins: 0, losses: 0, draws: 0, winRate: 0 },
      ranked: { gamesPlayed: 0, wins: 0, losses: 0, draws: 0, winRate: 0 },
      friendly: { gamesPlayed: 0, wins: 0, losses: 0, draws: 0, winRate: 0 },
    });
  });

  it('computes per-mode and overall stats correctly', async () => {
    (statsRepo.getUserModeStats as Mock).mockResolvedValue([
      { mode: 'ranked', games_played: 10, wins: 7, losses: 2, draws: 1 },
      { mode: 'friendly', games_played: 4, wins: 1, losses: 2, draws: 1 },
    ]);

    const summary = await statsService.getUserStatsSummary('user-1');

    expect(summary.ranked).toEqual({
      gamesPlayed: 10,
      wins: 7,
      losses: 2,
      draws: 1,
      winRate: 70,
    });
    expect(summary.friendly).toEqual({
      gamesPlayed: 4,
      wins: 1,
      losses: 2,
      draws: 1,
      winRate: 25,
    });
    expect(summary.overall).toEqual({
      gamesPlayed: 14,
      wins: 8,
      losses: 4,
      draws: 2,
      winRate: 57.14,
    });
  });
});
