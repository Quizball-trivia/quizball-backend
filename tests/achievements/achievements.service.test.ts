import { beforeEach, describe, expect, it, vi } from 'vitest';

import '../setup.js';

const listForUserMock = vi.fn();
const listUnlockedForMatchMock = vi.fn();
const getMetricsForUserMock = vi.fn();
const upsertProgressMock = vi.fn();
const trackAchievementUnlockedMock = vi.fn();

vi.mock('../../src/modules/achievements/achievements.repo.js', () => ({
  achievementsRepo: {
    listForUser: (...args: unknown[]) => listForUserMock(...args),
    listUnlockedForMatch: (...args: unknown[]) => listUnlockedForMatchMock(...args),
    getMetricsForUser: (...args: unknown[]) => getMetricsForUserMock(...args),
    upsertProgress: (...args: unknown[]) => upsertProgressMock(...args),
  },
}));

vi.mock('../../src/core/analytics/game-events.js', () => ({
  trackAchievementUnlocked: (...args: unknown[]) => trackAchievementUnlockedMock(...args),
}));

describe('achievementsService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists all achievements with merged stored and computed progress', async () => {
    listForUserMock.mockResolvedValue([
      {
        user_id: 'user-1',
        achievement_id: 'debut_match',
        progress: 1,
        unlocked_at: '2026-03-08T00:00:00.000Z',
        source_match_id: null,
        created_at: '2026-03-08T00:00:00.000Z',
        updated_at: '2026-03-08T00:00:00.000Z',
      },
    ]);
    getMetricsForUserMock.mockResolvedValue({
      completedMatches: 4,
      totalWins: 3,
      partyQuizWins: 0,
      hasPerfectMatch: false,
      hasLightningCounter: true,
      hasCleanSheet: false,
      bestWinStreak: 3,
    });

    const { achievementsService } = await import('../../src/modules/achievements/achievements.service.js');
    const achievements = await achievementsService.listForUser('user-1');

    expect(achievements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'debut_match', unlocked: true, progress: 1, target: 1 }),
        expect.objectContaining({ id: 'lightning_counter', unlocked: true, progress: 1, target: 1 }),
        expect.objectContaining({ id: 'winning_streak', unlocked: false, progress: 3, target: 5 }),
        expect.objectContaining({ id: 'multiplayer_master', unlocked: false, progress: 3, target: 10 }),
      ])
    );
  });

  it('returns only newly unlocked achievements that the current match variant can trigger', async () => {
    listForUserMock.mockResolvedValue([
      {
        user_id: 'user-1',
        achievement_id: 'debut_match',
        progress: 1,
        unlocked_at: '2026-03-08T00:00:00.000Z',
        source_match_id: null,
        created_at: '2026-03-08T00:00:00.000Z',
        updated_at: '2026-03-08T00:00:00.000Z',
      },
      {
        user_id: 'user-1',
        achievement_id: 'winning_streak',
        progress: 4,
        unlocked_at: null,
        source_match_id: null,
        created_at: '2026-03-08T00:00:00.000Z',
        updated_at: '2026-03-08T00:00:00.000Z',
      },
    ]);
    getMetricsForUserMock.mockResolvedValue({
      completedMatches: 12,
      totalWins: 10,
      partyQuizWins: 1,
      hasPerfectMatch: true,
      hasLightningCounter: true,
      hasCleanSheet: true,
      bestWinStreak: 5,
    });
    upsertProgressMock.mockImplementation(async (params: unknown) => params);

    const { achievementsService } = await import('../../src/modules/achievements/achievements.service.js');
    const unlocked = await achievementsService.evaluateForMatch('match-1', ['user-1'], 'ranked_sim');

    expect(unlocked['user-1']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'hat_trick_hero', unlocked: true }),
        expect.objectContaining({ id: 'lightning_counter', unlocked: true }),
        expect.objectContaining({ id: 'clean_sheet', unlocked: true }),
        expect.objectContaining({ id: 'winning_streak', unlocked: true, progress: 5 }),
        expect.objectContaining({ id: 'multiplayer_master', unlocked: true, progress: 10 }),
      ])
    );
    expect(unlocked['user-1']).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'trophy_collector' }),
      ])
    );
    expect(upsertProgressMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        sourceMatchId: 'match-1',
      })
    );
    expect(trackAchievementUnlockedMock).toHaveBeenCalledWith('user-1', 'hat_trick_hero', 'Hat-Trick Hero');
  });

  it('allows party-quiz-only achievements to unlock during party quiz matches', async () => {
    listForUserMock.mockResolvedValue([]);
    getMetricsForUserMock.mockResolvedValue({
      completedMatches: 3,
      totalWins: 2,
      partyQuizWins: 1,
      hasPerfectMatch: false,
      hasLightningCounter: false,
      hasCleanSheet: false,
      bestWinStreak: 2,
    });
    upsertProgressMock.mockImplementation(async (params: unknown) => params);

    const { achievementsService } = await import('../../src/modules/achievements/achievements.service.js');
    const unlocked = await achievementsService.evaluateForMatch('match-2', ['user-1'], 'friendly_party_quiz');

    expect(unlocked['user-1']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'trophy_collector', unlocked: true }),
      ])
    );
  });

  it('groups unlocked achievements by match id for replay payloads', async () => {
    listUnlockedForMatchMock.mockResolvedValue([
      {
        user_id: 'user-1',
        achievement_id: 'debut_match',
        progress: 1,
        unlocked_at: '2026-03-08T00:00:00.000Z',
        source_match_id: 'match-1',
        created_at: '2026-03-08T00:00:00.000Z',
        updated_at: '2026-03-08T00:00:00.000Z',
      },
      {
        user_id: 'user-2',
        achievement_id: 'trophy_collector',
        progress: 1,
        unlocked_at: '2026-03-08T00:00:00.000Z',
        source_match_id: 'match-1',
        created_at: '2026-03-08T00:00:00.000Z',
        updated_at: '2026-03-08T00:00:00.000Z',
      },
    ]);

    const { achievementsService } = await import('../../src/modules/achievements/achievements.service.js');
    const result = await achievementsService.listUnlockedForMatch('match-1');

    expect(result).toEqual({
      'user-1': [expect.objectContaining({ id: 'debut_match' })],
      'user-2': [expect.objectContaining({ id: 'trophy_collector' })],
    });
  });
});
