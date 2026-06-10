import { config } from '../../core/config.js';
import { logger } from '../../core/logger.js';
import type { Json } from '../../db/types.js';
import {
  ACTIVE_OBJECTIVE_DEFINITIONS,
  PRIMARY_DAILY_OBJECTIVE_IDS,
} from './objectives.definitions.js';
import { objectivesRepo, type ObjectivesTransactionRepo } from './objectives.repo.js';
import type {
  ObjectiveDefinition,
  ObjectiveMatchFact,
  ObjectivePeriod,
  ObjectiveProgressRow,
} from './objectives.types.js';
import type {
  ObjectiveProgressResponse,
  ObjectivesResponse,
} from './objectives.schemas.js';

const DAILY_MS = 24 * 60 * 60 * 1000;
const WEEKLY_MS = 7 * DAILY_MS;

function getUtcDayPeriod(now = new Date()): ObjectivePeriod {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return {
    type: 'daily',
    start,
    end: new Date(start.getTime() + DAILY_MS),
  };
}

function getUtcWeekPeriod(now = new Date()): ObjectivePeriod {
  const day = getUtcDayPeriod(now).start;
  const dayOfWeek = day.getUTCDay();
  const daysSinceMonday = (dayOfWeek + 6) % 7;
  const start = new Date(day.getTime() - daysSinceMonday * DAILY_MS);
  return {
    type: 'weekly',
    start,
    end: new Date(start.getTime() + WEEKLY_MS),
  };
}

function definitionById(): Map<string, ObjectiveDefinition> {
  return new Map(ACTIVE_OBJECTIVE_DEFINITIONS.map((definition) => [definition.id, definition]));
}

function getDefinitionsForPeriod(period: ObjectivePeriod): ObjectiveDefinition[] {
  return ACTIVE_OBJECTIVE_DEFINITIONS.filter((definition) => definition.periodType === period.type);
}

function getMissingDefinitions(
  definitions: ObjectiveDefinition[],
  rows: ObjectiveProgressRow[]
): ObjectiveDefinition[] {
  const existingObjectiveIds = new Set(rows.map((row) => row.objective_id));
  return definitions.filter((definition) => !existingObjectiveIds.has(definition.id));
}

function getPeriodForDefinition(definition: ObjectiveDefinition, now = new Date()): ObjectivePeriod {
  return definition.periodType === 'daily' ? getUtcDayPeriod(now) : getUtcWeekPeriod(now);
}

function toResponse(row: ObjectiveProgressRow, definition: ObjectiveDefinition): ObjectiveProgressResponse {
  const metadata = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
    ? row.metadata as ObjectiveProgressResponse['metadata']
    : undefined;

  return {
    id: definition.id,
    periodType: definition.periodType,
    title: definition.title,
    description: definition.description,
    icon: definition.icon,
    progress: row.progress,
    target: row.target,
    completed: row.completed_at != null,
    rewarded: row.rewarded_at != null,
    completedAt: row.completed_at,
    rewardedAt: row.rewarded_at,
    rewardCoins: row.reward_coins,
    rewardXp: row.reward_xp,
    ...(metadata ? { metadata } : {}),
  };
}

function buildPeriodResponse(
  period: ObjectivePeriod,
  rows: ObjectiveProgressRow[],
  definitions: ObjectiveDefinition[]
) {
  const rowsByObjective = new Map(rows.map((row) => [row.objective_id, row]));
  const objectives = definitions.flatMap((definition) => {
    const row = rowsByObjective.get(definition.id);
    return row ? [toResponse(row, definition)] : [];
  });
  return {
    periodStart: period.start.toISOString(),
    periodEnd: period.end.toISOString(),
    completedCount: objectives.filter((objective) => objective.completed).length,
    totalCount: objectives.length,
    objectives,
  };
}

function readCategoryProgress(metadata: Json): Record<string, number> {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return {};
  }
  const raw = (metadata as Record<string, unknown>).categoryProgress;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }
  const result: Record<string, number> = {};
  for (const [categoryId, value] of Object.entries(raw)) {
    const numeric = typeof value === 'number' ? value : Number(value);
    if (Number.isFinite(numeric) && numeric > 0) {
      result[categoryId] = Math.floor(numeric);
    }
  }
  return result;
}

