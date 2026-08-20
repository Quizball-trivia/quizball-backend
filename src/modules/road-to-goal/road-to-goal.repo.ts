import { sql, type TransactionSql } from '../../db/index.js';
import {
  ROAD_TO_GOAL_CANDIDATES_PER_DIFFICULTY,
  ROAD_TO_GOAL_DIFFICULTIES,
  ROAD_TO_GOAL_SERVER_WINDOW_MS,
  ROAD_TO_GOAL_ZONE_ACCURACY_PRIORS_BP,
} from './road-to-goal.constants.js';
import type {
  RoadToGoalCalibrationVersionRow,
  RoadToGoalCommitmentRow,
  RoadToGoalEventInput,
  RoadToGoalEventRow,
  RoadToGoalQuestionCandidate,
  RoadToGoalQuestionCalibrationRow,
  RoadToGoalQuestionSelectionMode,
  RoadToGoalQuestionSnapshot,
  RoadToGoalRoundRow,
} from './road-to-goal.types.js';

const exec = (tx: TransactionSql): typeof sql => tx as unknown as typeof sql;

const databaseClockProjection = sql`
  clock_timestamp() AS database_now,
  (
    phase = 'question'
    AND question_deadline_at IS NOT NULL
    AND question_deadline_at <= clock_timestamp()
  ) AS question_expired,
  (
    phase = 'decision'
    AND decision_deadline_at IS NOT NULL
    AND decision_deadline_at <= clock_timestamp()
  ) AS decision_expired
`;

// Keep malformed legacy payloads out of the bounded selection window. The
// application parser remains the final authority, while this predicate makes
// the indexed LIMIT count structurally usable MCQs rather than arbitrary rows.
const validRoadToGoalMcqShape = sql`
  CASE WHEN jsonb_typeof(q.prompt) = 'object' THEN
    EXISTS (SELECT 1 FROM jsonb_each(q.prompt))
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_each(q.prompt) AS prompt_entry(locale, value)
      WHERE char_length(prompt_entry.locale) > 10
        OR jsonb_typeof(prompt_entry.value) <> 'string'
        OR prompt_entry.value = '""'::jsonb
    )
  ELSE false END
  AND CASE WHEN jsonb_typeof(qp.payload -> 'options') = 'array' THEN
    jsonb_array_length(qp.payload -> 'options') = 4
    AND (
      SELECT count(*)
      FROM jsonb_array_elements(qp.payload -> 'options') AS item(option)
      WHERE jsonb_typeof(item.option) = 'object'
        AND jsonb_typeof(item.option -> 'id') = 'string'
        AND char_length(item.option ->> 'id') BETWEEN 1 AND 64
        AND jsonb_typeof(item.option -> 'is_correct') = 'boolean'
        AND CASE WHEN jsonb_typeof(item.option -> 'text') = 'object' THEN
          EXISTS (SELECT 1 FROM jsonb_each(item.option -> 'text'))
          AND NOT EXISTS (
            SELECT 1
            FROM jsonb_each(item.option -> 'text') AS option_text(locale, value)
            WHERE char_length(option_text.locale) > 10
              OR jsonb_typeof(option_text.value) <> 'string'
              OR option_text.value = '""'::jsonb
          )
        ELSE false END
    ) = 4
    AND (
      SELECT count(DISTINCT item.option ->> 'id')
      FROM jsonb_array_elements(qp.payload -> 'options') AS item(option)
    ) = 4
    AND (
      SELECT count(*)
      FROM jsonb_array_elements(qp.payload -> 'options') AS item(option)
      WHERE item.option ->> 'is_correct' = 'true'
    ) = 1
  ELSE false END
  AND CASE
    WHEN NOT (qp.payload ? 'image') OR qp.payload -> 'image' = 'null'::jsonb THEN true
    WHEN jsonb_typeof(qp.payload -> 'image') = 'object' THEN
      coalesce(qp.payload -> 'image' ->> 'url', '') ~ '^https?://'
      AND jsonb_typeof(qp.payload -> 'image' -> 'width') = 'number'
      AND (qp.payload -> 'image' ->> 'width')::numeric > 0
      AND mod((qp.payload -> 'image' ->> 'width')::numeric, 1) = 0
      AND jsonb_typeof(qp.payload -> 'image' -> 'height') = 'number'
      AND (qp.payload -> 'image' ->> 'height')::numeric > 0
      AND mod((qp.payload -> 'image' ->> 'height')::numeric, 1) = 0
      AND (
        NOT (qp.payload -> 'image' ? 'aspect_ratio')
        OR jsonb_typeof(qp.payload -> 'image' -> 'aspect_ratio') = 'string'
      )
    ELSE false
  END
`;

