import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

vi.mock('../../src/modules/ranked/ranked.service.js', () => ({
  rankedService: {
    listSeasons: vi.fn(),
    getLeaderboard: vi.fn(),
    getArchivedLeaderboard: vi.fn(),
    ensureProfile: vi.fn(),
    getUserRank: vi.fn(),
    getArchivedUserRank: vi.fn(),
  },
}));

vi.mock('../../src/modules/users/users.repo.js', () => ({
  usersRepo: { getById: vi.fn() },
}));

import { rankedController } from '../../src/modules/ranked/ranked.controller.js';
import { rankedService } from '../../src/modules/ranked/ranked.service.js';
import { usersRepo } from '../../src/modules/users/users.repo.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const BATCH_ID = '22222222-2222-4222-8222-222222222222';

function request(query: Record<string, unknown> = {}): Request {
  return {
    user: { id: USER_ID },
    validated: { query },
  } as unknown as Request;
}

function response(): Response {
  return { json: vi.fn() } as unknown as Response;
}

describe('rankedController season reads', () => {
  beforeEach(() => vi.clearAllMocks());

  it('maps completed batches to numbered seasons and identifies the live season', async () => {
    vi.mocked(rankedService.listSeasons).mockResolvedValue([
      { id: BATCH_ID, seasonNumber: 1, startedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:01:00.000Z' },
      { id: USER_ID, seasonNumber: 2, startedAt: '2026-02-01T00:00:00.000Z', completedAt: '2026-02-01T00:01:00.000Z' },
    ]);
    const res = response();

    await rankedController.listSeasons(request(), res);

    expect(res.json).toHaveBeenCalledWith({
      seasons: [
        {
          id: BATCH_ID,
          seasonNumber: 1,
          startedAt: '2026-01-01T00:00:00.000Z',
          endedAt: '2026-01-01T00:01:00.000Z',
        },
        {
          id: USER_ID,
          seasonNumber: 2,
          startedAt: '2026-02-01T00:00:00.000Z',
          endedAt: '2026-02-01T00:01:00.000Z',
        },
      ],
      currentSeasonNumber: 3,
    });
  });

  it('routes a season leaderboard query to the archived leaderboard', async () => {
    vi.mocked(rankedService.getArchivedLeaderboard).mockResolvedValue([]);
    const res = response();

    await rankedController.getLeaderboard(request({
      scope: 'global', limit: 25, offset: 10, season: BATCH_ID,
    }), res);

    expect(rankedService.getArchivedLeaderboard).toHaveBeenCalledWith(BATCH_ID, 25, 10, undefined);
    expect(rankedService.getLeaderboard).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ entries: [] });
  });

  it('routes a season user-rank query to the archived rank without ensuring a live profile', async () => {
    vi.mocked(usersRepo.getById).mockResolvedValue({
      id: USER_ID,
      nickname: 'Season Player',
      avatar_url: null,
      avatar_customization: null,
      country: 'GE',
    } as never);
    vi.mocked(rankedService.getArchivedUserRank).mockResolvedValue(null);
    const res = response();

    await rankedController.getUserRank(request({ scope: 'country', season: BATCH_ID }), res);

    expect(rankedService.getArchivedUserRank).toHaveBeenCalledWith(BATCH_ID, USER_ID, 'GE');
    expect(rankedService.ensureProfile).not.toHaveBeenCalled();
    expect(rankedService.getUserRank).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(null);
  });
});