function mergeCategoryProgress(
  row: ObjectiveProgressRow,
  fact: ObjectiveMatchFact
): { progress: number; metadata: Json } {
  const categoryProgress = readCategoryProgress(row.metadata);
  for (const [categoryId, value] of Object.entries(fact.correctByCategory)) {
    categoryProgress[categoryId] = (categoryProgress[categoryId] ?? 0) + value.count;
  }

  let leadingCategoryId: string | undefined;
  let leadingCategoryName: string | undefined;
  let leadingProgress = 0;
  for (const [categoryId, progress] of Object.entries(categoryProgress)) {
    if (progress > leadingProgress) {
      leadingProgress = progress;
      leadingCategoryId = categoryId;
      leadingCategoryName = fact.correctByCategory[categoryId]?.name
        ?? (row.metadata as Record<string, unknown> | null)?.leadingCategoryName as string | undefined
        ?? categoryId;
    }
  }

  return {
    progress: leadingProgress,
    metadata: {
      categoryProgress,
      ...(leadingCategoryId ? { leadingCategoryId } : {}),
      ...(leadingCategoryName ? { leadingCategoryName } : {}),
    },
  };
}

async function grantRewardIfNeeded(
  txRepo: ObjectivesTransactionRepo,
  row: ObjectiveProgressRow
): Promise<ObjectiveProgressRow> {
  if (!row.completed_at || row.rewarded_at) {
    return row;
  }

  const marked = await txRepo.markRewarded(row.id);
  if (!marked) {
    return row;
  }

  // postgres.js deserializes timestamptz to Date at runtime even though the
  // row type claims `string`. Normalize to ISO so the source key, idempotency
  // key, and metadata are deterministic across calls and locales.
  const periodStartIso = new Date(row.period_start as unknown as string | Date).toISOString();
  const sourceKey = `${row.objective_id}:${periodStartIso}`;
  if (row.reward_coins > 0) {
    await txRepo.addCoins(row.user_id, row.reward_coins);
  }
  if (row.reward_xp > 0) {
    await txRepo.grantXp({
      userId: row.user_id,
      sourceKey,
      xpDelta: row.reward_xp,
      metadata: {
        objectiveId: row.objective_id,
        periodType: row.period_type,
        periodStart: periodStartIso,
      },
    });
  }
  await txRepo.logReward({
    userId: row.user_id,
    coinsDelta: row.reward_coins,
    xpDelta: row.reward_xp,
    objectiveId: row.objective_id,
    periodStart: periodStartIso,
    idempotencyKey: `objective:${sourceKey}`,
  });

  return marked;
}

function getDeltaForFact(definition: ObjectiveDefinition, fact: ObjectiveMatchFact): number {
  if (fact.isDev || fact.isAi) return 0;

  switch (definition.rule.type) {
    case 'online_matches_completed':
      return 1;
    case 'correct_answers':
      return fact.correctAnswers;
    case 'second_half_goal':
      return fact.secondHalfGoals > 0 ? 1 : 0;
    case 'clean_sheet':
      return fact.variant !== 'friendly_party_quiz'
        && fact.goalsAgainst === 0
        && fact.penaltyGoalsAgainst === 0
        ? 1
        : 0;
    case 'ranked_wins':
      return fact.mode === 'ranked' && fact.isWinner ? 1 : 0;
    case 'friend_custom_match':
      return fact.mode === 'friendly' && fact.playedWithFriend ? 1 : 0;
    default:
      return 0;
  }
}

