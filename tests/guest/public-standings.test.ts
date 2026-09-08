import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ leaderboard: vi.fn(), standings: vi.fn() }));
vi.mock('../../src/modules/ranked/ranked.service.js', () => ({ rankedService: { getLeaderboard: mocks.leaderboard } }));
vi.mock('../../src/modules/weekend-league/weekend-league.service.js', () => ({ weekendLeagueService: { standings: mocks.standings } }));
vi.mock('../../src/core/json-cache.js', () => ({ getOrLoadJson: async (_k: string, _ttl: number, load: () => Promise<unknown>) => load() }));

const { publicStandingsService } = await import('../../src/modules/public/public-standings.service.js');

describe('public standings projection', () => {
  it('exposes only alias, rank and score, and reports a league that has not started', async () => {
    mocks.leaderboard.mockResolvedValue([{ userId: 'u1', username: 'ALI', rp: 1200, avatarUrl: 'x', avatarCustomization: {}, country: 'GE', trendWins: 1, trendTotal: 2 }]);
    mocks.standings.mockResolvedValue({ tournament_id: 't1', game_index: null, entries: [] });
    const out = await publicStandingsService.get();
    expect(out.ranked.status).toBe('live');
    expect(out.ranked.entries).toEqual([{ alias: 'ALI', rank: 1, score: 1200 }]);
    expect(Object.keys(out.ranked.entries[0])).toEqual(['alias', 'rank', 'score']);
    expect(out.weekend_league.status).toBe('not_started');
  });

  it('degrades one competition to unavailable without failing the other', async () => {
    mocks.leaderboard.mockRejectedValue(new Error('db down'));
    mocks.standings.mockResolvedValue({ tournament_id: 't1', game_index: 3, entries: [{ user_id: 'u', nickname: 'BOB', avatar_url: null, country: null, tier: 'a', rank: 1, points: 42, advanced: true }] });
    const out = await publicStandingsService.get();
    expect(out.ranked.status).toBe('unavailable');
    expect(out.weekend_league.entries).toEqual([{ alias: 'BOB', rank: 1, score: 42 }]);
  });
});
