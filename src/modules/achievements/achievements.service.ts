import { type TransactionSql } from '../../db/index.js';
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
   * @param options.tx                Optional caller-provided transaction. When
   *   set, all repo reads/writes run against this transaction connection
   *   instead of the pooled `sql`, and batches that would otherwise run in
   *   parallel are run sequentially (a single postgres.js transaction
   *   connection cannot execute concurrent queries).
   */
  async evaluateForMatch(
    matchId: string,
    userIds: string[],
    matchVariant: AchievementMatchVariant,
    options?: { occurredAt?: Date; suppressAnalytics?: boolean; tx?: TransactionSql }
  ): Promise<Record<string, AchievementUnlockPayload[]>> {
    const occurredAtIso = options?.occurredAt?.toISOString();
    // The repo executor param is typed as `typeof sql`; TransactionSql exposes
    // the same tagged-template call convention but TS can't express the union
    // (documented in matches.repo.ts). Pass the caller tx through untyped — the
    // repo runs it as a tagged template either way.
    const txExec = options?.tx as unknown as Parameters<typeof achievementsRepo.listForUser>[1];
    const uniqueUserIds = [...new Set(userIds)];
    const result: Record<string, AchievementUnlockPayload[]> = {};

    // Batch: fetch all user data in parallel instead of sequentially per user
    // (unless running inside a caller-provided tx, which can't run concurrent queries)
    const allData = options?.tx
      ? await (async () => {
          const data: [Awaited<ReturnType<typeof achievementsRepo.listForUser>>, Awaited<ReturnType<typeof achievementsRepo.getMetricsForUser>>][] = [];
          for (const userId of uniqueUserIds) {
            data.push([
              await achievementsRepo.listForUser(userId, txExec),
              await achievementsRepo.getMetricsForUser(userId, txExec),
            ]);
          }
          return data;
        })()
      : await Promise.all(
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
      // (sequentially when running inside a caller-provided tx)
      if (upsertBatch.length > 0) {
        if (options?.tx) {
          for (const params of upsertBatch) {
            await achievementsRepo.upsertProgress(params, txExec);
          }
        } else {
          await Promise.all(upsertBatch.map((params) => achievementsRepo.upsertProgress(params)));
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