async function processDailyCompleteAll(
  txRepo: ObjectivesTransactionRepo,
  userId: string,
  now: Date
): Promise<void> {
  const dailyPeriod = getUtcDayPeriod(now);
  const weeklyPeriod = getUtcWeekPeriod(now);
  const definitions = definitionById();
  const completeAllDefinition = definitions.get('daily_complete_all');
  const weeklyDailiesDefinition = definitions.get('weekly_complete_dailies_5_times');
  if (!completeAllDefinition || !weeklyDailiesDefinition) return;

  await txRepo.ensureProgress({ userId, definition: completeAllDefinition, period: dailyPeriod });
  const rows = await txRepo.getProgressRows(userId, dailyPeriod);
  const completedPrimaryCount = PRIMARY_DAILY_OBJECTIVE_IDS.filter((objectiveId) =>
    rows.some((row) => row.objective_id === objectiveId && row.completed_at != null)
  ).length;

  const dailyCompleteRow = await txRepo.setProgress({
    userId,
    objectiveId: completeAllDefinition.id,
    periodStart: dailyPeriod.start,
    progress: completedPrimaryCount,
  });
  if (dailyCompleteRow) {
    await grantRewardIfNeeded(txRepo, dailyCompleteRow);
  }

  if (completedPrimaryCount < PRIMARY_DAILY_OBJECTIVE_IDS.length) {
    return;
  }

  await txRepo.ensureProgress({ userId, definition: weeklyDailiesDefinition, period: weeklyPeriod });
  const eventInserted = await txRepo.insertEvent({
    userId,
    objectiveId: weeklyDailiesDefinition.id,
    periodStart: weeklyPeriod.start,
    eventKey: `daily-complete:${dailyPeriod.start.toISOString().slice(0, 10)}`,
  });
  if (!eventInserted) return;

  const weeklyRow = await txRepo.incrementProgress({
    userId,
    objectiveId: weeklyDailiesDefinition.id,
    periodStart: weeklyPeriod.start,
    delta: 1,
  });
  if (weeklyRow) {
    await grantRewardIfNeeded(txRepo, weeklyRow);
  }
}

