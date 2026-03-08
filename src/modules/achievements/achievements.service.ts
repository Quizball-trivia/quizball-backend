import { trackAchievementUnlocked } from '../../core/analytics/game-events.js';
import { achievementsRepo } from './achievements.repo.js';
import { ACHIEVEMENT_DEFINITIONS } from './achievements.definitions.js';
import type {
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
      return Math.min(5, metrics.bestWinStreak);
    case 'multiplayer_master':
      return Math.min(10, metrics.totalWins);
    case 'trophy_collector':
      return Math.min(1, metrics.partyQuizWins);
    default:
      return 0;
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
      const progress = Math.max(stored?.progress ?? 0, computedProgress);
      const unlockedAt = stored?.unlocked_at ?? null;

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

  async evaluateForMatch(matchId: string, userIds: string[]): Promise<Record<string, AchievementUnlockPayload[]>> {
    const uniqueUserIds = [...new Set(userIds)];
    const result: Record<string, AchievementUnlockPayload[]> = {};

    for (const userId of uniqueUserIds) {
      const [rows, metrics] = await Promise.all([
        achievementsRepo.listForUser(userId),
        achievementsRepo.getMetricsForUser(userId),
      ]);
      const existingById = new Map(rows.map((row) => [row.achievement_id, row]));
      const unlockedForUser: AchievementUnlockPayload[] = [];

      for (const definition of ACHIEVEMENT_DEFINITIONS) {
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
            ? new Date().toISOString()
            : null;

        await achievementsRepo.upsertProgress({
          userId,
          achievementId: definition.id,
          progress,
          unlockedAt,
          sourceMatchId: !alreadyUnlocked && unlockedNow ? matchId : null,
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
          trackAchievementUnlocked(userId, definition.id, definition.title);
        }
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
