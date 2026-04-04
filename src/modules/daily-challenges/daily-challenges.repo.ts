import { sql, type TransactionSql } from '../../db/index.js';
import type { Json } from '../../db/types.js';
import { progressionRepo, type GrantXpInput, type GrantXpResult } from '../progression/progression.repo.js';
import { storeRepo } from '../store/store.repo.js';
import type { WalletRow } from '../store/store.types.js';
import type {
  DailyChallengeCompletionRow,
  DailyChallengeConfigRow,
  DailyChallengeType,
  QuestionContentRow,
} from './daily-challenges.types.js';

export interface DailyChallengesTransactionRepo {
  getCompletionForUserOnDay(
    userId: string,
    challengeType: DailyChallengeType,
    challengeDay: string
  ): Promise<DailyChallengeCompletionRow | null>;
  createCompletion(input: {
    userId: string;
    challengeType: DailyChallengeType;
    challengeDay: string;
    score: number;
    coinsAwarded: number;
    xpAwarded: number;
  }): Promise<DailyChallengeCompletionRow>;
  addCoins(userId: string, amount: number): Promise<WalletRow | null>;
  grantXp(input: GrantXpInput): Promise<GrantXpResult>;
}

export const dailyChallengesRepo = {
  runInTransaction<T>(callback: (txRepo: DailyChallengesTransactionRepo) => Promise<T>): Promise<T> {
    return sql.begin((tx) => callback({
      getCompletionForUserOnDay: (userId, challengeType, challengeDay) =>
        dailyChallengesRepo.getCompletionForUserOnDayInTx(tx, userId, challengeType, challengeDay),
      createCompletion: (input) => dailyChallengesRepo.createCompletionInTx(tx, input),
      addCoins: (userId, amount) => storeRepo.addCoinsInTx(tx, userId, amount),
      grantXp: (input) => progressionRepo.grantXpInTx(tx, input),
    })) as Promise<T>;
  },

  async listConfigs(activeOnly = false): Promise<DailyChallengeConfigRow[]> {
    return sql<DailyChallengeConfigRow[]>`
      SELECT *
      FROM daily_challenge_configs
      WHERE (${activeOnly}::boolean = false OR is_active = true)
      ORDER BY sort_order ASC, created_at ASC
    `;
  },

  async getConfig(challengeType: DailyChallengeType): Promise<DailyChallengeConfigRow | null> {
    const [row] = await sql<DailyChallengeConfigRow[]>`
      SELECT *
      FROM daily_challenge_configs
      WHERE challenge_type = ${challengeType}
      LIMIT 1
    `;
    return row ?? null;
  },

  async upsertConfig(input: {
    challengeType: DailyChallengeType;
    isActive: boolean;
    sortOrder: number;
    showOnHome: boolean;
    coinReward: number;
    xpReward: number;
    settings: unknown;
  }): Promise<DailyChallengeConfigRow> {
    const [row] = await sql<DailyChallengeConfigRow[]>`
      INSERT INTO daily_challenge_configs (
        challenge_type,
        is_active,
        sort_order,
        show_on_home,
        coin_reward,
        xp_reward,
        settings
      )
      VALUES (
        ${input.challengeType},
        ${input.isActive},
        ${input.sortOrder},
        ${input.showOnHome},
        ${input.coinReward},
        ${input.xpReward},
        ${sql.json(input.settings as Json)}
      )
      ON CONFLICT (challenge_type)
      DO UPDATE SET
        is_active = EXCLUDED.is_active,
        sort_order = EXCLUDED.sort_order,
        show_on_home = EXCLUDED.show_on_home,
        coin_reward = EXCLUDED.coin_reward,
        xp_reward = EXCLUDED.xp_reward,
        settings = EXCLUDED.settings,
        updated_at = NOW()
      RETURNING *
    `;
    return row;
  },

  async listCompletionsForUserOnDay(
    userId: string,
    challengeDay: string
  ): Promise<DailyChallengeCompletionRow[]> {
    return sql<DailyChallengeCompletionRow[]>`
      SELECT *
      FROM daily_challenge_completions
      WHERE user_id = ${userId}
        AND challenge_day = ${challengeDay}
    `;
  },

  async getCompletionForUserOnDay(
    userId: string,
    challengeType: DailyChallengeType,
    challengeDay: string
  ): Promise<DailyChallengeCompletionRow | null> {
    const [row] = await sql<DailyChallengeCompletionRow[]>`
      SELECT *
      FROM daily_challenge_completions
      WHERE user_id = ${userId}
        AND challenge_type = ${challengeType}
        AND challenge_day = ${challengeDay}
      LIMIT 1
    `;
    return row ?? null;
  },

  async getCompletionForUserOnDayInTx(
    tx: TransactionSql,
    userId: string,
    challengeType: DailyChallengeType,
    challengeDay: string
  ): Promise<DailyChallengeCompletionRow | null> {
    const [row] = await tx.unsafe<DailyChallengeCompletionRow[]>(
      `
      SELECT *
      FROM daily_challenge_completions
      WHERE user_id = $1
        AND challenge_type = $2
        AND challenge_day = $3
      LIMIT 1
      `,
      [userId, challengeType, challengeDay]
    );
    return row ?? null;
  },

  async deleteCompletionForUserOnDay(
    userId: string,
    challengeType: DailyChallengeType,
    challengeDay: string
  ): Promise<void> {
    await sql`
      DELETE FROM daily_challenge_completions
      WHERE user_id = ${userId}
        AND challenge_type = ${challengeType}
        AND challenge_day = ${challengeDay}
    `;
  },

  async createCompletionInTx(
    tx: TransactionSql,
    input: {
      userId: string;
      challengeType: DailyChallengeType;
      challengeDay: string;
      score: number;
      coinsAwarded: number;
      xpAwarded: number;
    }
  ): Promise<DailyChallengeCompletionRow> {
    const [row] = await tx.unsafe<DailyChallengeCompletionRow[]>(
      `
      INSERT INTO daily_challenge_completions (
        user_id,
        challenge_type,
        challenge_day,
        score,
        coins_awarded,
        xp_awarded
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
      `,
      [
        input.userId,
        input.challengeType,
        input.challengeDay,
        input.score,
        input.coinsAwarded,
        input.xpAwarded,
      ]
    );
    return row;
  },

  async listPublishedQuestionsByTypeAndCategories(
    questionType: string,
    categoryIds: string[],
    options?: { limit?: number }
  ): Promise<QuestionContentRow[]> {
    const categoryFilter = categoryIds.length > 0
      ? sql`AND q.category_id = ANY(${sql.array(categoryIds)}::uuid[])`
      : sql``;

    const limitClause = options?.limit != null
      ? sql`ORDER BY RANDOM() LIMIT ${options.limit}`
      : sql``;

    return sql<QuestionContentRow[]>`
      SELECT
        q.id,
        q.category_id,
        q.difficulty,
        q.prompt,
        q.explanation,
        qp.payload,
        c.name AS category_name
      FROM questions q
      JOIN question_payloads qp ON qp.question_id = q.id
      JOIN categories c ON c.id = q.category_id
      WHERE q.status = 'published'
        AND q.type = ${questionType}
        AND c.is_active = true
        ${categoryFilter}
      ${limitClause}
    `;
  },
};