export const roadToGoalRepo = {
  async insertLedgerKey(
    tx: TransactionSql,
    data: {
      idempotencyKey: string;
      roundId: string;
      userId: string;
      eventType: 'road_to_goal_stake' | 'road_to_goal_payout';
    }
  ): Promise<void> {
    await exec(tx)`
      INSERT INTO road_to_goal_ledger_keys (
        idempotency_key, round_id, user_id, event_type
      ) VALUES (
        ${data.idempotencyKey}, ${data.roundId}, ${data.userId}, ${data.eventType}
      )
    `;
  },

  async getRoundByNonceForUpdate(
    tx: TransactionSql,
    userId: string,
    clientNonce: string
  ): Promise<RoadToGoalRoundRow | null> {
    const [row] = await exec(tx)<RoadToGoalRoundRow[]>`
      SELECT road_to_goal_rounds.*, ${databaseClockProjection} FROM road_to_goal_rounds
      WHERE user_id = ${userId} AND client_nonce = ${clientNonce}
      FOR UPDATE
    `;
    return row ?? null;
  },

  async getActiveRoundForUpdate(
    tx: TransactionSql,
    userId: string
  ): Promise<RoadToGoalRoundRow | null> {
    const [row] = await exec(tx)<RoadToGoalRoundRow[]>`
      SELECT road_to_goal_rounds.*, ${databaseClockProjection} FROM road_to_goal_rounds
      WHERE user_id = ${userId} AND status = 'active'
      FOR UPDATE
    `;
    return row ?? null;
  },

  async getRoundForUserForUpdate(
    tx: TransactionSql,
    userId: string,
    roundId: string
  ): Promise<RoadToGoalRoundRow | null> {
    const [row] = await exec(tx)<RoadToGoalRoundRow[]>`
      SELECT road_to_goal_rounds.*, ${databaseClockProjection} FROM road_to_goal_rounds
      WHERE id = ${roundId} AND user_id = ${userId}
      FOR UPDATE
    `;
    return row ?? null;
  },

  async getNextExpiredRoundForUpdateSkipLocked(
    tx: TransactionSql,
    excludedRoundIds: readonly string[] = []
  ): Promise<RoadToGoalRoundRow | null> {
    const [row] = await exec(tx)<RoadToGoalRoundRow[]>`
      SELECT road_to_goal_rounds.*, ${databaseClockProjection}
      FROM road_to_goal_rounds
      WHERE status = 'active'
        AND id <> ALL(${[...excludedRoundIds]}::uuid[])
        AND (
          (phase = 'question' AND question_deadline_at <= clock_timestamp())
          OR (phase = 'decision' AND decision_deadline_at <= clock_timestamp())
        )
      ORDER BY LEAST(
        COALESCE(question_deadline_at, 'infinity'::timestamptz),
        COALESCE(decision_deadline_at, 'infinity'::timestamptz)
      ) ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `;
    return row ?? null;
  },

  async insertRound(
    tx: TransactionSql,
    data: {
      userId: string;
      roundId: string;
      stakeCoins: number;
      runQuestions: unknown;
      clientNonce: string;
      calibrationVersionId: string;
      serverSeed: string;
      commitHash: string;
      clientSeed: string;
      autoCashoutZone: number | null;
      commitmentVersion: 3;
      rulesManifestHash: string;
      questionSetHash: string;
    }
  ): Promise<RoadToGoalRoundRow> {
    const [row] = await exec(tx)<RoadToGoalRoundRow[]>`
      INSERT INTO road_to_goal_rounds (
        id, user_id, stake_coins, run_questions, question_deadline_at, client_nonce,
        calibration_version_id, server_seed, commit_hash, client_seed, auto_cashout_zone,
        commitment_version, rules_manifest_hash, question_set_hash
      ) VALUES (
        ${data.roundId}, ${data.userId}, ${data.stakeCoins},
        ${exec(tx).json(data.runQuestions as never)},
        clock_timestamp() + (${ROAD_TO_GOAL_SERVER_WINDOW_MS} * interval '1 millisecond'),
        ${data.clientNonce}, ${data.calibrationVersionId}, ${data.serverSeed},
        ${data.commitHash}, ${data.clientSeed}, ${data.autoCashoutZone},
        ${data.commitmentVersion}, ${data.rulesManifestHash}, ${data.questionSetHash}
      )
      RETURNING *, clock_timestamp() AS database_now, false AS question_expired,
        false AS decision_expired
    `;
    return row;
  },

  async updateRoundState(
    tx: TransactionSql,
    roundId: string,
    expectedVersion: number,
    patch: Record<string, unknown>
  ): Promise<RoadToGoalRoundRow | null> {
    const [row] = await exec(tx)<RoadToGoalRoundRow[]>`
      UPDATE road_to_goal_rounds
      SET ${exec(tx)(patch as Record<string, never>)},
          state_version = state_version + 1,
          last_seen_at = now()
      WHERE id = ${roundId}
        AND state_version = ${expectedVersion}
        AND status = 'active'
      RETURNING *, clock_timestamp() AS database_now,
        (phase = 'question' AND question_deadline_at <= clock_timestamp()) AS question_expired,
        (phase = 'decision' AND decision_deadline_at <= clock_timestamp()) AS decision_expired
    `;
    return row ?? null;
  },

  async touchLastSeen(userId: string): Promise<void> {
    await sql`
      UPDATE road_to_goal_rounds
      SET last_seen_at = now()
      WHERE user_id = ${userId} AND status = 'active'
    `;
  },

  async expirePreparedCommitments(tx: TransactionSql, userId: string): Promise<void> {
    await exec(tx)`
      UPDATE road_to_goal_commitments
      SET status = 'expired'
      WHERE user_id = ${userId}
        AND status = 'prepared'
        AND expires_at <= clock_timestamp()
    `;
  },

  async getCommitmentByNonceForUpdate(
    tx: TransactionSql,
    userId: string,
    requestNonce: string
  ): Promise<RoadToGoalCommitmentRow | null> {
    const [row] = await exec(tx)<RoadToGoalCommitmentRow[]>`
      SELECT *, clock_timestamp() AS database_now
      FROM road_to_goal_commitments
      WHERE user_id = ${userId} AND request_nonce = ${requestNonce}
      FOR UPDATE
    `;
    return row ?? null;
  },

  async getPreparedCommitmentForUserForUpdate(
    tx: TransactionSql,
    userId: string
  ): Promise<RoadToGoalCommitmentRow | null> {
    const [row] = await exec(tx)<RoadToGoalCommitmentRow[]>`
      SELECT *, clock_timestamp() AS database_now
      FROM road_to_goal_commitments
      WHERE user_id = ${userId} AND status = 'prepared'
      FOR UPDATE
    `;
    return row ?? null;
  },

  async getCommitmentForUpdate(
    tx: TransactionSql,
    userId: string,
    roundId: string
  ): Promise<RoadToGoalCommitmentRow | null> {
    const [row] = await exec(tx)<RoadToGoalCommitmentRow[]>`
      SELECT *, clock_timestamp() AS database_now
      FROM road_to_goal_commitments
      WHERE round_id = ${roundId} AND user_id = ${userId}
      FOR UPDATE
    `;
    return row ?? null;
  },

  async getCommitmentForProof(
    tx: TransactionSql,
    userId: string,
    roundId: string
  ): Promise<RoadToGoalCommitmentRow | null> {
    const [row] = await exec(tx)<RoadToGoalCommitmentRow[]>`
      SELECT *, clock_timestamp() AS database_now
      FROM road_to_goal_commitments
      WHERE round_id = ${roundId} AND user_id = ${userId}
      LIMIT 1
    `;
    return row ?? null;
  },

  async insertCommitment(
    tx: TransactionSql,
    data: {
      roundId: string;
      userId: string;
      requestNonce: string;
      stakeCoins: number;
      autoCashoutZone: number | null;
      calibrationVersionId: string;
      commitmentVersion: 3;
      serverSeed: string;
      commitHash: string;
      rulesManifest: unknown;
      rulesManifestHash: string;
      runQuestions: unknown;
      questionSetHash: string;
      expiresInMs: number;
    }
  ): Promise<RoadToGoalCommitmentRow> {
    const [row] = await exec(tx)<RoadToGoalCommitmentRow[]>`
      INSERT INTO road_to_goal_commitments (
        round_id, user_id, request_nonce, stake_coins, auto_cashout_zone,
        calibration_version_id, commitment_version, server_seed, commit_hash,
        rules_manifest, rules_manifest_hash, run_questions, question_set_hash, expires_at
      ) VALUES (
        ${data.roundId}, ${data.userId}, ${data.requestNonce}, ${data.stakeCoins},
        ${data.autoCashoutZone}, ${data.calibrationVersionId}, ${data.commitmentVersion},
        ${data.serverSeed}, ${data.commitHash}, ${exec(tx).json(data.rulesManifest as never)},
        ${data.rulesManifestHash}, ${exec(tx).json(data.runQuestions as never)},
        ${data.questionSetHash},
        clock_timestamp() + (${data.expiresInMs} * interval '1 millisecond')
      )
      RETURNING *, clock_timestamp() AS database_now
    `;
    return row;
  },

  async consumeCommitment(
    tx: TransactionSql,
    roundId: string
  ): Promise<RoadToGoalCommitmentRow | null> {
    const [row] = await exec(tx)<RoadToGoalCommitmentRow[]>`
      UPDATE road_to_goal_commitments
      SET status = 'consumed', consumed_at = clock_timestamp()
      WHERE round_id = ${roundId}
        AND status = 'prepared'
        AND expires_at > clock_timestamp()
      RETURNING *, clock_timestamp() AS database_now
    `;
    return row ?? null;
  },

  async insertEvent(tx: TransactionSql, event: RoadToGoalEventInput): Promise<void> {
    await exec(tx)`
      INSERT INTO road_to_goal_events (
        round_id, user_id, zone, state_version, event_type,
        question_id, answer_option, correct_option, answer_correct, answer_ms,
        multiplier_bp, stake_coins, payout_coins, client_nonce, request_nonce,
        expected_accuracy_bp, target_survival_bp, correct_survival_bp,
        wrong_survival_bp, applied_survival_bp, roll_bp, survived
      ) VALUES (
        ${event.roundId}, ${event.userId}, ${event.zone}, ${event.stateVersion}, ${event.eventType},
        ${event.questionId ?? null}, ${event.answerOption ?? null}, ${event.correctOption ?? null},
        ${event.answerCorrect ?? null}, ${event.answerMs ?? null}, ${event.multiplierBp ?? null},
        ${event.stakeCoins ?? null}, ${event.payoutCoins ?? null}, ${event.clientNonce ?? null},
        ${event.requestNonce ?? null}, ${event.expectedAccuracyBp ?? null},
        ${event.targetSurvivalBp ?? null}, ${event.correctSurvivalBp ?? null},
        ${event.wrongSurvivalBp ?? null}, ${event.appliedSurvivalBp ?? null},
        ${event.rollBp ?? null}, ${event.survived ?? null}
      )
    `;
  },

  async getEventByRequestNonce(
    tx: TransactionSql,
    roundId: string,
    requestNonce: string
  ): Promise<RoadToGoalEventRow | null> {
    const [row] = await exec(tx)<RoadToGoalEventRow[]>`
      SELECT *
      FROM road_to_goal_events
      WHERE round_id = ${roundId} AND request_nonce = ${requestNonce}
      LIMIT 1
    `;
    return row ?? null;
  },

  async getProofEvents(
    tx: TransactionSql,
    roundId: string
  ): Promise<RoadToGoalEventRow[]> {
    return exec(tx)<RoadToGoalEventRow[]>`
      SELECT *
      FROM road_to_goal_events
      WHERE round_id = ${roundId}
        AND event_type IN ('answer', 'timeout')
      ORDER BY zone ASC, id ASC
    `;
  },

  /**
   * Record only questions actually served to the player. The aggregate row
   * stays compact while preserving unseen-first and least-recent fallback.
   */
  async recordQuestionExposures(
    tx: TransactionSql,
    userId: string,
    roundId: string,
    questions: RoadToGoalQuestionSnapshot[]
  ): Promise<void> {
    if (questions.length === 0) return;
    const rows = questions.map((question) => [
      userId,
      question.question_id,
      roundId,
    ]);

    await exec(tx)`
      INSERT INTO road_to_goal_question_exposures (
        user_id, question_id, last_round_id
      )
      VALUES ${exec(tx)(rows)}
      ON CONFLICT (user_id, question_id) DO UPDATE
      SET exposure_count = road_to_goal_question_exposures.exposure_count + 1,
          last_exposed_at = now(),
          last_round_id = EXCLUDED.last_round_id
    `;
  },

  /**
   * Every call reads the current published pool; no question set is cached or
   * copied between games. The normal path returns only questions this player
   * has never had reserved. A random UUID pivot plus wraparound uses the
   * partial (difficulty, id) index and avoids sorting the full eligible pool.
   *
   * Once a difficulty slice is exhausted, the fallback mirrors ranked play:
   * fewest exposures first, then the question seen longest ago, then random.
   * The compact aggregate history is joined as a set, never recomputed through
   * a correlated per-candidate history aggregation.
   */
  async pickRunQuestionCandidates(
    tx: TransactionSql,
    userId: string,
    mode: RoadToGoalQuestionSelectionMode = 'unseen'
  ): Promise<RoadToGoalQuestionCandidate[]> {
    if (mode === 'least_exposed') {
      return exec(tx)<RoadToGoalQuestionCandidate[]>`
        WITH difficulty_targets(difficulty) AS (
          VALUES ('easy'::text), ('medium'::text), ('hard'::text)
        ),
        candidate_ids AS MATERIALIZED (
          SELECT picked.id, picked.selection_priority
          FROM difficulty_targets target
          CROSS JOIN LATERAL (
            SELECT q.id,
                   row_number() OVER (
                     ORDER BY exposure.exposure_count ASC NULLS FIRST,
                              exposure.last_exposed_at ASC NULLS FIRST,
                              random()
                   )::integer AS selection_priority
            FROM questions q
            JOIN categories category
              ON category.id = q.category_id
             AND category.is_active = true
            JOIN question_payloads qp ON qp.question_id = q.id
            LEFT JOIN road_to_goal_question_exposures exposure
              ON exposure.user_id = ${userId}
             AND exposure.question_id = q.id
            WHERE q.status = 'published'
              AND q.type = 'mcq_single'
              AND q.ranked_eligible = true
              AND q.visibility = 'public'
              AND q.difficulty = target.difficulty
              AND ${validRoadToGoalMcqShape}
            ORDER BY selection_priority
            LIMIT ${ROAD_TO_GOAL_CANDIDATES_PER_DIFFICULTY}
          ) picked
        )
        SELECT q.id, q.difficulty, q.prompt, qp.payload, candidate.selection_priority
        FROM candidate_ids candidate
        JOIN questions q ON q.id = candidate.id
        JOIN question_payloads qp ON qp.question_id = q.id
        ORDER BY candidate.selection_priority, q.difficulty
      `;
    }

    return exec(tx)<RoadToGoalQuestionCandidate[]>`
      WITH pivots(difficulty, pivot) AS (
        VALUES
          ('easy'::text, gen_random_uuid()),
          ('medium'::text, gen_random_uuid()),
          ('hard'::text, gen_random_uuid())
      ),
      candidate_ids AS MATERIALIZED (
        SELECT picked.id
        FROM pivots p
        CROSS JOIN LATERAL (
          SELECT wrapped.id
          FROM (
            (
              SELECT q.id
              FROM questions q
              JOIN categories category
                ON category.id = q.category_id
               AND category.is_active = true
              JOIN question_payloads qp ON qp.question_id = q.id
              WHERE q.status = 'published'
                AND q.type = 'mcq_single'
                AND q.ranked_eligible = true
                AND q.visibility = 'public'
                AND q.difficulty = p.difficulty
                AND ${validRoadToGoalMcqShape}
                AND q.id >= p.pivot
                AND NOT EXISTS (
                  SELECT 1
                  FROM road_to_goal_question_exposures exposure
                  WHERE exposure.user_id = ${userId}
                    AND exposure.question_id = q.id
                )
              ORDER BY q.id
              LIMIT ${ROAD_TO_GOAL_CANDIDATES_PER_DIFFICULTY}
            )
            UNION ALL
            (
              SELECT q.id
              FROM questions q
              JOIN categories category
                ON category.id = q.category_id
               AND category.is_active = true
              JOIN question_payloads qp ON qp.question_id = q.id
              WHERE q.status = 'published'
                AND q.type = 'mcq_single'
                AND q.ranked_eligible = true
                AND q.visibility = 'public'
                AND q.difficulty = p.difficulty
                AND ${validRoadToGoalMcqShape}
                AND q.id < p.pivot
                AND NOT EXISTS (
                  SELECT 1
                  FROM road_to_goal_question_exposures exposure
                  WHERE exposure.user_id = ${userId}
                    AND exposure.question_id = q.id
                )
              ORDER BY q.id
              LIMIT ${ROAD_TO_GOAL_CANDIDATES_PER_DIFFICULTY}
            )
          ) wrapped
          LIMIT ${ROAD_TO_GOAL_CANDIDATES_PER_DIFFICULTY}
        ) picked
      )
      SELECT q.id, q.difficulty, q.prompt, qp.payload
      FROM candidate_ids candidate
      JOIN questions q ON q.id = candidate.id
      JOIN question_payloads qp ON qp.question_id = q.id
    `;
  },

  /** Keep the fast UUID-pivot selection query independent of calibration
   * joins, then validate its bounded candidate set in one indexed bulk read. */
  async filterCandidatesForCalibration(
    tx: TransactionSql,
    calibrationVersionId: string,
    candidates: readonly RoadToGoalQuestionCandidate[]
  ): Promise<RoadToGoalQuestionCandidate[]> {
    if (candidates.length === 0) return [];
    const candidateIds = candidates.map((candidate) => candidate.id);
    const rows = await exec(tx)<Array<{ id: string }>>`
      SELECT q.id
      FROM questions q
      JOIN question_payloads payload ON payload.question_id = q.id
      JOIN road_to_goal_calibration_versions version
        ON version.id = ${calibrationVersionId}
      JOIN road_to_goal_zone_question_calibrations calibrated
        ON calibrated.version_id = version.id
       AND calibrated.question_id = q.id
       AND calibrated.zone = CASE q.difficulty
         WHEN 'easy' THEN 1
         WHEN 'medium' THEN 5
         ELSE 9
       END
      WHERE q.id = ANY(${candidateIds}::uuid[])
        AND q.updated_at <= version.created_at
        AND payload.updated_at <= version.created_at
    `;
    const eligibleIds = new Set(rows.map((row) => row.id));
    return candidates.filter((candidate) => eligibleIds.has(candidate.id));
  },

  async getLatestCalibrationVersion(
    tx: TransactionSql
  ): Promise<RoadToGoalCalibrationVersionRow | null> {
    const [row] = await exec(tx)<RoadToGoalCalibrationVersionRow[]>`
      SELECT *
      FROM road_to_goal_calibration_versions
      ORDER BY publication_day DESC
      LIMIT 1
    `;
    return row ?? null;
  },

  async getDatabasePublicationDay(tx: TransactionSql): Promise<string> {
    const [row] = await exec(tx)<Array<{ publication_day: string }>>`
      SELECT (clock_timestamp() AT TIME ZONE 'UTC')::date::text AS publication_day
    `;
    if (!row) throw new Error('Database clock query returned no row');
    return row.publication_day;
  },

  async getCalibrationVersionForDay(
    tx: TransactionSql,
    publicationDay: string
  ): Promise<RoadToGoalCalibrationVersionRow | null> {
    const [row] = await exec(tx)<RoadToGoalCalibrationVersionRow[]>`
      SELECT *
      FROM road_to_goal_calibration_versions
      WHERE publication_day = ${publicationDay}
        AND rules_version = 2
      LIMIT 1
    `;
    return row ?? null;
  },

  async getCalibrationVersionById(
    tx: TransactionSql,
    versionId: string
  ): Promise<RoadToGoalCalibrationVersionRow | null> {
    const [row] = await exec(tx)<RoadToGoalCalibrationVersionRow[]>`
      SELECT *
      FROM road_to_goal_calibration_versions
      WHERE id = ${versionId}
      LIMIT 1
    `;
    return row ?? null;
  },

  async lockCalibrationPublisher(tx: TransactionSql): Promise<void> {
    await exec(tx)`
      SELECT pg_advisory_xact_lock(hashtextextended('road_to_goal_calibration_publish', 0))
    `;
  },

  async insertCalibrationVersion(
    tx: TransactionSql,
    input: {
      publicationDay: string;
      rulesVersion: number;
      targetRtpBp: number;
      skillGapBp: number;
      easyPriorBp: number;
      mediumPriorBp: number;
      hardPriorBp: number;
      minimumAccuracyBp: number;
      maximumAccuracyBp: number;
      minimumSurvivalBp: number;
      maximumSurvivalBp: number;
      minimumRoadAnswers: number;
      config: unknown;
    }
  ): Promise<RoadToGoalCalibrationVersionRow> {
    const [row] = await exec(tx)<RoadToGoalCalibrationVersionRow[]>`
      INSERT INTO road_to_goal_calibration_versions (
        publication_day, rules_version, target_rtp_bp, skill_gap_bp,
        easy_prior_bp, medium_prior_bp, hard_prior_bp,
        minimum_accuracy_bp, maximum_accuracy_bp,
        minimum_survival_bp, maximum_survival_bp,
        minimum_road_answers, config
      ) VALUES (
        ${input.publicationDay}, ${input.rulesVersion}, ${input.targetRtpBp}, ${input.skillGapBp},
        ${input.easyPriorBp}, ${input.mediumPriorBp}, ${input.hardPriorBp},
        ${input.minimumAccuracyBp}, ${input.maximumAccuracyBp},
        ${input.minimumSurvivalBp}, ${input.maximumSurvivalBp},
        ${input.minimumRoadAnswers}, ${exec(tx).json(input.config as never)}
      )
      RETURNING *
    `;
    return row;
  },

  async insertQuestionCalibrations(
    tx: TransactionSql,
    version: RoadToGoalCalibrationVersionRow
  ): Promise<number> {
    const zonePriors = [...ROAD_TO_GOAL_ZONE_ACCURACY_PRIORS_BP];
    const zoneDifficulties = [...ROAD_TO_GOAL_DIFFICULTIES];
    const rows = await exec(tx)<Array<{ question_id: string }>>`
      WITH zone_targets AS MATERIALIZED (
        SELECT
          ordinality::smallint AS zone,
          zone_prior_bp::integer,
          zone_difficulty
        FROM unnest(
          ${zonePriors}::integer[],
          ${zoneDifficulties}::text[]
        ) WITH ORDINALITY AS target(zone_prior_bp, zone_difficulty, ordinality)
      ),
      eligible AS MATERIALIZED (
        SELECT
          q.id AS question_id,
          q.difficulty,
          target.zone,
          target.zone_prior_bp,
          CASE q.difficulty
            WHEN 'easy' THEN ${version.easy_prior_bp}
            WHEN 'medium' THEN ${version.medium_prior_bp}
            ELSE ${version.hard_prior_bp}
          END::integer AS difficulty_prior_bp
        FROM questions q
        JOIN zone_targets target ON target.zone_difficulty = q.difficulty
        JOIN categories category
          ON category.id = q.category_id AND category.is_active = true
        WHERE q.status = 'published'
          AND q.type = 'mcq_single'
          AND q.ranked_eligible = true
          AND q.visibility = 'public'
          AND q.difficulty IN ('easy', 'medium', 'hard')
      ),
      road_stats AS MATERIALIZED (
        SELECT
          event.question_id,
          event.zone,
          count(*)::integer AS answer_count,
          count(*) FILTER (WHERE event.answer_correct)::integer AS correct_count,
          count(*) FILTER (WHERE event.event_type = 'timeout')::integer AS timeout_count
        FROM road_to_goal_events event
        JOIN users player ON player.id = event.user_id
        WHERE event.event_type IN ('answer', 'timeout')
          AND event.question_id IS NOT NULL
          AND event.answer_correct IS NOT NULL
          AND player.is_ai = false
          AND player.is_seed = false
          AND player.is_deleted = false
          AND player.is_banned = false
        GROUP BY event.question_id, event.zone
      ),
      inputs AS MATERIALIZED (
        SELECT
          eligible.question_id,
          eligible.difficulty,
          eligible.zone,
          eligible.zone_prior_bp,
          coalesce(stats.answers_count, 0)::integer AS ranked_answer_count,
          greatest(
            ${version.minimum_accuracy_bp},
            least(
              ${version.maximum_accuracy_bp},
              eligible.zone_prior_bp + (
                coalesce(
                  round(stats.smoothed_accuracy * 10000)::integer,
                  eligible.difficulty_prior_bp
                ) - eligible.difficulty_prior_bp
              )
            )
          )::integer AS ranked_accuracy_bp,
          coalesce(road.answer_count, 0)::integer AS road_answer_count,
          coalesce(road.correct_count, 0)::integer AS road_correct_count,
          coalesce(road.timeout_count, 0)::integer AS road_timeout_count
        FROM eligible
        LEFT JOIN question_stats stats ON stats.question_id = eligible.question_id
        LEFT JOIN road_stats road
          ON road.question_id = eligible.question_id
         AND road.zone = eligible.zone
      ),
      smoothed AS (
        SELECT
          inputs.*,
          round(
            (road_correct_count * 10000.0 + 20 * ranked_accuracy_bp)
            / (road_answer_count + 20)
          )::integer AS road_smoothed_accuracy_bp
        FROM inputs
      )
      INSERT INTO road_to_goal_zone_question_calibrations (
        version_id, question_id, zone, difficulty, expected_accuracy_bp,
        ranked_answer_count, road_answer_count, road_correct_count,
        road_timeout_count, source
      )
      SELECT
        ${version.id},
        question_id,
        zone,
        difficulty,
        greatest(
          ${version.minimum_accuracy_bp},
          least(
            ${version.maximum_accuracy_bp},
            CASE
              WHEN road_answer_count >= ${version.minimum_road_answers}
                THEN road_smoothed_accuracy_bp
              WHEN road_answer_count > 0
                THEN round(
                  (
                    road_answer_count * road_smoothed_accuracy_bp
                    + (${version.minimum_road_answers} - road_answer_count) * ranked_accuracy_bp
                  )::numeric / ${version.minimum_road_answers}
                )::integer
              ELSE ranked_accuracy_bp
            END
          )
        )::smallint,
        ranked_answer_count,
        road_answer_count,
        road_correct_count,
        road_timeout_count,
        CASE
          WHEN road_answer_count >= ${version.minimum_road_answers} THEN 'road'
          WHEN road_answer_count > 0 THEN 'blended'
          WHEN ranked_answer_count > 0 THEN 'ranked'
          ELSE 'difficulty_prior'
        END
      FROM smoothed
      RETURNING question_id
    `;
    return rows.length;
  },

  async getQuestionCalibrations(
    tx: TransactionSql,
    versionId: string,
    questions: ReadonlyArray<{ questionId: string; zone: number }>
  ): Promise<RoadToGoalQuestionCalibrationRow[]> {
    if (questions.length === 0) return [];
    const questionIds = questions.map((question) => question.questionId);
    const zones = questions.map((question) => question.zone);
    return exec(tx)<RoadToGoalQuestionCalibrationRow[]>`
      SELECT calibration.question_id, calibration.zone,
             calibration.expected_accuracy_bp, calibration.source
      FROM road_to_goal_zone_question_calibrations calibration
      JOIN unnest(${questionIds}::uuid[], ${zones}::smallint[])
        AS requested(question_id, zone)
        ON requested.question_id = calibration.question_id
       AND requested.zone = calibration.zone
      WHERE calibration.version_id = ${versionId}
    `;
  },
};
