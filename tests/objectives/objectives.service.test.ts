import { beforeEach, describe, expect, it, vi } from 'vitest';

import '../setup.js';
import type { ObjectiveProgressRow } from '../../src/modules/objectives/objectives.types.js';

const runInTransactionMock = vi.fn();
const listForUserPeriodMock = vi.fn();
const getMatchFactsMock = vi.fn();
const getRankedWinStreakForPeriodMock = vi.fn();

// These tests cover the ENABLED behavior, so force the flag on regardless of
// the local .env (which sets OBJECTIVES_ENABLED=false).
const objectivesEnabledMock = { value: true };
vi.mock('../../src/core/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/config.js')>();
  return {
    ...actual,
    config: new Proxy(actual.config, {
      get(target, prop) {
        if (prop === 'OBJECTIVES_ENABLED') return objectivesEnabledMock.value;
        return target[prop as keyof typeof target];
      },
    }),
  };
});

vi.mock('../../src/modules/objectives/objectives.repo.js', () => ({
  objectivesRepo: {
    runInTransaction: (...args: unknown[]) => runInTransactionMock(...args),
    listForUserPeriod: (...args: unknown[]) => listForUserPeriodMock(...args),
    getMatchFacts: (...args: unknown[]) => getMatchFactsMock(...args),
    getRankedWinStreakForPeriod: (...args: unknown[]) => getRankedWinStreakForPeriodMock(...args),
  },
}));

function makeRow(overrides: Partial<ObjectiveProgressRow>): ObjectiveProgressRow {
  const objectiveId = overrides.objective_id ?? 'daily_play_3_online_matches';
  return {
    id: `${objectiveId}-row`,
    user_id: 'user-1',
    objective_id: objectiveId,
    period_type: objectiveId.startsWith('weekly_') ? 'weekly' : 'daily',
    period_start: '2026-05-09T00:00:00.000Z',
    period_end: '2026-05-10T00:00:00.000Z',
    progress: 0,
    target: 1,
    completed_at: null,
    rewarded_at: null,
    reward_coins: 100,
    reward_xp: 50,
    metadata: {},
    created_at: '2026-05-09T00:00:00.000Z',
    updated_at: '2026-05-09T00:00:00.000Z',
    ...overrides,
  };
}

