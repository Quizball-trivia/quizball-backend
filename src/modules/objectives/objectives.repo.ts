import { sql, type TransactionSql } from '../../db/index.js';
import type { Json } from '../../db/types.js';
import { progressionRepo, type GrantXpResult } from '../progression/progression.repo.js';
import { storeRepo } from '../store/store.repo.js';
import type { WalletRow } from '../store/store.types.js';
import type {
  ObjectiveDefinition,
  ObjectiveMatchFact,
  ObjectivePeriod,
  ObjectiveProgressRow,
} from './objectives.types.js';

export interface ObjectivesTransactionRepo {
  ensureProgress(input: {
    userId: string;
    definition: ObjectiveDefinition;
    period: ObjectivePeriod;
  }): Promise<ObjectiveProgressRow>;
  ensureProgressBatch(input: {
    userId: string;
    entries: Array<{ definition: ObjectiveDefinition; period: ObjectivePeriod }>;
  }): Promise<ObjectiveProgressRow[]>;
  insertEventsBatch(input: {
    userId: string;
    eventKey: string;
    entries: Array<{ objectiveId: string; periodStart: Date }>;
  }): Promise<Set<string>>;
  insertEvent(input: {
    userId: string;
    objectiveId: string;
    periodStart: Date;
    eventKey: string;
  }): Promise<boolean>;
  incrementProgress(input: {
    userId: string;
    objectiveId: string;
    periodStart: Date;
    delta: number;
    metadata?: Json;
  }): Promise<ObjectiveProgressRow | null>;
  setProgress(input: {
    userId: string;
    objectiveId: string;
    periodStart: Date;
    progress: number;
    metadata?: Json;
  }): Promise<ObjectiveProgressRow | null>;
  getProgressRows(userId: string, period: ObjectivePeriod): Promise<ObjectiveProgressRow[]>;
  addCoins(userId: string, amount: number): Promise<WalletRow | null>;
  grantXp(input: {
    userId: string;
    sourceKey: string;
    xpDelta: number;
    metadata: Json;
  }): Promise<GrantXpResult>;
  markRewarded(rowId: string): Promise<ObjectiveProgressRow | null>;
  logReward(input: {
    userId: string;
    coinsDelta: number;
    xpDelta: number;
    objectiveId: string;
    periodStart: string;
    idempotencyKey: string;
  }): Promise<void>;
  getRankedWinStreakForPeriod(userId: string, periodStart: Date, periodEnd: Date): Promise<number>;
}

function toIso(value: Date): string {
  return value.toISOString();
}

