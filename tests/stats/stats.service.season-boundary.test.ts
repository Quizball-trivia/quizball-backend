import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/modules/stats/stats.repo.js', () => ({
  statsRepo: {
    getUserModeStats: vi.fn(),
    getRankedStatsSplitAtBoundary: vi.fn(),
  },
}));

vi.mock('../../src/modules/ranked/ranked.repo.js', () => ({
  rankedRepo: {
    listRecentCompletedSeasonResets: vi.fn(),
  },
}));

import { rankedRepo } from '../../src/modules/ranked/ranked.repo.js';
import { statsRepo } from '../../src/modules/stats/stats.repo.js';
import {
  _resetSeasonBoundaryCacheForTests,
  statsService,
} from '../../src/modules/stats/stats.service.js';

const EPOCH_ISO = '1970-01-01T00:00:00Z';

const EMPTY_SPLIT = {
  previous_wins: 0,
  previous_losses: 0,
  previous_draws: 0,
  current_wins: 0,
  current_losses: 0,
  current_draws: 0,
};

describe('statsService ranked season split', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetSeasonBoundaryCacheForTests();
    vi.mocked(statsRepo.getUserModeStats).mockResolvedValue([]);
    vi.mocked(statsRepo.getRankedStatsSplitAtBoundary).mockResolvedValue(EMPTY_SPLIT);
  });

  it('uses the latest completed reset and maps current and previous stats', async () => {
    const completedAt = '2026-07-21T12:34:56.000Z';
    vi.mocked(rankedRepo.listRecentCompletedSeasonResets).mockResolvedValue([
      { seasonNumber: 1, completedAt },
    ]);
    vi.mocked(statsRepo.getRankedStatsSplitAtBoundary).mockResolvedValue({
      previous_wins: 2,
      previous_losses: 1,
      previous_draws: 1,
      current_wins: 3,
      current_losses: 2,
      current_draws: 1,
    });

    const summary = await statsService.getUserStatsSummary('user-1');

    expect(statsRepo.getRankedStatsSplitAtBoundary).toHaveBeenCalledWith(
      'user-1',
      completedAt,
      EPOCH_ISO,
    );
    expect(summary.rankedSeasons).toEqual({
      current: {
        gamesPlayed: 6,
        wins: 3,
        losses: 2,
        draws: 1,
        winRate: 50,
      },
      previous: {
        gamesPlayed: 4,
        wins: 2,
        losses: 1,
        draws: 1,
        winRate: 50,
      },
      currentSeasonNumber: 2,
      previousSeasonNumber: 1,
    });
  });

  it('bounds the previous bucket at the penultimate reset once two seasons completed', async () => {
    const season2End = '2026-09-15T00:00:00.000Z';
    const season1End = '2026-07-21T12:34:56.000Z';
    vi.mocked(rankedRepo.listRecentCompletedSeasonResets).mockResolvedValue([
      { seasonNumber: 2, completedAt: season2End },
      { seasonNumber: 1, completedAt: season1End },
    ]);

    const summary = await statsService.getUserStatsSummary('user-1');

    expect(statsRepo.getRankedStatsSplitAtBoundary).toHaveBeenCalledWith(
      'user-1',
      season2End,
      season1End,
    );
    expect(summary.rankedSeasons.currentSeasonNumber).toBe(3);
    expect(summary.rankedSeasons.previousSeasonNumber).toBe(2);
  });

  it('uses the epoch boundary and season 1 when no reset exists', async () => {
    vi.mocked(rankedRepo.listRecentCompletedSeasonResets).mockResolvedValue([]);

    const summary = await statsService.getUserStatsSummary('user-1');

    expect(statsRepo.getRankedStatsSplitAtBoundary).toHaveBeenCalledWith(
      'user-1',
      EPOCH_ISO,
      EPOCH_ISO,
    );
    expect(summary.rankedSeasons.currentSeasonNumber).toBe(1);
    expect(summary.rankedSeasons.previousSeasonNumber).toBeNull();
  });

  it('caches the completed reset within the boundary TTL', async () => {
    vi.mocked(rankedRepo.listRecentCompletedSeasonResets).mockResolvedValue([
      { seasonNumber: 1, completedAt: '2026-07-21T12:34:56.000Z' },
    ]);

    await statsService.getUserStatsSummary('user-1');
    await statsService.getUserStatsSummary('user-2');

    expect(rankedRepo.listRecentCompletedSeasonResets).toHaveBeenCalledTimes(1);
  });
});