describe('objectivesService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    objectivesEnabledMock.value = true;
  });

  it('returns empty objectives WITHOUT touching the DB when the flag is disabled', async () => {
    objectivesEnabledMock.value = false;
    const { objectivesService } = await import('../../src/modules/objectives/index.js');

    const result = await objectivesService.listForUser('user-1');

    // No DB reads, no write transaction — kill-switch short-circuits.
    expect(listForUserPeriodMock).not.toHaveBeenCalled();
    expect(runInTransactionMock).not.toHaveBeenCalled();
    expect(result).toHaveProperty('daily');
    expect(result).toHaveProperty('weekly');
  });

  it('lists current daily and weekly objectives after ensuring missing progress rows', async () => {
    const ensuredObjectiveIds: string[] = [];
    runInTransactionMock.mockImplementation(async (callback: (txRepo: object) => Promise<unknown>) =>
      callback({
        ensureProgress: vi.fn(async ({ definition }: { definition: { id: string } }) => {
          ensuredObjectiveIds.push(definition.id);
          return makeRow({ objective_id: definition.id });
        }),
      }),
    );
    const existingDailyRows = [
      makeRow({
        objective_id: 'daily_play_3_online_matches',
        progress: 2,
        target: 3,
      }),
    ];
    const existingWeeklyRows = [
      makeRow({
        objective_id: 'weekly_win_10_competitive',
        period_type: 'weekly',
        period_start: '2026-05-04T00:00:00.000Z',
        period_end: '2026-05-11T00:00:00.000Z',
        progress: 4,
        target: 10,
      }),
    ];
    listForUserPeriodMock
      .mockResolvedValueOnce(existingDailyRows)
      .mockResolvedValueOnce(existingWeeklyRows)
      .mockResolvedValueOnce(existingDailyRows)
      .mockResolvedValueOnce(existingWeeklyRows);

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-09T12:00:00.000Z'));
    const { objectivesService } = await import('../../src/modules/objectives/objectives.service.js');
    const response = await objectivesService.listForUser('user-1');
    vi.useRealTimers();

    expect(ensuredObjectiveIds).not.toContain('daily_play_3_online_matches');
    expect(ensuredObjectiveIds).not.toContain('weekly_win_10_competitive');
    expect(ensuredObjectiveIds).toContain('daily_answer_15_correct');
    expect(ensuredObjectiveIds).toContain('weekly_win_streak_3');
    expect(response.daily.periodStart).toBe('2026-05-09T00:00:00.000Z');
    expect(response.weekly.periodStart).toBe('2026-05-04T00:00:00.000Z');
    expect(response.daily.objectives).toEqual([
      expect.objectContaining({
        id: 'daily_play_3_online_matches',
        progress: 2,
        target: 3,
        completed: false,
      }),
    ]);
  });

  it('lists objectives without opening a write transaction when all current rows exist', async () => {
    const dailyRows = [
      makeRow({ objective_id: 'daily_play_3_online_matches' }),
      makeRow({ objective_id: 'daily_answer_15_correct' }),
      makeRow({ objective_id: 'daily_score_second_half_goal' }),
      makeRow({ objective_id: 'daily_clean_sheet' }),
      makeRow({ objective_id: 'daily_complete_all' }),
    ];
    const weeklyRows = [
      makeRow({ objective_id: 'weekly_win_10_competitive', period_type: 'weekly' }),
      makeRow({ objective_id: 'weekly_win_streak_3', period_type: 'weekly' }),
      makeRow({ objective_id: 'weekly_answer_50_correct_one_category', period_type: 'weekly' }),
      makeRow({ objective_id: 'weekly_play_friend_custom_room', period_type: 'weekly' }),
      makeRow({ objective_id: 'weekly_complete_dailies_5_times', period_type: 'weekly' }),
    ];
    listForUserPeriodMock
      .mockResolvedValueOnce(dailyRows)
      .mockResolvedValueOnce(weeklyRows);

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-09T12:00:00.000Z'));
    const { objectivesService } = await import('../../src/modules/objectives/objectives.service.js');
    const response = await objectivesService.listForUser('user-1');
    vi.useRealTimers();

    expect(runInTransactionMock).not.toHaveBeenCalled();
    expect(listForUserPeriodMock).toHaveBeenCalledTimes(2);
    expect(response.daily.totalCount).toBe(5);
    expect(response.weekly.totalCount).toBe(5);
  });

  it('increments eligible objectives once per match and grants rewards on completion', async () => {
    const existingRows = new Map<string, ObjectiveProgressRow>();
    const rewardedIds: string[] = [];
    const events = new Set<string>();
    const addCoinsMock = vi.fn();
    const grantXpMock = vi.fn();
    const logRewardMock = vi.fn();

    function getOrCreateRow(definition: {
      id: string;
      periodType: 'daily' | 'weekly';
      target: number;
      rewardCoins: number;
      rewardXp: number;
    }): ObjectiveProgressRow {
      const existing = existingRows.get(definition.id);
      if (existing) return { ...existing };
      const row = makeRow({
        objective_id: definition.id,
        period_type: definition.periodType,
        period_start: definition.periodType === 'weekly'
          ? '2026-05-04T00:00:00.000Z'
          : '2026-05-09T00:00:00.000Z',
        period_end: definition.periodType === 'weekly'
          ? '2026-05-11T00:00:00.000Z'
          : '2026-05-10T00:00:00.000Z',
        target: definition.target,
        reward_coins: definition.rewardCoins,
        reward_xp: definition.rewardXp,
      });
      existingRows.set(definition.id, row);
      return { ...row };
    }

    runInTransactionMock.mockImplementation(async (callback: (txRepo: object) => Promise<unknown>) =>
      callback({
        ensureProgress: vi.fn(async ({ definition }: { definition: {
          id: string;
          periodType: 'daily' | 'weekly';
          target: number;
          rewardCoins: number;
          rewardXp: number;
        } }) => getOrCreateRow(definition)),
        ensureProgressBatch: vi.fn(async ({ entries }: { entries: Array<{ definition: {
          id: string;
          periodType: 'daily' | 'weekly';
          target: number;
          rewardCoins: number;
          rewardXp: number;
        } }> }) => entries.map((entry) => getOrCreateRow(entry.definition))),
        insertEvent: vi.fn(async ({ userId, objectiveId, eventKey }: { userId: string; objectiveId: string; eventKey: string }) => {
          const key = `${userId}:${objectiveId}:${eventKey}`;
          if (events.has(key)) return false;
          events.add(key);
          return true;
        }),
        insertEventsBatch: vi.fn(async ({ userId, eventKey, entries }: { userId: string; eventKey: string; entries: Array<{ objectiveId: string }> }) => {
          const inserted = new Set<string>();
          for (const entry of entries) {
            const key = `${userId}:${entry.objectiveId}:${eventKey}`;
            if (events.has(key)) continue;
            events.add(key);
            inserted.add(entry.objectiveId);
          }
          return inserted;
        }),
        incrementProgress: vi.fn(async ({ objectiveId, delta }: { objectiveId: string; delta: number }) => {
          const row = existingRows.get(objectiveId)!;
          row.progress = Math.min(row.target, row.progress + delta);
          if (row.progress >= row.target && !row.completed_at) {
            row.completed_at = '2026-05-09T12:00:00.000Z';
          }
          return row;
        }),
        setProgress: vi.fn(async ({ objectiveId, progress, metadata }: { objectiveId: string; progress: number; metadata?: object }) => {
          const row = existingRows.get(objectiveId)!;
          row.progress = Math.min(row.target, Math.max(row.progress, progress));
          if (metadata) row.metadata = metadata;
          if (row.progress >= row.target && !row.completed_at) {
            row.completed_at = '2026-05-09T12:00:00.000Z';
          }
          return row;
        }),
        getProgressRows: vi.fn(async () => [...existingRows.values()].filter((row) => row.period_type === 'daily')),
        markRewarded: vi.fn(async (rowId: string) => {
          const row = [...existingRows.values()].find((candidate) => candidate.id === rowId)!;
          if (rewardedIds.includes(row.id)) return null;
          rewardedIds.push(row.id);
          row.rewarded_at = '2026-05-09T12:00:00.000Z';
          return row;
        }),
        addCoins: addCoinsMock,
        grantXp: grantXpMock,
        logReward: logRewardMock,
        getRankedWinStreakForPeriod: (...args: unknown[]) => getRankedWinStreakForPeriodMock(...args),
      }),
    );

    getMatchFactsMock.mockResolvedValue([
      {
        matchId: 'match-1',
        userId: 'user-1',
        opponentUserId: 'user-2',
        mode: 'ranked',
        variant: 'ranked_sim',
        isWinner: true,
        correctAnswers: 15,
        goalsFor: 1,
        goalsAgainst: 0,
        penaltyGoalsAgainst: 0,
        isDev: false,
        isAi: false,
        secondHalfGoals: 1,
        correctByCategory: {
          '11111111-1111-1111-1111-111111111111': { name: 'World Cup', count: 15 },
        },
        playedWithFriend: false,
      },
    ]);
    getRankedWinStreakForPeriodMock.mockResolvedValue(3);

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-09T12:00:00.000Z'));
    const { objectivesService } = await import('../../src/modules/objectives/objectives.service.js');
    const completed = await objectivesService.evaluateForMatch('match-1');
    const replayCompleted = await objectivesService.evaluateForMatch('match-1');
    vi.useRealTimers();

    expect(completed['user-1']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'daily_answer_15_correct', rewarded: true }),
        expect.objectContaining({ id: 'daily_score_second_half_goal', rewarded: true }),
        expect.objectContaining({ id: 'weekly_win_streak_3', rewarded: true }),
      ]),
    );
    expect(replayCompleted['user-1'] ?? []).toEqual([]);
    expect(addCoinsMock).toHaveBeenCalled();
    expect(grantXpMock).toHaveBeenCalled();
    expect(logRewardMock).toHaveBeenCalled();
    expect(existingRows.get('daily_answer_15_correct')?.progress).toBe(15);
    expect(existingRows.get('weekly_answer_50_correct_one_category')?.metadata).toEqual(
      expect.objectContaining({
        leadingCategoryName: 'World Cup',
      }),
    );
  });
});