export const objectivesRepo = {
  runInTransaction<T>(callback: (txRepo: ObjectivesTransactionRepo) => Promise<T>): Promise<T> {
    return sql.begin((tx) => callback({
      ensureProgress: (input) => objectivesRepo.ensureProgressInTx(tx, input),
      ensureProgressBatch: (input) => objectivesRepo.ensureProgressBatchInTx(tx, input),
      insertEvent: (input) => objectivesRepo.insertEventInTx(tx, input),
      insertEventsBatch: (input) => objectivesRepo.insertEventsBatchInTx(tx, input),
      incrementProgress: (input) => objectivesRepo.incrementProgressInTx(tx, input),
      setProgress: (input) => objectivesRepo.setProgressInTx(tx, input),
      getProgressRows: (userId, period) => objectivesRepo.getProgressRowsInTx(tx, userId, period),
      addCoins: (userId, amount) => storeRepo.addCoinsInTx(tx, userId, amount),
      grantXp: (input) => progressionRepo.grantXpInTx(tx, {
        userId: input.userId,
        sourceType: 'objective_reward',
        sourceKey: input.sourceKey,
        xpDelta: input.xpDelta,
        metadata: input.metadata,
      }),
      markRewarded: (rowId) => objectivesRepo.markRewardedInTx(tx, rowId),
      getRankedWinStreakForPeriod: (userId, periodStart, periodEnd) =>
        objectivesRepo.getRankedWinStreakForPeriodInTx(tx, userId, periodStart, periodEnd),
      logReward: (input) => storeRepo.insertTransactionLogInTx(tx, {
        eventType: 'objective_reward_succeeded',
        outcome: 'success',
        userId: input.userId,
        coinsDelta: input.coinsDelta,
        reason: 'objective_reward',
        metadata: {
          objectiveId: input.objectiveId,
          periodStart: input.periodStart,
          xpDelta: input.xpDelta,
        },
        idempotencyKey: input.idempotencyKey,
      }).then(() => undefined),
    })) as Promise<T>;
  },

  async listForUserPeriod(userId: string, period: ObjectivePeriod): Promise<ObjectiveProgressRow[]> {
    return sql<ObjectiveProgressRow[]>`
      SELECT *
      FROM user_objective_progress
      WHERE user_id = ${userId}
        AND period_start = ${period.start}
        AND period_type = ${period.type}
      ORDER BY created_at ASC
    `;
  },

  async ensureProgressInTx(
    tx: TransactionSql,
    input: {
      userId: string;
      definition: ObjectiveDefinition;
      period: ObjectivePeriod;
    }
  ): Promise<ObjectiveProgressRow> {
    const [row] = await tx.unsafe<ObjectiveProgressRow[]>(
      `
      INSERT INTO user_objective_progress (
        user_id,
        objective_id,
        period_type,
        period_start,
        period_end,
        progress,
        target,
        reward_coins,
        reward_xp,
        metadata
      )
      VALUES ($1, $2, $3, $4, $5, 0, $6, $7, $8, '{}'::jsonb)
      ON CONFLICT (user_id, objective_id, period_start)
      DO UPDATE SET updated_at = user_objective_progress.updated_at
      RETURNING *
      `,
      [
        input.userId,
        input.definition.id,
        input.definition.periodType,
        toIso(input.period.start),
        toIso(input.period.end),
        input.definition.target,
        input.definition.rewardCoins,
        input.definition.rewardXp,
      ]
    );
    return row;
  },

  /**
   * Batched ensureProgress: one multi-row INSERT via unnest instead of one
   * round-trip per definition (db-optimize.md #5 — the per-match objectives
   * write storm was N players x M definitions individual upserts).
   * ON CONFLICT keeps the no-op update so every row is RETURNed whether it
   * was inserted or already existed.
   */
  async ensureProgressBatchInTx(
    tx: TransactionSql,
    input: {
      userId: string;
      entries: Array<{ definition: ObjectiveDefinition; period: ObjectivePeriod }>;
    }
  ): Promise<ObjectiveProgressRow[]> {
    if (input.entries.length === 0) return [];
    return tx.unsafe<ObjectiveProgressRow[]>(
      `
      INSERT INTO user_objective_progress (
        user_id,
        objective_id,
        period_type,
        period_start,
        period_end,
        progress,
        target,
        reward_coins,
        reward_xp,
        metadata
      )
      SELECT $1, t.objective_id, t.period_type, t.period_start, t.period_end, 0, t.target, t.reward_coins, t.reward_xp, '{}'::jsonb
      FROM unnest(
        $2::text[],
        $3::text[],
        $4::timestamptz[],
        $5::timestamptz[],
        $6::int[],
        $7::int[],
        $8::int[]
      ) AS t(objective_id, period_type, period_start, period_end, target, reward_coins, reward_xp)
      ON CONFLICT (user_id, objective_id, period_start)
      DO UPDATE SET updated_at = user_objective_progress.updated_at
      RETURNING *
      `,
      [
        input.userId,
        input.entries.map((entry) => entry.definition.id),
        input.entries.map((entry) => entry.definition.periodType),
        input.entries.map((entry) => toIso(entry.period.start)),
        input.entries.map((entry) => toIso(entry.period.end)),
        input.entries.map((entry) => entry.definition.target),
        input.entries.map((entry) => entry.definition.rewardCoins),
        input.entries.map((entry) => entry.definition.rewardXp),
      ]
    );
  },

  /**
   * Batched insertEvent for one shared event key (e.g. match:<id>): single
   * multi-row INSERT .. ON CONFLICT DO NOTHING. Returns the objective_ids
   * whose event was NEWLY inserted (i.e. not already counted).
   */
  async insertEventsBatchInTx(
    tx: TransactionSql,
    input: {
      userId: string;
      eventKey: string;
      entries: Array<{ objectiveId: string; periodStart: Date }>;
    }
  ): Promise<Set<string>> {
    if (input.entries.length === 0) return new Set();
    const rows = await tx.unsafe<Array<{ objective_id: string }>>(
      `
      INSERT INTO user_objective_events (user_id, objective_id, period_start, event_key)
      SELECT $1, t.objective_id, t.period_start, $4
      FROM unnest($2::text[], $3::timestamptz[]) AS t(objective_id, period_start)
      ON CONFLICT (user_id, objective_id, period_start, event_key) DO NOTHING
      RETURNING objective_id
      `,
      [
        input.userId,
        input.entries.map((entry) => entry.objectiveId),
        input.entries.map((entry) => toIso(entry.periodStart)),
        input.eventKey,
      ]
    );
    return new Set(rows.map((row) => row.objective_id));
  },

  async insertEventInTx(
    tx: TransactionSql,
    input: {
      userId: string;
      objectiveId: string;
      periodStart: Date;
      eventKey: string;
    }
  ): Promise<boolean> {
    const rows = await tx.unsafe<Array<{ id: string }>>(
      `
      INSERT INTO user_objective_events (user_id, objective_id, period_start, event_key)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (user_id, objective_id, period_start, event_key) DO NOTHING
      RETURNING id
      `,
      [input.userId, input.objectiveId, toIso(input.periodStart), input.eventKey]
    );
    return rows.length > 0;
  },

  async incrementProgressInTx(
    tx: TransactionSql,
    input: {
      userId: string;
      objectiveId: string;
      periodStart: Date;
      delta: number;
      metadata?: Json;
    }
  ): Promise<ObjectiveProgressRow | null> {
    const [row] = await tx.unsafe<ObjectiveProgressRow[]>(
      `
      UPDATE user_objective_progress
      SET
        progress = LEAST(target, progress + $4),
        completed_at = CASE
          WHEN completed_at IS NULL AND LEAST(target, progress + $4) >= target THEN NOW()
          ELSE completed_at
        END,
        metadata = COALESCE($5::jsonb, metadata),
        updated_at = NOW()
      WHERE user_id = $1
        AND objective_id = $2
        AND period_start = $3
      RETURNING *
      `,
      [
        input.userId,
        input.objectiveId,
        toIso(input.periodStart),
        input.delta,
        input.metadata === undefined ? null : JSON.stringify(input.metadata),
      ]
    );
    return row ?? null;
  },

  async setProgressInTx(
    tx: TransactionSql,
    input: {
      userId: string;
      objectiveId: string;
      periodStart: Date;
      progress: number;
      metadata?: Json;
    }
  ): Promise<ObjectiveProgressRow | null> {
    const [row] = await tx.unsafe<ObjectiveProgressRow[]>(
      `
      UPDATE user_objective_progress
      SET
        progress = LEAST(target, GREATEST(progress, $4)),
        completed_at = CASE
          WHEN completed_at IS NULL AND LEAST(target, GREATEST(progress, $4)) >= target THEN NOW()
          ELSE completed_at
        END,
        metadata = COALESCE($5::jsonb, metadata),
        updated_at = NOW()
      WHERE user_id = $1
        AND objective_id = $2
        AND period_start = $3
      RETURNING *
      `,
      [
        input.userId,
        input.objectiveId,
        toIso(input.periodStart),
        input.progress,
        input.metadata === undefined ? null : JSON.stringify(input.metadata),
      ]
    );
    return row ?? null;
  },

  async getProgressRowsInTx(
    tx: TransactionSql,
    userId: string,
    period: ObjectivePeriod
  ): Promise<ObjectiveProgressRow[]> {
    return tx.unsafe<ObjectiveProgressRow[]>(
      `
      SELECT *
      FROM user_objective_progress
      WHERE user_id = $1
        AND period_type = $2
        AND period_start = $3
      `,
      [userId, period.type, toIso(period.start)]
    );
  },

  async markRewardedInTx(tx: TransactionSql, rowId: string): Promise<ObjectiveProgressRow | null> {
    const [row] = await tx.unsafe<ObjectiveProgressRow[]>(
      `
      UPDATE user_objective_progress
      SET rewarded_at = COALESCE(rewarded_at, NOW()),
          updated_at = NOW()
      WHERE id = $1
        AND completed_at IS NOT NULL
        AND rewarded_at IS NULL
      RETURNING *
      `,
      [rowId]
    );
    return row ?? null;
  },

  async getMatchFacts(matchId: string): Promise<ObjectiveMatchFact[]> {
    const rows = await sql<Array<{
      match_id: string;
      user_id: string;
      opponent_user_id: string | null;
      mode: 'friendly' | 'ranked';
      variant: 'friendly_possession' | 'friendly_party_quiz' | 'ranked_sim' | null;
      winner_user_id: string | null;
      correct_answers: number;
      goals: number;
      goals_against: number;
      penalty_goals_against: number;
      is_dev: boolean;
      is_ai: boolean;
      second_half_goals: number;
      played_with_friend: boolean;
      category_correct: Json;
    }>>`
      WITH match_base AS (
        SELECT
          m.*,
          COALESCE(m.state_payload->>'variant', CASE WHEN m.mode = 'ranked' THEN 'ranked_sim' ELSE 'friendly_possession' END) AS variant
        FROM matches m
        WHERE m.id = ${matchId}
          AND m.status = 'completed'
      ),
      player_rows AS (
        SELECT
          mp.*,
          u.is_ai,
          (
            SELECT mp_opp.user_id
            FROM match_players mp_opp
            WHERE mp_opp.match_id = mp.match_id
              AND mp_opp.user_id <> mp.user_id
            ORDER BY mp_opp.seat ASC
            LIMIT 1
          ) AS opponent_user_id
        FROM match_players mp
        JOIN users u ON u.id = mp.user_id
        JOIN match_base mb ON mb.id = mp.match_id
      )
      SELECT
        mb.id AS match_id,
        pr.user_id,
        pr.opponent_user_id,
        mb.mode,
        mb.variant::text AS variant,
        mb.winner_user_id,
        pr.correct_answers,
        pr.goals,
        COALESCE((
          SELECT SUM(mp_opp.goals)::int
          FROM match_players mp_opp
          WHERE mp_opp.match_id = pr.match_id
            AND mp_opp.user_id <> pr.user_id
        ), 0) AS goals_against,
        COALESCE((
          SELECT SUM(mp_opp.penalty_goals)::int
          FROM match_players mp_opp
          WHERE mp_opp.match_id = pr.match_id
            AND mp_opp.user_id <> pr.user_id
        ), 0) AS penalty_goals_against,
        mb.is_dev,
        pr.is_ai,
        COALESCE((
          SELECT COUNT(*)::int
          FROM match_goal_events mge
          WHERE mge.match_id = mb.id
            AND mge.user_id = pr.user_id
            AND mge.half = 2
            AND mge.is_penalty = false
        ), 0) AS second_half_goals,
        COALESCE((
          SELECT EXISTS (
            SELECT 1
            FROM friendships f
            WHERE pr.opponent_user_id IS NOT NULL
              AND f.user_low_id = LEAST(pr.user_id, pr.opponent_user_id)
              AND f.user_high_id = GREATEST(pr.user_id, pr.opponent_user_id)
          )
        ), false) AS played_with_friend,
        COALESCE((
          SELECT jsonb_object_agg(category_id, jsonb_build_object('name', category_name, 'count', correct_count))
          FROM (
            SELECT
              mq.category_id::text AS category_id,
              COALESCE(c.name->>'en', c.slug, mq.category_id::text) AS category_name,
              COUNT(*)::int AS correct_count
            FROM match_answers ma
            JOIN match_questions mq ON mq.match_id = ma.match_id AND mq.q_index = ma.q_index
            JOIN categories c ON c.id = mq.category_id
            WHERE ma.match_id = mb.id
              AND ma.user_id = pr.user_id
              AND ma.is_correct = true
            GROUP BY mq.category_id, c.name, c.slug
          ) category_counts
        ), '{}'::jsonb) AS category_correct
      FROM match_base mb
      JOIN player_rows pr ON pr.match_id = mb.id
      ORDER BY pr.seat ASC
    `;

    return rows.map((row) => {
      const rawCategoryCorrect = row.category_correct && typeof row.category_correct === 'object' && !Array.isArray(row.category_correct)
        ? row.category_correct as Record<string, { name?: unknown; count?: unknown }>
        : {};
      const correctByCategory: ObjectiveMatchFact['correctByCategory'] = {};
      for (const [categoryId, value] of Object.entries(rawCategoryCorrect)) {
        correctByCategory[categoryId] = {
          name: typeof value.name === 'string' ? value.name : categoryId,
          count: typeof value.count === 'number' ? value.count : Number(value.count ?? 0),
        };
      }

      return {
        matchId: row.match_id,
        userId: row.user_id,
        opponentUserId: row.opponent_user_id,
        mode: row.mode,
        variant: row.variant ?? (row.mode === 'ranked' ? 'ranked_sim' : 'friendly_possession'),
        isWinner: row.winner_user_id === row.user_id,
        correctAnswers: row.correct_answers,
        goalsFor: row.goals,
        goalsAgainst: row.goals_against,
        penaltyGoalsAgainst: row.penalty_goals_against,
        isDev: row.is_dev,
        isAi: row.is_ai,
        secondHalfGoals: row.second_half_goals,
        correctByCategory,
        playedWithFriend: row.played_with_friend,
      };
    });
  },

  async getRankedWinStreakForPeriod(
    userId: string,
    periodStart: Date,
    periodEnd: Date
  ): Promise<number> {
    const [row] = await sql<{ best_win_streak: number }[]>`
      SELECT COALESCE(MAX(streak_len), 0)::int AS best_win_streak
      FROM (
        SELECT COUNT(*) AS streak_len
        FROM (
          SELECT
            m.winner_user_id,
            SUM(CASE WHEN m.winner_user_id <> ${userId} OR m.winner_user_id IS NULL THEN 1 ELSE 0 END)
              OVER (ORDER BY COALESCE(m.ended_at, m.started_at) ASC, m.id ASC) AS grp
          FROM matches m
          JOIN match_players mp ON mp.match_id = m.id AND mp.user_id = ${userId}
          JOIN users u ON u.id = mp.user_id
          WHERE m.status = 'completed'
            AND m.mode = 'ranked'
            AND m.is_dev = false
            AND u.is_ai = false
            AND COALESCE(m.ended_at, m.started_at) >= ${periodStart}
            AND COALESCE(m.ended_at, m.started_at) < ${periodEnd}
        ) sub
        WHERE winner_user_id = ${userId}
        GROUP BY grp
      ) streaks
    `;
    return row?.best_win_streak ?? 0;
  },

  async getRankedWinStreakForPeriodInTx(
    tx: TransactionSql,
    userId: string,
    periodStart: Date,
    periodEnd: Date
  ): Promise<number> {
    const [row] = await tx.unsafe<{ best_win_streak: number }[]>(
      `
      SELECT COALESCE(MAX(streak_len), 0)::int AS best_win_streak
      FROM (
        SELECT COUNT(*) AS streak_len
        FROM (
          SELECT
            m.winner_user_id,
            SUM(CASE WHEN m.winner_user_id <> $1 OR m.winner_user_id IS NULL THEN 1 ELSE 0 END)
              OVER (ORDER BY COALESCE(m.ended_at, m.started_at) ASC, m.id ASC) AS grp
          FROM matches m
          JOIN match_players mp ON mp.match_id = m.id AND mp.user_id = $1
          JOIN users u ON u.id = mp.user_id
          WHERE m.status = 'completed'
            AND m.mode = 'ranked'
            AND m.is_dev = false
            AND u.is_ai = false
            AND COALESCE(m.ended_at, m.started_at) >= $2
            AND COALESCE(m.ended_at, m.started_at) < $3
        ) sub
        WHERE winner_user_id = $1
        GROUP BY grp
      ) streaks
      `,
      [userId, periodStart.toISOString(), periodEnd.toISOString()]
    );
    return row?.best_win_streak ?? 0;
  },
};
