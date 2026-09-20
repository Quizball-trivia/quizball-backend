import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ leaderboard: vi.fn(), standings: vi.fn(), auction: vi.fn(), grid: vi.fn() }));
vi.mock('../../src/modules/ranked/ranked.service.js', () => ({ rankedService: { getLeaderboard: mocks.leaderboard } }));
vi.mock('../../src/modules/weekend-league/weekend-league.service.js', () => ({ weekendLeagueService: { standings: mocks.standings } }));
vi.mock('../../src/modules/auction/auction-leaderboard.service.js', () => ({ auctionLeaderboardService: { getLeaderboard: mocks.auction } }));
vi.mock('../../src/modules/football-grid/football-grid-leaderboard.service.js', () => ({ footballGridLeaderboardService: { getLeaderboard: mocks.grid } }));
vi.mock('../../src/core/json-cache.js', () => ({ getOrLoadJson: async (_k: string, _ttl: number, load: () => Promise<unknown>) => load() }));

// Fresh module per test: the service keeps an in-process copy of the last result.
let publicStandingsService: typeof import('../../src/modules/public/public-standings.service.js').publicStandingsService;
beforeEach(async () => { vi.clearAllMocks(); vi.resetModules(); ({ publicStandingsService } = await import('../../src/modules/public/public-standings.service.js')); });

describe('public standings projection', () => {
  it('exposes only alias, rank and score, and reports a league that has not started', async () => {
    mocks.leaderboard.mockResolvedValue([{ userId: 'u1', username: 'ALI', rp: 1200, avatarUrl: 'x', avatarCustomization: {}, country: 'GE', trendWins: 1, trendTotal: 2 }]);
    mocks.standings.mockResolvedValue({ tournament_id: 't1', game_index: null, entries: [] });
    const out = await publicStandingsService.get();
    expect(out.ranked.status).toBe('live');
    expect(out.ranked.entries).toEqual([{ alias: 'ALI', rank: 1, score: 1200 }]);
    expect(Object.keys(out.ranked.entries[0])).toEqual(['alias', 'rank', 'score']);
    expect(out.weekend_league.status).toBe('pending_results');
  });

  it('reports not_started only when there is no current tournament', async () => {
    mocks.leaderboard.mockResolvedValue([]);
    mocks.standings.mockResolvedValue({ tournament_id: null, game_index: null, entries: [] });
    expect((await publicStandingsService.get()).weekend_league.status).toBe('not_started');
  });

  it('returns the projection on a successful first read', async () => {
    mocks.leaderboard.mockResolvedValue([{ userId: 'u1', username: 'ALI', rp: 1200, avatarUrl: null, avatarCustomization: {}, country: null, trendWins: 0, trendTotal: 0 }]);
    mocks.standings.mockResolvedValue({ tournament_id: 't', game_index: 1, entries: [] });
    const first = await publicStandingsService.get();
    expect(first.ranked.entries[0].alias).toBe('ALI');
  });

  it('keeps the last good snapshot when a reload fails after the cache window', async () => {
    vi.useFakeTimers();
    try {
      mocks.leaderboard.mockResolvedValueOnce([{ userId: 'u1', username: 'ALI', rp: 1200, tier: 'Pro' }]);
      mocks.standings.mockResolvedValue({ tournament_id: null, game_index: null, entries: [] });
      const first = await publicStandingsService.board('ranked');
      expect(first.entries).toEqual([{ alias: 'ALI', rank: 1, score: 1200, tier: 'Pro' }]);
      vi.advanceTimersByTime(121_000);
      mocks.leaderboard.mockRejectedValueOnce(new Error('db down'));
      const second = await publicStandingsService.board('ranked');
      expect(second.status).toBe('live');
      expect(second.updated_at).toBe(first.updated_at);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not hit the loader again within the retry window after a failure', async () => {
    vi.useFakeTimers();
    try {
      mocks.leaderboard.mockRejectedValue(new Error('db down'));
      for (let i = 0; i < 5; i += 1) expect((await publicStandingsService.board('ranked')).status).toBe('unavailable');
      expect(mocks.leaderboard).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(16_000);
      mocks.leaderboard.mockResolvedValue([{ userId: 'u1', username: 'ALI', rp: 10 }]);
      expect((await publicStandingsService.board('ranked')).status).toBe('live');
      expect(mocks.leaderboard).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('serves fixed top-50 boards per competition with the approved fields only', async () => {
    mocks.auction.mockResolvedValue([{ userId: 'u', username: null, auctionPoints: 77, avatarUrl: 'x', country: 'GE' }]);
    mocks.grid.mockResolvedValue(Array.from({ length: 60 }, (_, i) => ({ userId: `u${i}`, username: `P${i}`, ticTacToePoints: 100 - i })));
    const auction = await publicStandingsService.board('auction');
    expect(auction.entries).toEqual([{ alias: 'Player', rank: 1, score: 77 }]);
    expect(auction.scoring_label).toBe('AP');
    const grid = await publicStandingsService.board('grid');
    expect(grid.entries).toHaveLength(50);
    expect(mocks.grid).toHaveBeenCalledWith(50, 0);
    expect(Object.keys(grid.entries[0])).toEqual(['alias', 'rank', 'score']);
  });

  it('snippet is the top 5 of the same cached board', async () => {
    mocks.leaderboard.mockResolvedValue(Array.from({ length: 50 }, (_, i) => ({ userId: `u${i}`, username: `P${i}`, rp: 500 - i })));
    mocks.standings.mockResolvedValue({ tournament_id: 't', game_index: 1, entries: Array.from({ length: 9 }, (_, i) => ({ nickname: `W${i}`, rank: i + 1, points: 9 - i })) });
    const out = await publicStandingsService.get();
    expect(out.ranked.entries).toHaveLength(5);
    expect(out.weekend_league.entries).toHaveLength(5);
    expect(mocks.leaderboard).toHaveBeenCalledTimes(1);
  });

  it('degrades one competition to unavailable without failing the other', async () => {
    mocks.leaderboard.mockRejectedValue(new Error('db down'));
    mocks.standings.mockResolvedValue({ tournament_id: 't1', game_index: 3, entries: [{ user_id: 'u', nickname: 'BOB', avatar_url: null, country: null, tier: 'a', rank: 1, points: 42, advanced: true }] });
    const out = await publicStandingsService.get();
    expect(out.ranked.status).toBe('unavailable');
    expect(out.weekend_league.entries).toEqual([{ alias: 'BOB', rank: 1, score: 42 }]);
  });
});
