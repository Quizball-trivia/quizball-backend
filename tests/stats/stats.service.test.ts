import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('../../src/modules/stats/stats.repo.js', () => ({
  statsRepo: {
    getUserModeStats: vi.fn(),
    listRecentMatchesForUser: vi.fn(),
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

describe('statsService.getRecentMatchesForUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('maps ranked placement matches to placement competition', async () => {
    (statsRepo.listRecentMatchesForUser as Mock).mockResolvedValue([
      {
        match_id: '00000000-0000-0000-0000-000000000011',
        mode: 'ranked',
        status: 'completed',
        winner_user_id: null,
        ended_at: '2026-04-09T16:00:00.000Z',
        started_at: '2026-04-09T15:50:00.000Z',
        player_score: 1,
        opponent_score: 1,
        player_goals: 1,
        player_penalty_goals: 0,
        opponent_goals: 1,
        opponent_penalty_goals: 0,
        winner_decision_method: null,
        ranked_delta_rp: 0,
        ranked_is_placement: true,
        opponent_id: '00000000-0000-0000-0000-000000000012',
        opponent_username: 'placement-bot',
        opponent_avatar_url: null,
        opponent_is_ai: true,
      },
    ]);

    const matches = await statsService.getRecentMatchesForUser(
      '00000000-0000-0000-0000-000000000013',
      10
    );

    expect(matches).toEqual([
      expect.objectContaining({
        mode: 'ranked',
        competition: 'placement',
        result: 'draw',
        rpDelta: 0,
        opponent: expect.objectContaining({
          username: 'placement-bot',
          isAi: true,
        }),
      }),
    ]);
  });

  it('maps ranked wins with positive RP deltas correctly', async () => {
    const userId = '00000000-0000-0000-0000-000000000021';
    (statsRepo.listRecentMatchesForUser as Mock).mockResolvedValue([
      {
        match_id: '00000000-0000-0000-0000-000000000022',
        mode: 'ranked',
        status: 'completed',
        winner_user_id: userId,
        ended_at: '2026-04-09T18:00:00.000Z',
        started_at: '2026-04-09T17:50:00.000Z',
        player_score: 3,
        opponent_score: 1,
        player_goals: 3,
        player_penalty_goals: 0,
        opponent_goals: 1,
        opponent_penalty_goals: 0,
        winner_decision_method: 'goals',
        ranked_delta_rp: 28,
        ranked_is_placement: false,
        opponent_id: '00000000-0000-0000-0000-000000000023',
        opponent_username: 'gotcha',
        opponent_avatar_url: 'https://example.com/avatar.png',
        opponent_is_ai: false,
      },
    ]);

    const matches = await statsService.getRecentMatchesForUser(userId, 10);

    expect(matches).toEqual([
      expect.objectContaining({
        mode: 'ranked',
        competition: 'ranked',
        result: 'win',
        winnerDecisionMethod: 'goals',
        rpDelta: 28,
        opponent: expect.objectContaining({
          id: '00000000-0000-0000-0000-000000000023',
          username: 'gotcha',
          avatarUrl: 'https://example.com/avatar.png',
          isAi: false,
        }),
      }),
    ]);
  });

  it('maps friendly matches to friendly competition with null RP delta', async () => {
    const userId = '00000000-0000-0000-0000-000000000031';
    (statsRepo.listRecentMatchesForUser as Mock).mockResolvedValue([
      {
        match_id: '00000000-0000-0000-0000-000000000032',
        mode: 'friendly',
        status: 'completed',
        winner_user_id: '00000000-0000-0000-0000-000000000033',
        ended_at: '2026-04-09T19:00:00.000Z',
        started_at: '2026-04-09T18:55:00.000Z',
        player_score: 2,
        opponent_score: 4,
        player_goals: 2,
        player_penalty_goals: 0,
        opponent_goals: 4,
        opponent_penalty_goals: 0,
        winner_decision_method: 'goals',
        ranked_delta_rp: 99,
        ranked_is_placement: false,
        opponent_id: '00000000-0000-0000-0000-000000000033',
        opponent_username: 'friend-1',
        opponent_avatar_url: null,
        opponent_is_ai: false,
      },
    ]);

    const matches = await statsService.getRecentMatchesForUser(userId, 10);

    expect(matches).toEqual([
      expect.objectContaining({
        mode: 'friendly',
        competition: 'friendly',
        result: 'loss',
        winnerDecisionMethod: 'goals',
        rpDelta: null,
        opponent: expect.objectContaining({
          username: 'friend-1',
          isAi: false,
        }),
      }),
    ]);
  });

  it('maps valid winner decision methods including goals and penalty_goals', async () => {
    const userId = '00000000-0000-0000-0000-000000000041';
    (statsRepo.listRecentMatchesForUser as Mock).mockResolvedValue([
      {
        match_id: '00000000-0000-0000-0000-000000000042',
        mode: 'ranked',
        status: 'completed',
        winner_user_id: userId,
        ended_at: '2026-04-09T20:00:00.000Z',
        started_at: '2026-04-09T19:50:00.000Z',
        player_score: 2,
        opponent_score: 1,
        player_goals: 1,
        player_penalty_goals: 1,
        opponent_goals: 1,
        opponent_penalty_goals: 0,
        winner_decision_method: 'penalty_goals',
        ranked_delta_rp: 15,
        ranked_is_placement: false,
        opponent_id: '00000000-0000-0000-0000-000000000043',
        opponent_username: 'pens-master',
        opponent_avatar_url: null,
        opponent_is_ai: false,
      },
      {
        match_id: '00000000-0000-0000-0000-000000000044',
        mode: 'ranked',
        status: 'completed',
        winner_user_id: userId,
        ended_at: '2026-04-09T21:00:00.000Z',
        started_at: '2026-04-09T20:50:00.000Z',
        player_score: 3,
        opponent_score: 1,
        player_goals: 3,
        player_penalty_goals: 0,
        opponent_goals: 1,
        opponent_penalty_goals: 0,
        winner_decision_method: 'goals',
        ranked_delta_rp: 21,
        ranked_is_placement: false,
        opponent_id: '00000000-0000-0000-0000-000000000045',
        opponent_username: 'finisher',
        opponent_avatar_url: null,
        opponent_is_ai: false,
      },
    ]);

    const matches = await statsService.getRecentMatchesForUser(userId, 10);

    expect(matches).toEqual([
      expect.objectContaining({
        matchId: '00000000-0000-0000-0000-000000000042',
        winnerDecisionMethod: 'penalty_goals',
        result: 'win',
      }),
      expect.objectContaining({
        matchId: '00000000-0000-0000-0000-000000000044',
        winnerDecisionMethod: 'goals',
        result: 'win',
      }),
    ]);
  });

  it('preserves ranked RP deltas for non-placement forfeits', async () => {
    (statsRepo.listRecentMatchesForUser as Mock).mockResolvedValue([
      {
        match_id: '00000000-0000-0000-0000-000000000001',
        mode: 'ranked',
        status: 'completed',
        winner_user_id: 'opponent-1',
        ended_at: '2026-04-09T16:00:00.000Z',
        started_at: '2026-04-09T15:50:00.000Z',
        player_score: 0,
        opponent_score: 2,
        player_goals: 0,
        player_penalty_goals: 0,
        opponent_goals: 2,
        opponent_penalty_goals: 0,
        winner_decision_method: 'forfeit',
        ranked_delta_rp: -35,
        ranked_is_placement: false,
        opponent_id: '00000000-0000-0000-0000-000000000002',
        opponent_username: 'benzaoo',
        opponent_avatar_url: null,
        opponent_is_ai: false,
      },
    ]);

    const matches = await statsService.getRecentMatchesForUser(
      '00000000-0000-0000-0000-000000000003',
      10
    );

    expect(matches).toEqual([
      expect.objectContaining({
        mode: 'ranked',
        competition: 'ranked',
        result: 'loss',
        winnerDecisionMethod: 'forfeit',
        rpDelta: -35,
        opponent: expect.objectContaining({
          username: 'benzaoo',
          isAi: false,
        }),
      }),
    ]);
  });
});
