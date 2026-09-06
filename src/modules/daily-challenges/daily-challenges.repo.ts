import { sql, type TransactionSql } from '../../db/index.js';
import type { Json } from '../../db/types.js';
import { selectDailyFifaCardIds, type FifaCardCandidate } from './fifa-card-selection.js';
import { progressionRepo, type GrantXpInput, type GrantXpResult } from '../progression/progression.repo.js';
import { storeRepo } from '../store/store.repo.js';
import type { WalletRow } from '../store/store.types.js';
import type {
  DailyChallengeAvailableCategoryRow,
  DailyChallengeCardOutcomeInput,
  DailyChallengeCompletionRow,
  DailyChallengeConfigRow,
  DailyChallengeType,
  DailyFifaCardSetRow,
  FifaCardRow,
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
  listDistinctCompletionDays(
    userId: string,
    throughDay: string,
    limit: number
  ): Promise<string[]>;
  createStreakBonusAward(
    userId: string,
    challengeDay: string,
    coinsAwarded: number
  ): Promise<boolean>;
  createCardOutcomes(completionId: string, outcomes: DailyChallengeCardOutcomeInput[]): Promise<void>;
}

export const dailyChallengesRepo = {
  runInTransaction<T>(callback: (txRepo: DailyChallengesTransactionRepo) => Promise<T>): Promise<T> {
    return sql.begin((tx) => callback({
      getCompletionForUserOnDay: (userId, challengeType, challengeDay) =>
        dailyChallengesRepo.getCompletionForUserOnDayInTx(tx, userId, challengeType, challengeDay),
      createCompletion: (input) => dailyChallengesRepo.createCompletionInTx(tx, input),
      addCoins: (userId, amount) => storeRepo.addCoinsInTx(tx, userId, amount),
      grantXp: (input) => progressionRepo.grantXpInTx(tx, input),
      listDistinctCompletionDays: (userId, throughDay, limit) =>
        dailyChallengesRepo.listDistinctCompletionDaysInTx(tx, userId, throughDay, limit),
      createStreakBonusAward: (userId, challengeDay, coinsAwarded) =>
        dailyChallengesRepo.createStreakBonusAwardInTx(tx, userId, challengeDay, coinsAwarded),
      createCardOutcomes: (completionId, outcomes) =>
        dailyChallengesRepo.createCardOutcomesInTx(tx, completionId, outcomes),
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

  async listDistinctCompletionDays(
    userId: string,
    throughDay: string,
    limit = 370
  ): Promise<string[]> {
    const rows = await sql<Array<{ challenge_day: string }>>`
      SELECT DISTINCT challenge_day::text AS challenge_day
      FROM daily_challenge_completions
      WHERE user_id = ${userId}
        AND challenge_day <= ${throughDay}::date
      ORDER BY challenge_day DESC
      LIMIT ${limit}
    `;
    return rows.map((row) => row.challenge_day);
  },

  async listDistinctCompletionDaysInTx(
    tx: TransactionSql,
    userId: string,
    throughDay: string,
    limit = 370
  ): Promise<string[]> {
    const rows = await tx.unsafe<Array<{ challenge_day: string }>>(
      `
      SELECT DISTINCT challenge_day::text AS challenge_day
      FROM daily_challenge_completions
      WHERE user_id = $1
        AND challenge_day <= $2::date
      ORDER BY challenge_day DESC
      LIMIT $3
      `,
      [userId, throughDay, limit]
    );
    return rows.map((row) => row.challenge_day);
  },

  async createStreakBonusAwardInTx(
    tx: TransactionSql,
    userId: string,
    challengeDay: string,
    coinsAwarded: number
  ): Promise<boolean> {
    const rows = await tx.unsafe<Array<{ id: string }>>(
      `
      INSERT INTO daily_challenge_streak_bonus_awards (
        user_id,
        challenge_day,
        coins_awarded
      )
      VALUES ($1, $2::date, $3)
      ON CONFLICT (user_id, challenge_day) DO NOTHING
      RETURNING id
      `,
      [userId, challengeDay, coinsAwarded]
    );
    return rows.length === 1;
  },

  async getPendingReminder(userId: string): Promise<{ remind_at: string } | null> {
    const [row] = await sql<Array<{ remind_at: string }>>`
      SELECT remind_at
      FROM daily_challenge_reminders
      WHERE user_id = ${userId}
        AND status = 'pending'
        AND remind_at > NOW()
      LIMIT 1
    `;
    return row ?? null;
  },

  async canReceiveReminderEmail(userId: string): Promise<boolean> {
    const [row] = await sql<Array<{ eligible: boolean }>>`
      SELECT (
        u.email IS NOT NULL
        AND u.is_ai = false
        AND u.is_seed = false
        AND u.is_deleted = false
        AND u.deleted_at IS NULL
        AND u.pending_deletion_at IS NULL
        AND u.is_banned = false
        AND NOT EXISTS (
          SELECT 1 FROM email_unsubscribes x WHERE x.user_id = u.id
        )
      ) AS eligible
      FROM users u
      WHERE u.id = ${userId}
      LIMIT 1
    `;
    return row?.eligible === true;
  },

  async upsertReminder(userId: string, remindAt: Date): Promise<{ remind_at: string }> {
    const [row] = await sql<Array<{ remind_at: string }>>`
      INSERT INTO daily_challenge_reminders (
        user_id,
        remind_at,
        status,
        attempts,
        sent_at,
        last_attempt_at
      )
      VALUES (${userId}, ${remindAt}, 'pending', 0, NULL, NULL)
      ON CONFLICT (user_id) DO UPDATE SET
        remind_at = EXCLUDED.remind_at,
        status = 'pending',
        attempts = 0,
        sent_at = NULL,
        last_attempt_at = NULL
      RETURNING remind_at
    `;
    return row;
  },

  async cancelReminder(userId: string): Promise<void> {
    await sql`
      UPDATE daily_challenge_reminders
      SET status = 'cancelled'
      WHERE user_id = ${userId}
        AND status = 'pending'
    `;
  },

  async listRecentlyServedQuestions(
    userId: string,
    windowDays: number
  ): Promise<Array<{ question_id: string; answer_keys: string[] }>> {
    return sql<Array<{ question_id: string; answer_keys: string[] }>>`
      SELECT question_id, answer_keys
      FROM daily_challenge_served_questions
      WHERE user_id = ${userId}
        AND served_at >= NOW() - make_interval(days => ${windowDays})
    `;
  },

  async recordServedQuestions(
    userId: string,
    served: Array<{ id: string; answerKeys: string[] }>
  ): Promise<void> {
    if (served.length === 0) return;
    await sql`
      INSERT INTO daily_challenge_served_questions (user_id, question_id, answer_keys)
      SELECT ${userId}::uuid,
             (entry->>'id')::uuid,
             COALESCE(ARRAY(SELECT jsonb_array_elements_text(entry->'answerKeys')), '{}')
      FROM jsonb_array_elements(${sql.json(served)}::jsonb) AS entry
      ON CONFLICT (user_id, question_id)
        DO UPDATE SET served_at = NOW(), answer_keys = EXCLUDED.answer_keys
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
    options?: { limit?: number; excludeImagePayloads?: boolean }
  ): Promise<QuestionContentRow[]> {
    const categoryFilter = categoryIds.length > 0
      ? sql`AND q.category_id = ANY(${sql.array(categoryIds)}::uuid[])`
      : sql``;

    // Must be filtered in SQL, before LIMIT: a post-limit filter could leave a
    // random sample with too few usable rows in image-heavy categories.
    const imageFilter = options?.excludeImagePayloads
      ? sql`AND NOT (qp.payload ? 'image')`
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
        AND q.visibility = 'public'
        AND q.ranked_eligible = true
        AND q.type = ${questionType}
        AND c.is_active = true
        AND NOT EXISTS (SELECT 1 FROM featured_categories fc WHERE fc.category_id = c.id)
        ${categoryFilter}
        ${imageFilter}
      ${limitClause}
    `;
  },

  async countPublishedQuestionsByTypeAndCategories(
    questionType: string,
    categoryIds: string[]
  ): Promise<number> {
    const categoryFilter = categoryIds.length > 0
      ? sql`AND q.category_id = ANY(${sql.array(categoryIds)}::uuid[])`
      : sql``;

    const [row] = await sql<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count
      FROM questions q
      JOIN question_payloads qp ON qp.question_id = q.id
      JOIN categories c ON c.id = q.category_id
      WHERE q.status = 'published'
        AND q.visibility = 'public'
        AND q.ranked_eligible = true
        AND q.type = ${questionType}
        AND c.is_active = true
        AND NOT EXISTS (SELECT 1 FROM featured_categories fc WHERE fc.category_id = c.id)
        ${categoryFilter}
    `;

    return row?.count ?? 0;
  },

  async listAvailableCategoriesByQuestionType(
    questionType: string,
    options?: { requireDifficultyCoverage?: boolean }
  ): Promise<DailyChallengeAvailableCategoryRow[]> {
    const difficultyCoverageClause = options?.requireDifficultyCoverage
      ? sql`
        HAVING
          COUNT(*) FILTER (WHERE q.difficulty = 'easy') > 0
          AND COUNT(*) FILTER (WHERE q.difficulty = 'medium') > 0
          AND COUNT(*) FILTER (WHERE q.difficulty = 'hard') > 0
      `
      : sql``;

    return sql<DailyChallengeAvailableCategoryRow[]>`
      SELECT
        c.id,
        c.slug,
        c.name,
        COUNT(*)::int AS question_count,
        COUNT(*) FILTER (WHERE q.difficulty = 'easy')::int AS easy_count,
        COUNT(*) FILTER (WHERE q.difficulty = 'medium')::int AS medium_count,
        COUNT(*) FILTER (WHERE q.difficulty = 'hard')::int AS hard_count
      FROM questions q
      JOIN categories c ON c.id = q.category_id
      WHERE q.status = 'published'
        AND q.visibility = 'public'
        AND q.ranked_eligible = true
        AND q.type = ${questionType}
        AND c.is_active = true
        AND NOT EXISTS (SELECT 1 FROM featured_categories fc WHERE fc.category_id = c.id)
      GROUP BY c.id, c.slug, c.name
      ${difficultyCoverageClause}
      ORDER BY COUNT(*) DESC, c.slug ASC
    `;
  },

  // ---- FIFA Cards -----------------------------------------------------------

  async listFifaCardsByIds(ids: string[]): Promise<FifaCardRow[]> {
    if (ids.length === 0) return [];
    return sql<FifaCardRow[]>`
      SELECT * FROM fifa_cards WHERE id = ANY(${sql.array(ids)}::uuid[])
    `;
  },

  async getDailyFifaCardSet(challengeDay: string): Promise<DailyFifaCardSetRow | null> {
    return getDailyCardSet('daily_fifa_card_sets', challengeDay);
  },

  async getDailyCardDetectiveSet(challengeDay: string): Promise<DailyFifaCardSetRow | null> {
    return getDailyCardSet('daily_card_detective_sets', challengeDay);
  },

  /**
   * Materialise the day's FIFA Cards set if it doesn't exist yet and return it.
   * Runs under a transaction-level advisory lock shared with Card Detective so
   * two allocations (same day racing, adjacent days around the UTC rollover, or
   * the two games on one day) can never both pick the same never-served cards:
   * history is read and the row inserted atomically.
   */
  async allocateDailyFifaCardSet(challengeDay: string, count: number, salt: string): Promise<DailyFifaCardSetRow> {
    return allocateDailyCardSet('daily_fifa_card_sets', 'daily_card_detective_sets', challengeDay, count, salt);
  },

  /** Same allocator for Card Detective: its own rotation history, players in today's FIFA Cards set excluded. */
  async allocateDailyCardDetectiveSet(challengeDay: string, count: number, salt: string): Promise<DailyFifaCardSetRow> {
    return allocateDailyCardSet('daily_card_detective_sets', 'daily_fifa_card_sets', challengeDay, count, salt);
  },

  async createCardOutcomesInTx(
    tx: TransactionSql,
    completionId: string,
    outcomes: DailyChallengeCardOutcomeInput[]
  ): Promise<void> {
    if (outcomes.length === 0) return;
    await tx.unsafe(
      `
      INSERT INTO daily_challenge_card_outcomes (completion_id, card_id, solved, clues_revealed, coins_left)
      SELECT $1::uuid, v.card_id::uuid, v.solved, v.clues_revealed, v.coins_left
      FROM jsonb_to_recordset($2::jsonb) AS v(card_id text, solved boolean, clues_revealed int, coins_left int)
      ON CONFLICT (completion_id, card_id) DO NOTHING
      `,
      // postgres.js serialises a jsonb parameter itself; pre-stringifying would
      // hand Postgres a JSON *string* ("cannot call jsonb_to_recordset on a non-array").
      [
        completionId,
        outcomes.map((o) => ({ card_id: o.cardId, solved: o.solved, clues_revealed: o.cluesRevealed, coins_left: o.coinsLeft ?? null })),
      ]
    );
  },
};

type DailyCardSetTable = 'daily_fifa_card_sets' | 'daily_card_detective_sets';

async function getDailyCardSet(table: DailyCardSetTable, challengeDay: string): Promise<DailyFifaCardSetRow | null> {
  const [row] = await sql.unsafe<DailyFifaCardSetRow[]>(
    `SELECT challenge_day::text AS challenge_day, card_ids FROM ${table} WHERE challenge_day = $1::date`,
    [challengeDay]
  );
  return row ?? null;
}

/**
 * Difficulty-balanced pick (3 veryHard / 3 hard / 4 medium-easy + >=5 old for a
 * 10-card round) done in TS over the active pool + each card's last served day
 * in THIS game's schedule; see selectDailyFifaCardIds. Players already picked
 * by the sibling game for the same day are left out so the two dailies never
 * share an answer on one day, whichever allocates first. "Same player" is
 * matched by SoFIFA id (source_key sofifa:<edition>:<id>, or the face id),
 * by name with case/punctuation folded ("Heung-min Son" = "Heung Min Son"),
 * and by any shared accepted answer, since aliases like "Neymar" / "Neymar Jr"
 * are separate rows. Over-excluding a namesake for one day is harmless.
 */
async function allocateDailyCardSet(
  table: DailyCardSetTable,
  siblingTable: DailyCardSetTable,
  challengeDay: string,
  count: number,
  salt: string
): Promise<DailyFifaCardSetRow> {
  return sql.begin(async (tx) => {
    await tx.unsafe(`SELECT pg_advisory_xact_lock(hashtext('daily_fifa_card_sets:allocate'))`);

    const [existing] = await tx.unsafe<DailyFifaCardSetRow[]>(
      `SELECT challenge_day::text AS challenge_day, card_ids FROM ${table} WHERE challenge_day = $1::date`,
      [challengeDay]
    );
    if (existing) return existing;

    const candidates = await tx.unsafe<FifaCardCandidate[]>(
      `
      SELECT c.id::text AS id, c.difficulty, c.edition, c.name,
             (
               SELECT max(s.challenge_day)::text
               FROM ${table} s
               WHERE c.id = ANY(s.card_ids)
             ) AS last_served_day
      FROM fifa_cards c
      WHERE c.is_active
        AND NOT EXISTS (
          SELECT 1
          FROM ${siblingTable} o
          JOIN fifa_cards oc ON oc.id = ANY(o.card_ids)
          WHERE o.challenge_day = $1::date
            AND (
              oc.name = c.name
              OR regexp_replace(lower(oc.name), '[^a-z0-9]', '', 'g') = regexp_replace(lower(c.name), '[^a-z0-9]', '', 'g')
              OR oc.accepted && c.accepted
              OR (oc.photo_id IS NOT NULL AND oc.photo_id = c.photo_id)
              OR (
                split_part(oc.source_key, ':', 3) <> ''
                AND split_part(oc.source_key, ':', 3) = split_part(c.source_key, ':', 3)
              )
            )
        )
      `,
      [challengeDay]
    );
    const picked = selectDailyFifaCardIds(candidates, count, salt, challengeDay);
    if (picked.length === 0) {
      return { challenge_day: challengeDay, card_ids: [] };
    }

    await tx.unsafe(
      `INSERT INTO ${table} (challenge_day, card_ids) VALUES ($1::date, $2::uuid[])`,
      [challengeDay, picked]
    );
    return { challenge_day: challengeDay, card_ids: picked };
  }) as Promise<DailyFifaCardSetRow>;
}
