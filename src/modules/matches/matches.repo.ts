import { sql, type TransactionSql } from '../../db/index.js';
import { matchAnswersRepo } from './match-answers.repo.js';
import { matchEventsRepo } from './match-events.repo.js';
import { matchPlayersRepo } from './match-players.repo.js';
import type { Json } from '../../db/types.js';
import { withSpan } from '../../core/tracing.js';
import { VALID_PAYLOAD_CONDITIONS_RAW as VALID_PAYLOAD_CONDITIONS } from '../../db/sql-fragments.js';
import type {
  MatchRow,
  MatchQuestionRow,
  MatchGoalEventRow,
  MatchQuestionWithCategory,
  MatchQuestionTimingRow,
  MatchQuestionPhaseKind,
} from './matches.types.js';
import type { RankedLobbyContext } from '../lobbies/lobbies.types.js';
import type { QuestionType } from '../questions/questions.schemas.js';

export interface CreateMatchData {
  lobbyId: string | null;
  mode: 'friendly' | 'ranked';
  categoryAId: string;
  categoryBId: string | null;
  totalQuestions: number;
  statePayload?: unknown;
  rankedContext?: RankedLobbyContext | null;
  isDev?: boolean;
}

export const matchesRepo = {
  async createMatch(data: CreateMatchData): Promise<MatchRow> {
    const [row] = await sql<MatchRow[]>`
      INSERT INTO matches (
        id, lobby_id, mode, status, category_a_id, category_b_id, current_q_index, total_questions, state_payload, ranked_context, is_dev, started_at
      )
      VALUES (
        gen_random_uuid(), ${data.lobbyId}, ${data.mode}, 'active',
        ${data.categoryAId}, ${data.categoryBId}, 0, ${data.totalQuestions},
        ${sql.json(data.statePayload as Json ?? null)},
        ${sql.json((data.rankedContext ?? null) as Json)},
        ${data.isDev ?? false},
        NOW()
      )
      RETURNING *
    `;
    return row;
  },

  // ─── match_players facade delegates ───
  // Real implementations live in matchPlayersRepo. Kept here so existing
  // matchesRepo.* call sites compile unchanged; removed in a follow-up PR.
  insertMatchPlayers: (matchId: string, players: Array<{ userId: string; seat: number }>) =>
    matchPlayersRepo.insertMatchPlayers(matchId, players),

  listMatchPlayers: (matchId: string, tx?: TransactionSql) =>
    matchPlayersRepo.listMatchPlayers(matchId, tx),

  getPlayerTotalPoints: (matchId: string, userId: string) =>
    matchPlayersRepo.getPlayerTotalPoints(matchId, userId),

  async insertMatchQuestions(matchId: string, questions: Array<{
    qIndex: number;
    questionId: string;
    categoryId: string;
    correctIndex: number;
    phaseKind?: MatchQuestionPhaseKind;
    phaseRound?: number | null;
    shooterSeat?: number | null;
    attackerSeat?: number | null;
  }>): Promise<MatchQuestionRow[]> {
    if (questions.length === 0) return [];
    const rows = questions.map((q) => [
      matchId,
      q.qIndex,
      q.questionId,
      q.categoryId,
      q.correctIndex,
      q.phaseKind ?? 'normal',
      q.phaseRound ?? null,
      q.shooterSeat ?? null,
      q.attackerSeat ?? null,
    ] as (string | number)[]);

    return sql<MatchQuestionRow[]>`
      INSERT INTO match_questions (
        match_id, q_index, question_id, category_id, correct_index, phase_kind, phase_round, shooter_seat, attacker_seat
      )
      VALUES ${sql(rows)}
      RETURNING *
    `;
  },

  async insertMatchQuestionIfMissing(question: {
    matchId: string;
    qIndex: number;
    questionId: string;
    categoryId: string;
    correctIndex: number;
    phaseKind?: MatchQuestionPhaseKind;
    phaseRound?: number | null;
    shooterSeat?: number | null;
    attackerSeat?: number | null;
  }): Promise<MatchQuestionRow | null> {
    return withSpan('db.matches.insert_question_if_missing', {
      'db.operation.name': 'insert',
      'quizball.match_id': question.matchId,
      'quizball.q_index': question.qIndex,
      'quizball.phase_kind': question.phaseKind ?? 'normal',
    }, async (span) => {
      const [row] = await sql<MatchQuestionRow[]>`
        INSERT INTO match_questions (
          match_id, q_index, question_id, category_id, correct_index, phase_kind, phase_round, shooter_seat, attacker_seat
        )
        VALUES (
          ${question.matchId},
          ${question.qIndex},
          ${question.questionId},
          ${question.categoryId},
          ${question.correctIndex},
          ${question.phaseKind ?? 'normal'},
          ${question.phaseRound ?? null},
          ${question.shooterSeat ?? null},
          ${question.attackerSeat ?? null}
        )
        ON CONFLICT (match_id, q_index) DO NOTHING
        RETURNING *
      `;
      span.setAttribute('quizball.question_inserted', Boolean(row));
      return row ?? null;
    });
  },

  async getRandomQuestionsForCategory(
    categoryId: string,
    limit: number
  ): Promise<Array<{
    id: string;
    prompt: Record<string, string>;
    difficulty: string;
    category_id: string;
    payload: unknown;
  }>> {
    const [{ count }] = await sql.unsafe<{ count: number }[]>(`
      SELECT COUNT(*)::int as count
      FROM questions q
      JOIN categories c ON c.id = q.category_id
      JOIN question_payloads qp ON qp.question_id = q.id
      WHERE q.category_id = $1
        AND c.is_active = true
        AND q.status = 'published'
        AND q.type = 'mcq_single'
      ${VALID_PAYLOAD_CONDITIONS}
    `, [categoryId]);

    if (!count) return [];

    const SMALL_SET_THRESHOLD = limit * 5;
    if (count <= SMALL_SET_THRESHOLD) {
      return sql.unsafe<{
        id: string;
        prompt: Record<string, string>;
        difficulty: string;
        category_id: string;
        payload: unknown;
      }[]>(`
        SELECT q.id, q.prompt, q.difficulty, q.category_id, qp.payload
        FROM questions q
        JOIN categories c ON c.id = q.category_id
        JOIN question_payloads qp ON qp.question_id = q.id
        WHERE q.category_id = $1
          AND c.is_active = true
          AND q.status = 'published'
          AND q.type = 'mcq_single'
        ${VALID_PAYLOAD_CONDITIONS}
        ORDER BY RANDOM()
        LIMIT $2
      `, [categoryId, limit]);
    }

    const basePercent = Math.ceil((limit * 100) / count);
    const samplePercent = Math.min(10, Math.max(1, basePercent * 2));
    const sampleLimit = limit * 3;

    const sampled = await sql.unsafe<{
      id: string;
      prompt: Record<string, string>;
      difficulty: string;
      category_id: string;
      payload: unknown;
    }[]>(
      `
      SELECT q.id, q.prompt, q.difficulty, q.category_id, qp.payload
      FROM (
        SELECT * FROM questions TABLESAMPLE SYSTEM (${samplePercent})
      ) AS q
      JOIN categories c ON c.id = q.category_id
      JOIN question_payloads qp ON qp.question_id = q.id
      WHERE q.category_id = $1
        AND c.is_active = true
        AND q.status = 'published'
        AND q.type = 'mcq_single'
      ${VALID_PAYLOAD_CONDITIONS}
      ORDER BY RANDOM()
      LIMIT $2
      `,
      [categoryId, sampleLimit]
    );

    if (sampled.length >= limit) {
      return sampled.slice(0, limit);
    }

    const remaining = limit - sampled.length;
    const excludeIds = sampled.map((row) => row.id);
    const excludeCondition = excludeIds.length > 0 ? `AND q.id NOT IN (${excludeIds.map((_, i) => `$${i + 3}`).join(',')})` : '';
    const fallback = await sql.unsafe<{
      id: string;
      prompt: Record<string, string>;
      difficulty: string;
      category_id: string;
      payload: unknown;
    }[]>(
      `
      SELECT q.id, q.prompt, q.difficulty, q.category_id, qp.payload
      FROM questions q
      JOIN categories c ON c.id = q.category_id
      JOIN question_payloads qp ON qp.question_id = q.id
      WHERE q.category_id = $1
        AND c.is_active = true
        AND q.status = 'published'
        AND q.type = 'mcq_single'
      ${VALID_PAYLOAD_CONDITIONS}
      ${excludeCondition}
      ORDER BY RANDOM()
      LIMIT $2
      `,
      [categoryId, remaining, ...excludeIds]
    );

    return [...sampled, ...fallback];
  },

  async getRandomQuestionCandidatesForMatch(params: {
    matchId: string;
    categoryIds: string[];
    difficulties?: Array<'easy' | 'medium' | 'hard'>;
    questionTypes?: QuestionType[];
    limit?: number;
  }): Promise<{
    id: string;
    prompt: Record<string, string>;
    difficulty: string;
    category_id: string;
    payload: unknown;
  }[]> {
    return withSpan('db.matches.getRandomQuestionCandidatesForMatch', {
      'db.operation.name': 'select',
      'quizball.match_id': params.matchId,
      'quizball.category_count': params.categoryIds.length,
      'quizball.difficulty_count': params.difficulties?.length ?? 0,
    }, async (span) => {
      const questionTypes = params.questionTypes?.length
        ? params.questionTypes
        : ['mcq_single'];
      const includesMcq = questionTypes.includes('mcq_single');
      const perRowMcqPayloadValidation = VALID_PAYLOAD_CONDITIONS.replace(/^\s*AND\s*/u, '');

      const rows = await sql.unsafe<{
        id: string;
        prompt: Record<string, string>;
        difficulty: string;
        category_id: string;
        payload: unknown;
      }[]>(
        `
        SELECT q.id, q.prompt, q.difficulty, q.category_id, qp.payload
        FROM questions q
        JOIN categories c ON c.id = q.category_id
        JOIN question_payloads qp ON qp.question_id = q.id
        WHERE q.category_id = ANY($2::uuid[])
          AND c.is_active = true
          AND q.status = 'published'
          AND q.type = ANY($3::text[])
          ${includesMcq ? `AND (q.type <> 'mcq_single' OR (${perRowMcqPayloadValidation}))` : ''}
          ${params.difficulties?.length ? 'AND q.difficulty = ANY($4::text[])' : ''}
          AND NOT EXISTS (
            SELECT 1
            FROM match_questions mq
            WHERE mq.match_id = $1
              AND mq.question_id = q.id
          )
        ORDER BY RANDOM()
        LIMIT $${params.difficulties?.length ? 5 : 4}
        `,
        [
          params.matchId,
          params.categoryIds,
          questionTypes,
          ...(params.difficulties?.length ? [params.difficulties] : []),
          params.limit ?? 1,
        ]
      );
      span.setAttribute('quizball.question_found', rows.length > 0);
      span.setAttribute('quizball.question_candidate_count', rows.length);
      return rows;
    });
  },

  async getRandomQuestionForMatch(params: {
    matchId: string;
    categoryIds: string[];
    difficulties?: Array<'easy' | 'medium' | 'hard'>;
    questionTypes?: QuestionType[];
  }): Promise<{
    id: string;
    prompt: Record<string, string>;
    difficulty: string;
    category_id: string;
    payload: unknown;
  } | null> {
    const rows = await this.getRandomQuestionCandidatesForMatch({ ...params, limit: 1 });
    return rows[0] ?? null;
  },

  async getMatchQuestion(matchId: string, qIndex: number): Promise<MatchQuestionWithCategory | null> {
    return withSpan('db.matches.get_question', {
      'db.operation.name': 'select',
      'quizball.match_id': matchId,
      'quizball.q_index': qIndex,
    }, async (span) => {
      const [row] = await sql<MatchQuestionWithCategory[]>`
        SELECT mq.question_id, mq.q_index, mq.category_id, mq.correct_index,
               mq.phase_kind, mq.phase_round, mq.shooter_seat, mq.attacker_seat,
               q.prompt, q.difficulty, qp.payload,
               c.name as category_name, c.icon as category_icon
        FROM match_questions mq
        JOIN questions q ON q.id = mq.question_id
        LEFT JOIN question_payloads qp ON qp.question_id = q.id
        JOIN categories c ON c.id = mq.category_id
        WHERE mq.match_id = ${matchId} AND mq.q_index = ${qIndex}
      `;
      span.setAttribute('quizball.question_found', Boolean(row));
      return row ?? null;
    });
  },

  async getMatchQuestionTiming(matchId: string, qIndex: number): Promise<MatchQuestionTimingRow | null> {
    return withSpan('db.matches.get_question_timing', {
      'db.operation.name': 'select',
      'quizball.match_id': matchId,
      'quizball.q_index': qIndex,
    }, async (span) => {
      const [row] = await sql<MatchQuestionTimingRow[]>`
        SELECT shown_at, deadline_at
        FROM match_questions
        WHERE match_id = ${matchId} AND q_index = ${qIndex}
      `;
      span.setAttribute('quizball.question_timing_found', Boolean(row));
      return row ?? null;
    });
  },

  async setQuestionTiming(matchId: string, qIndex: number, shownAt: Date, deadlineAt: Date): Promise<void> {
    await sql`
      UPDATE match_questions
      SET shown_at = ${shownAt}, deadline_at = ${deadlineAt}
      WHERE match_id = ${matchId} AND q_index = ${qIndex}
    `;
  },

  // ─── match_answers facade delegates ───
  // Real implementations live in matchAnswersRepo. Kept here so existing
  // matchesRepo.* call sites compile unchanged.
  insertMatchAnswer: (data: Parameters<typeof matchAnswersRepo.insertMatchAnswer>[0]) =>
    matchAnswersRepo.insertMatchAnswer(data),

  insertMatchAnswerIfMissing: (data: Parameters<typeof matchAnswersRepo.insertMatchAnswerIfMissing>[0]) =>
    matchAnswersRepo.insertMatchAnswerIfMissing(data),

  listAnswersForQuestion: (matchId: string, qIndex: number) =>
    matchAnswersRepo.listAnswersForQuestion(matchId, qIndex),

  listAnswersForMatch: (matchId: string) =>
    matchAnswersRepo.listAnswersForMatch(matchId),

  getAnswerForUser: (matchId: string, qIndex: number, userId: string) =>
    matchAnswersRepo.getAnswerForUser(matchId, qIndex, userId),

  updatePlayerTotals: (matchId: string, userId: string, points: number, isCorrect: boolean) =>
    matchPlayersRepo.updatePlayerTotals(matchId, userId, points, isCorrect),

  setPlayerFinalTotals: (
    matchId: string,
    userId: string,
    values: {
      totalPoints: number;
      correctAnswers: number;
      goals: number;
      penaltyGoals: number;
    },
  ) => matchPlayersRepo.setPlayerFinalTotals(matchId, userId, values),

  async setMatchCurrentIndex(matchId: string, qIndex: number): Promise<void> {
    await sql`
      UPDATE matches
      SET current_q_index = ${qIndex}
      WHERE id = ${matchId} AND current_q_index < ${qIndex}
    `;
  },

  async setMatchStatePayload(
    matchId: string,
    statePayload: unknown,
    qIndex?: number
  ): Promise<void> {
    await withSpan('db.matches.set_state_payload', {
      'db.operation.name': 'update',
      'quizball.match_id': matchId,
      'quizball.q_index': qIndex ?? -1,
    }, async () => {
      const jsonPayload = sql.json(statePayload as Json ?? null);
      if (qIndex === undefined) {
        await sql`
          UPDATE matches
          SET state_payload = ${jsonPayload}
          WHERE id = ${matchId}
        `;
        return;
      }

      await sql`
        UPDATE matches
        SET state_payload = ${jsonPayload},
            current_q_index = GREATEST(current_q_index, ${qIndex})
        WHERE id = ${matchId}
      `;
    });
  },

  async setMatchCategoryB(matchId: string, categoryBId: string | null): Promise<void> {
    await sql`
      UPDATE matches
      SET category_b_id = ${categoryBId}
      WHERE id = ${matchId}
    `;
  },

  updatePlayerGoalTotals: (
    matchId: string,
    userId: string,
    changes: { goals?: number; penaltyGoals?: number },
  ) => matchPlayersRepo.updatePlayerGoalTotals(matchId, userId, changes),

  // Facade delegate — real implementation lives in matchEventsRepo.
  // Kept here so existing call sites (`matchesRepo.insertGoalEventIfMissing(…)`)
  // keep working unchanged through the split. Will be removed in a follow-up
  // PR once all callers have migrated to the entity repo.
  insertGoalEventIfMissing: (data: {
    matchId: string;
    userId: string;
    seat: 1 | 2;
    half: 1 | 2;
    phaseKind: MatchQuestionPhaseKind;
    qIndex: number | null;
    isPenalty: boolean;
  }): Promise<MatchGoalEventRow | null> => matchEventsRepo.insertGoalEventIfMissing(data),

  // incrementGoalsAndInsertEventIfMissing moved to matchesService in
  // Step 3 of the repo split. Cross-entity transactions (writes to both
  // match_goal_events and match_players) are owned by the service layer
  // so the repos can stay table-pure.

  getPlayerBySeat: (matchId: string, seat: 1 | 2) =>
    matchPlayersRepo.getPlayerBySeat(matchId, seat),

  /**
   * Atomically flip a match to "completed" and return the metadata the
   * service needs to make downstream stat decisions. Returns `null` if
   * the row was already in a terminal state — idempotency-safe so
   * concurrent callers can't double-complete the same match.
   *
   * Service layer drives the transaction; this just executes the write.
   */
  async markMatchCompleted(
    tx: TransactionSql,
    matchId: string,
    winnerId: string | null,
  ): Promise<Pick<MatchRow, 'id' | 'mode' | 'ended_at' | 'is_dev'> | null> {
    // Same tx.unsafe pattern used by listMatchPlayers above and other
    // tx-aware repos in this codebase (TransactionSql doesn't expose the
    // tagged-template call signature cleanly to TS).
    const rows = await tx.unsafe<Pick<MatchRow, 'id' | 'mode' | 'ended_at' | 'is_dev'>[]>(
      `
      UPDATE matches
      SET status = 'completed', winner_user_id = $2, ended_at = NOW()
      WHERE id = $1 AND status = 'active'
      RETURNING id, mode, ended_at, is_dev
      `,
      [matchId, winnerId],
    );
    return rows[0] ?? null;
  },

  /**
   * Multi-row upsert into user_mode_match_stats. Service pre-computes
   * wins/losses/draws — repo just writes what it's given.
   *
   * Uses tx.unsafe with a dynamically-built placeholder string because
   * postgres.js's TransactionSql type doesn't expose the helper-call
   * form (`tx(rows)`) for variable VALUES clauses — only tagged
   * templates. Parameters are still bound positionally, so this is
   * injection-safe; the only "unsafe" bit is the dynamically-sized
   * placeholder list itself (no user data in the SQL string).
   */
  async recordUserModeStats(
    tx: TransactionSql,
    rows: Array<{
      userId: string;
      mode: 'friendly' | 'ranked';
      wins: 0 | 1;
      losses: 0 | 1;
      draws: 0 | 1;
      lastMatchAt: string | null;
    }>,
  ): Promise<void> {
    if (rows.length === 0) return;
    const params: (string | number | null)[] = [];
    const placeholders: string[] = [];
    rows.forEach((r, i) => {
      const off = i * 6;
      placeholders.push(
        `($${off + 1}, $${off + 2}, 1, $${off + 3}, $${off + 4}, $${off + 5}, $${off + 6}, NOW())`,
      );
      params.push(r.userId, r.mode, r.wins, r.losses, r.draws, r.lastMatchAt);
    });
    await tx.unsafe(
      `
      INSERT INTO user_mode_match_stats (
        user_id, mode, games_played, wins, losses, draws, last_match_at, updated_at
      )
      VALUES ${placeholders.join(', ')}
      ON CONFLICT (user_id, mode) DO UPDATE SET
        games_played = user_mode_match_stats.games_played + 1,
        wins = user_mode_match_stats.wins + EXCLUDED.wins,
        losses = user_mode_match_stats.losses + EXCLUDED.losses,
        draws = user_mode_match_stats.draws + EXCLUDED.draws,
        last_match_at = COALESCE(
          GREATEST(user_mode_match_stats.last_match_at, EXCLUDED.last_match_at),
          EXCLUDED.last_match_at,
          user_mode_match_stats.last_match_at
        ),
        updated_at = NOW()
      `,
      params,
    );
  },

  updatePlayerAvgTime: (matchId: string, userId: string, avgTimeMs: number | null) =>
    matchPlayersRepo.updatePlayerAvgTime(matchId, userId, avgTimeMs),

  setPlayerForfeitWinTotals: (
    matchId: string,
    userId: string,
    totalPoints: number,
    correctAnswers: number,
  ) => matchPlayersRepo.setPlayerForfeitWinTotals(matchId, userId, totalPoints, correctAnswers),

  getAverageTimes: (matchId: string) =>
    matchAnswersRepo.getAverageTimes(matchId),

  async getMatch(matchId: string): Promise<MatchRow | null> {
    const [row] = await sql<MatchRow[]>`
      SELECT * FROM matches WHERE id = ${matchId}
    `;
    return row ?? null;
  },

  async getActiveMatchForLobby(lobbyId: string): Promise<MatchRow | null> {
    const [row] = await sql<MatchRow[]>`
      SELECT * FROM matches
      WHERE lobby_id = ${lobbyId} AND status = 'active'
      ORDER BY started_at DESC
      LIMIT 1
    `;
    return row ?? null;
  },

  async getActiveMatchForUser(userId: string): Promise<MatchRow | null> {
    const [row] = await sql<MatchRow[]>`
      SELECT m.*
      FROM matches m
      JOIN match_players mp ON mp.match_id = m.id
      WHERE mp.user_id = ${userId} AND m.status = 'active'
      ORDER BY m.started_at DESC
      LIMIT 1
    `;
    return row ?? null;
  },

  /**
   * Delete old dev matches, keeping only the most recent `keep` completed ones.
   * Cascades to match_players, match_questions, match_answers via FK.
   * Also cleans up orphaned AI users that were created for dev matches.
   */
  async cleanupOldDevMatches(keep: number): Promise<number> {
    const deleted = await sql<{ id: string }[]>`
      WITH matches_to_delete AS (
        SELECT id
        FROM matches
        WHERE is_dev = true AND status IN ('completed', 'abandoned')
        ORDER BY started_at DESC
        OFFSET ${keep}
      ),
      orphaned_ai_users AS (
        SELECT DISTINCT mp.user_id
        FROM match_players mp
        JOIN users u ON u.id = mp.user_id
        WHERE mp.match_id IN (SELECT id FROM matches_to_delete)
          AND u.is_ai = true
          AND NOT EXISTS (
            SELECT 1 FROM match_players mp2
            WHERE mp2.user_id = mp.user_id
              AND mp2.match_id NOT IN (SELECT id FROM matches_to_delete)
          )
      ),
      del_answers AS (
        DELETE FROM match_answers WHERE match_id IN (SELECT id FROM matches_to_delete)
      ),
      del_questions AS (
        DELETE FROM match_questions WHERE match_id IN (SELECT id FROM matches_to_delete)
      ),
      del_players AS (
        DELETE FROM match_players WHERE match_id IN (SELECT id FROM matches_to_delete)
      ),
      del_matches AS (
        DELETE FROM matches WHERE id IN (SELECT id FROM matches_to_delete)
        RETURNING id
      ),
      del_ai_users AS (
        DELETE FROM users WHERE id IN (SELECT user_id FROM orphaned_ai_users)
      )
      SELECT id FROM del_matches
    `;
    return deleted.length;
  },

  async abandonMatch(matchId: string): Promise<boolean> {
    const rows = await sql<{ id: string }[]>`
      UPDATE matches
      SET status = 'abandoned', ended_at = NOW()
      WHERE id = ${matchId} AND status = 'active'
      RETURNING id
    `;
    return rows.length > 0;
  },
};
