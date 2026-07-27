import { trackAchievementUnlocked } from '../../core/analytics/game-events.js';
import { achievementsRepo } from './achievements.repo.js';
import { ACHIEVEMENT_DEFINITIONS } from './achievements.definitions.js';
import type {
  AchievementMatchVariant,
  AchievementProgress,
  AchievementUnlockPayload,
  UserAchievementMetrics,
} from './achievements.types.js';

function computeProgress(achievementId: string, metrics: UserAchievementMetrics): number {
  switch (achievementId) {
    case 'debut_match':
      return Math.min(1, metrics.completedMatches);
    case 'hat_trick_hero':
      return metrics.hasPerfectMatch ? 1 : 0;
    case 'lightning_counter':
      return metrics.hasLightningCounter ? 1 : 0;
    case 'clean_sheet':
      return metrics.hasCleanSheet ? 1 : 0;
    case 'winning_streak':
      return Math.min(5, metrics.currentWinStreak);
    case 'multiplayer_master':
      return Math.min(10, metrics.totalWins);
    case 'trophy_collector':
      return Math.min(1, metrics.partyQuizWins);
    default:
      return 0;
  }
}

function isAchievementEligibleForVariant(
  achievementId: string,
  matchVariant: AchievementMatchVariant
): boolean {
  switch (achievementId) {
    case 'trophy_collector':
      return matchVariant === 'friendly_party_quiz';
    case 'clean_sheet':
      return matchVariant !== 'friendly_party_quiz';
    default:
      return true;
  }
}

export const achievementsService = {
  async listForUser(userId: string): Promise<AchievementProgress[]> {
    const [rows, metrics] = await Promise.all([
      achievementsRepo.listForUser(userId),
      achievementsRepo.getMetricsForUser(userId),
    ]);
    const rowById = new Map(rows.map((row) => [row.achievement_id, row]));

    return ACHIEVEMENT_DEFINITIONS.map((definition) => {
      const stored = rowById.get(definition.id);
      const computedProgress = computeProgress(definition.id, metrics);
      const unlockedAt = stored?.unlocked_at ?? null;
      const progress = definition.id === 'winning_streak' && unlockedAt === null
        ? computedProgress
        : Math.max(stored?.progress ?? 0, computedProgress);

      return {
        id: definition.id,
        title: definition.title,
        description: definition.description,
        icon: definition.icon,
        progress,
        target: definition.target,
        unlocked: unlockedAt != null || progress >= definition.target,
        unlockedAt,
      };
    });
  },

  /**
   * @param options.occurredAt        Optional backdated unlock/insert timestamp.
   *   Defaults to now(); ONLY the one-time persistent-bot burn-in writer passes
   *   an explicit historical value so a bot's unlocks are dated in the past.
   * @param options.suppressAnalytics When true, no achievement-unlocked
   *   analytics fire (capability matrix: persistent bots stay out of analytics).
   */
  async evaluateForMatch(
    matchId: string,
    userIds: string[],
    matchVariant: AchievementMatchVariant,
    options?: { occurredAt?: Date; suppressAnalytics?: boolean }
  ): Promise<Record<string, AchievementUnlockPayload[]>> {
    const occurredAtIso = options?.occurredAt?.toISOString();
    const uniqueUserIds = [...new Set(userIds)];
    const result: Record<string, AchievementUnlockPayload[]> = {};

    // Batch: fetch all user data in parallel instead of sequentially per user
    const allData = await Promise.all(
      uniqueUserIds.map((userId) =>
        Promise.all([
          achievementsRepo.listForUser(userId),
          achievementsRepo.getMetricsForUser(userId),
        ])
      )
    );

    for (let i = 0; i < uniqueUserIds.length; i++) {
      const userId = uniqueUserIds[i];
      const [rows, metrics] = allData[i];
      const existingById = new Map(rows.map((row) => [row.achievement_id, row]));
      const unlockedForUser: AchievementUnlockPayload[] = [];
      const upsertBatch: Parameters<typeof achievementsRepo.upsertProgress>[0][] = [];

      for (const definition of ACHIEVEMENT_DEFINITIONS) {
        if (!isAchievementEligibleForVariant(definition.id, matchVariant)) {
          continue;
        }
        const existing = existingById.get(definition.id);
        const progress = computeProgress(definition.id, metrics);
        const alreadyUnlocked = existing?.unlocked_at != null;
        const unlockedNow = progress >= definition.target;
        const shouldPersist =
          existing == null
          || progress !== existing.progress
          || (!alreadyUnlocked && unlockedNow);

        if (!shouldPersist) continue;

        const unlockedAt = alreadyUnlocked
          ? existing?.unlocked_at ?? null
          : unlockedNow
            ? occurredAtIso ?? new Date().toISOString()
            : null;

        upsertBatch.push({
          userId,
          achievementId: definition.id,
          progress,
          unlockedAt,
          sourceMatchId: !alreadyUnlocked && unlockedNow ? matchId : null,
          ...(options?.occurredAt ? { occurredAt: options.occurredAt } : {}),
        });

        if (!alreadyUnlocked && unlockedNow && unlockedAt) {
          const payload: AchievementUnlockPayload = {
            id: definition.id,
            title: definition.title,
            description: definition.description,
            icon: definition.icon,
            progress,
            target: definition.target,
            unlocked: true,
            unlockedAt,
          };
          unlockedForUser.push(payload);
          // Analytics stay human-only (capability matrix). Persistent bots
          // unlock silently.
          if (!options?.suppressAnalytics) {
            trackAchievementUnlocked(userId, definition.id, definition.title.en ?? definition.id);
          }
        }
      }

      // Batch upsert all achievements for this user in parallel
      if (upsertBatch.length > 0) {
        await Promise.all(upsertBatch.map((params) => achievementsRepo.upsertProgress(params)));
      }

      result[userId] = unlockedForUser;
    }

    return result;
  },

  async listUnlockedForMatch(matchId: string): Promise<Record<string, AchievementUnlockPayload[]>> {
    const rows = await achievementsRepo.listUnlockedForMatch(matchId);
    const definitionById = new Map(ACHIEVEMENT_DEFINITIONS.map((definition) => [definition.id, definition]));
    const result: Record<string, AchievementUnlockPayload[]> = {};

    for (const row of rows) {
      const definition = definitionById.get(row.achievement_id);
      if (!definition) continue;
      const payload: AchievementUnlockPayload = {
        id: definition.id,
        title: definition.title,
        description: definition.description,
        icon: definition.icon,
        progress: row.progress,
        target: definition.target,
        unlocked: row.unlocked_at != null,
        unlockedAt: row.unlocked_at,
      };
      result[row.user_id] = [...(result[row.user_id] ?? []), payload];
    }

    return result;
  },
};
