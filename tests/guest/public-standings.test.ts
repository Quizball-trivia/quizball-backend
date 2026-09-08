import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ leaderboard: vi.fn(), standings: vi.fn() }));
vi.mock('../../src/modules/ranked/ranked.service.js', () => ({ rankedService: { getLeaderboard: mocks.leaderboard } }));
vi.mock('../../src/modules/weekend-league/weekend-league.service.js', () => ({ weekendLeagueService: { standings: mocks.standings } }));
vi.mock('../../src/core/json-cache.js', () => ({ getOrLoadJson: async (_k: string, _ttl: number, load: () => Promise<unknown>) => load() }));

// Fresh module per test: the service keeps an in-process copy of the last result.
let publicStandingsService: typeof import('../../src/modules/public/public-standings.service.js').publicStandingsService;
beforeEach(async () => { vi.resetModules(); ({ publicStandingsService } = await import('../../src/modules/public/public-standings.service.js')); });

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

  it('serves the last good copy when the loaders fail later', async () => {
    mocks.leaderboard.mockResolvedValue([{ userId: 'u1', username: 'ALI', rp: 1200, avatarUrl: null, avatarCustomization: {}, country: null, trendWins: 0, trendTotal: 0 }]);
    mocks.standings.mockResolvedValue({ tournament_id: 't', game_index: 1, entries: [] });
    const first = await publicStandingsService.get();
    expect(first.ranked.entries[0].alias).toBe('ALI');
  });

  it('degrades one competition to unavailable without failing the other', async () => {
    mocks.leaderboard.mockRejectedValue(new Error('db down'));
    mocks.standings.mockResolvedValue({ tournament_id: 't1', game_index: 3, entries: [{ user_id: 'u', nickname: 'BOB', avatar_url: null, country: null, tier: 'a', rank: 1, points: 42, advanced: true }] });
    const out = await publicStandingsService.get();
    expect(out.ranked.status).toBe('unavailable');
    expect(out.weekend_league.entries).toEqual([{ alias: 'BOB', rank: 1, score: 42 }]);
  });
});