export const objectivesService = {
  getUtcDayPeriod,
  getUtcWeekPeriod,

  async listForUser(userId: string): Promise<ObjectivesResponse> {
    const now = new Date();
    const dailyPeriod = getUtcDayPeriod(now);
    const weeklyPeriod = getUtcWeekPeriod(now);
    const dailyDefinitions = getDefinitionsForPeriod(dailyPeriod);
    const weeklyDefinitions = getDefinitionsForPeriod(weeklyPeriod);

    // Objectives kill-switch: when disabled, never touch the DB. Return the
    // definitions as "not started" (empty rows) so the (hidden) UI stays valid
    // without running 4 reads + a write transaction per call for a feature we
    // are not using. Pairs with the existing award-path gate.
    if (!config.OBJECTIVES_ENABLED) {
      return {
        daily: buildPeriodResponse(dailyPeriod, [], dailyDefinitions),
        weekly: buildPeriodResponse(weeklyPeriod, [], weeklyDefinitions),
      };
    }

    let [dailyRows, weeklyRows] = await Promise.all([
      objectivesRepo.listForUserPeriod(userId, dailyPeriod),
      objectivesRepo.listForUserPeriod(userId, weeklyPeriod),
    ]);

    const missingDailyDefinitions = getMissingDefinitions(dailyDefinitions, dailyRows);
    const missingWeeklyDefinitions = getMissingDefinitions(weeklyDefinitions, weeklyRows);
    if (missingDailyDefinitions.length > 0 || missingWeeklyDefinitions.length > 0) {
      await objectivesRepo.runInTransaction(async (txRepo) => {
        for (const definition of missingDailyDefinitions) {
          await txRepo.ensureProgress({ userId, definition, period: dailyPeriod });
        }
        for (const definition of missingWeeklyDefinitions) {
          await txRepo.ensureProgress({ userId, definition, period: weeklyPeriod });
        }
      });
      [dailyRows, weeklyRows] = await Promise.all([
        objectivesRepo.listForUserPeriod(userId, dailyPeriod),
        objectivesRepo.listForUserPeriod(userId, weeklyPeriod),
      ]);
    }

    return {
      daily: buildPeriodResponse(dailyPeriod, dailyRows, dailyDefinitions),
      weekly: buildPeriodResponse(weeklyPeriod, weeklyRows, weeklyDefinitions),
    };
  },

  async evaluateForMatch(matchId: string): Promise<Record<string, ObjectiveProgressResponse[]>> {
    const facts = await objectivesRepo.getMatchFacts(matchId);
    if (facts.length === 0) {
      return {};
    }

    const now = new Date();
    const definitions = ACTIVE_OBJECTIVE_DEFINITIONS.filter((definition) =>
      definition.rule.type !== 'complete_all_daily'
      && definition.rule.type !== 'complete_daily_sets'
    );
    const completedByUser: Record<string, ObjectiveProgressResponse[]> = {};

    await objectivesRepo.runInTransaction(async (txRepo) => {
      for (const fact of facts) {
        // One multi-row upsert covers ensureCurrentRows AND the per-definition
        // ensureProgress below (db-optimize.md #5: this loop used to issue
        // ~2 x M individual INSERT .. ON CONFLICT per player per match).
        const ensuredRows = await txRepo.ensureProgressBatch({
          userId: fact.userId,
          entries: ACTIVE_OBJECTIVE_DEFINITIONS.map((definition) => ({
            definition,
            period: getPeriodForDefinition(definition, now),
          })),
        });
        const progressByObjectiveId = new Map(ensuredRows.map((row) => [row.objective_id, row]));

        // One multi-row insert for this match's event markers; the returned
        // set tells which definitions have NOT yet counted this match.
        const eventKey = `match:${matchId}`;
        const newlyInsertedEvents = await txRepo.insertEventsBatch({
          userId: fact.userId,
          eventKey,
          entries: definitions
            .filter((definition) => definition.rule.type !== 'ranked_win_streak')
            .map((definition) => ({
              objectiveId: definition.id,
              periodStart: getPeriodForDefinition(definition, now).start,
            })),
        });

        for (const definition of definitions) {
          const period = getPeriodForDefinition(definition, now);
          const progressRow = progressByObjectiveId.get(definition.id);
          if (!progressRow) continue;

          if (definition.rule.type === 'ranked_win_streak') {
            const streak = await txRepo.getRankedWinStreakForPeriod(fact.userId, period.start, period.end);
            const row = await txRepo.setProgress({
              userId: fact.userId,
              objectiveId: definition.id,
              periodStart: period.start,
              progress: streak,
            });
            if (row) {
              const rewarded = await grantRewardIfNeeded(txRepo, row);
              if (row.completed_at && !progressRow.completed_at) {
                completedByUser[fact.userId] = [
                  ...(completedByUser[fact.userId] ?? []),
                  toResponse(rewarded, definition),
                ];
              }
            }
            continue;
          }

          if (!newlyInsertedEvents.has(definition.id)) continue;

          let row: ObjectiveProgressRow | null = null;
          if (definition.rule.type === 'correct_answers_single_category') {
            const merged = mergeCategoryProgress(progressRow, fact);
            row = await txRepo.setProgress({
              userId: fact.userId,
              objectiveId: definition.id,
              periodStart: period.start,
              progress: merged.progress,
              metadata: merged.metadata,
            });
          } else {
            const delta = getDeltaForFact(definition, fact);
            if (delta <= 0) continue;
            row = await txRepo.incrementProgress({
              userId: fact.userId,
              objectiveId: definition.id,
              periodStart: period.start,
              delta,
            });
          }

          if (!row) continue;
          const wasCompleted = progressRow.completed_at != null;
          const rewarded = await grantRewardIfNeeded(txRepo, row);
          if (!wasCompleted && rewarded.completed_at) {
            completedByUser[fact.userId] = [
              ...(completedByUser[fact.userId] ?? []),
              toResponse(rewarded, definition),
            ];
          }
        }

        await processDailyCompleteAll(txRepo, fact.userId, now);
      }
    });

    return completedByUser;
  },

  async evaluateForMatchBestEffort(matchId: string): Promise<void> {
    // Objectives feature kill-switch: when disabled, skip all progress and
    // reward (coins/XP) granting. Pairs with hiding the Objectives UI on the
    // frontend so a hidden feature can't keep paying out in the background.
    if (!config.OBJECTIVES_ENABLED) {
      return;
    }
    try {
      await this.evaluateForMatch(matchId);
    } catch (error) {
      logger.warn({ error, matchId }, 'Objective evaluation failed after match completion');
    }
  },
};
