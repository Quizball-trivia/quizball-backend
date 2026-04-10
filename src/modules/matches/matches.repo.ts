import { sql } from '../../db/index.js';
import type { Json } from '../../db/types.js';
import { AppError } from '../../core/errors.js';
import { withSpan } from '../../core/tracing.js';
import { VALID_PAYLOAD_CONDITIONS_RAW as VALID_PAYLOAD_CONDITIONS } from '../../db/sql-fragments.js';
import type {
  MatchRow,
  MatchPlayerRow,
  MatchQuestionRow,
  MatchAnswerRow,
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

  async insertMatchPlayers(matchId: string, players: Array<{ userId: string; seat: number }>): Promise<MatchPlayerRow[]> {
    if (players.length === 0) return [];
    const rows = players.map((p) => [matchId, p.userId, p.seat]);

    return sql<MatchPlayerRow[]>`
      INSERT INTO match_players (match_id, user_id, seat)
      VALUES ${sql(rows)}
      RETURNING *
    `;
  },

  async listMatchPlayers(matchId: string): Promise<MatchPlayerRow[]> {
    return withSpan('db.matches.list_players', {
      'db.operation.name': 'select',
      'quizball.match_id': matchId,
    }, async () => sql<MatchPlayerRow[]>`
      SELECT * FROM match_players WHERE match_id = ${matchId} ORDER BY seat ASC
    `);
  },

  async getPlayerTotalPoints(matchId: string, userId: string): Promise<number> {
    const [row] = await sql<{ total_points: number }[]>`
      SELECT total_points FROM match_players
      WHERE match_id = ${matchId} AND user_id = ${userId}
    `;
    return row?.total_points ?? 0;
  },

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

  async insertMatchAnswer(data: {
    matchId: string;
    qIndex: number;
    userId: string;
    selectedIndex: number | null;
    isCorrect: boolean;
    timeMs: number;
    pointsEarned: number;
    phaseKind?: MatchQuestionPhaseKind;
    phaseRound?: number | null;
    shooterSeat?: number | null;
  }): Promise<MatchAnswerRow> {
    try {
      const [row] = await sql<MatchAnswerRow[]>`
        INSERT INTO match_answers (
          match_id, q_index, user_id, selected_index, is_correct, time_ms, points_earned, phase_kind, phase_round, shooter_seat
        )
        VALUES (
          ${data.matchId}, ${data.qIndex}, ${data.userId}, ${data.selectedIndex},
          ${data.isCorrect}, ${data.timeMs}, ${data.pointsEarned}, ${data.phaseKind ?? 'normal'}, ${data.phaseRound ?? null}, ${data.shooterSeat ?? null}
        )
        RETURNING *
      `;
      return row;
    } catch (err) {
      throw new AppError('Failed to insert match answer', 500, 'INTERNAL_ERROR', err);
    }
  },

  async insertMatchAnswerIfMissing(data: {
    matchId: string;
    qIndex: number;
    userId: string;
    selectedIndex: number | null;
    isCorrect: boolean;
    timeMs: number;
    pointsEarned: number;
    phaseKind?: MatchQuestionPhaseKind;
    phaseRound?: number | null;
    shooterSeat?: number | null;
  }): Promise<MatchAnswerRow | null> {
    return withSpan('db.matches.insert_answer_if_missing', {
      'db.operation.name': 'insert',
      'quizball.match_id': data.matchId,
      'quizball.q_index': data.qIndex,
      'quizball.user_id': data.userId,
      'quizball.phase_kind': data.phaseKind ?? 'normal',
    }, async (span) => {
      try {
        const [row] = await sql<MatchAnswerRow[]>`
          INSERT INTO match_answers (
            match_id, q_index, user_id, selected_index, is_correct, time_ms, points_earned, phase_kind, phase_round, shooter_seat
          )
          VALUES (
            ${data.matchId}, ${data.qIndex}, ${data.userId}, ${data.selectedIndex},
            ${data.isCorrect}, ${data.timeMs}, ${data.pointsEarned}, ${data.phaseKind ?? 'normal'}, ${data.phaseRound ?? null}, ${data.shooterSeat ?? null}
          )
          ON CONFLICT (match_id, q_index, user_id) DO NOTHING
          RETURNING *
        `;
        span.setAttribute('quizball.answer_inserted', Boolean(row));
        return row ?? null;
      } catch (err) {
        throw new AppError('Failed to insert match answer', 500, 'INTERNAL_ERROR', err);
      }
    });
  },

  async listAnswersForQuestion(matchId: string, qIndex: number): Promise<MatchAnswerRow[]> {
    return withSpan('db.matches.list_answers_for_question', {
      'db.operation.name': 'select',
      'quizball.match_id': matchId,
      'quizball.q_index': qIndex,
    }, async (span) => {
      const rows = await sql<MatchAnswerRow[]>`
        SELECT * FROM match_answers WHERE match_id = ${matchId} AND q_index = ${qIndex}
      `;
      span.setAttribute('quizball.answer_count', rows.length);
      return rows;
    });
  },

  async getAnswerForUser(matchId: string, qIndex: number, userId: string): Promise<MatchAnswerRow | null> {
    const [row] = await sql<MatchAnswerRow[]>`
      SELECT * FROM match_answers WHERE match_id = ${matchId} AND q_index = ${qIndex} AND user_id = ${userId}
    `;
    return row ?? null;
  },

  async updatePlayerTotals(matchId: string, userId: string, points: number, isCorrect: boolean): Promise<MatchPlayerRow | null> {
    const [row] = await sql<MatchPlayerRow[]>`
      UPDATE match_players
      SET
        total_points = total_points + ${points},
        correct_answers = correct_answers + ${isCorrect ? 1 : 0}
      WHERE match_id = ${matchId} AND user_id = ${userId}
      RETURNING *
    `;
    return row ?? null;
  },

  async setPlayerFinalTotals(
    matchId: string,
    userId: string,
    values: {
      totalPoints: number;
      correctAnswers: number;
      goals: number;
      penaltyGoals: number;
    }
  ): Promise<MatchPlayerRow | null> {
    const [row] = await sql<MatchPlayerRow[]>`
      UPDATE match_players
      SET
        total_points = ${values.totalPoints},
        correct_answers = ${values.correctAnswers},
        goals = ${values.goals},
        penalty_goals = ${values.penaltyGoals}
      WHERE match_id = ${matchId} AND user_id = ${userId}
      RETURNING *
    `;
    return row ?? null;
  },

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

  async updatePlayerGoalTotals(
    matchId: string,
    userId: string,
    changes: { goals?: number; penaltyGoals?: number }
  ): Promise<MatchPlayerRow | null> {
    const [row] = await sql<MatchPlayerRow[]>`
      UPDATE match_players
      SET
        goals = goals + ${changes.goals ?? 0},
        penalty_goals = penalty_goals + ${changes.penaltyGoals ?? 0}
      WHERE match_id = ${matchId} AND user_id = ${userId}
      RETURNING *
    `;
    return row ?? null;
  },

  async getPlayerBySeat(matchId: string, seat: 1 | 2): Promise<MatchPlayerRow | null> {
    const [row] = await sql<MatchPlayerRow[]>`
      SELECT * FROM match_players
      WHERE match_id = ${matchId} AND seat = ${seat}
      LIMIT 1
    `;
    return row ?? null;
  },

  async completeMatch(matchId: string, winnerId: string | null): Promise<void> {
    await sql.begin(async (tx) => {
      const completedRows = await tx.unsafe<Pick<MatchRow, 'id' | 'mode' | 'ended_at' | 'is_dev'>[]>(
        `
        UPDATE matches
        SET status = 'completed', winner_user_id = $2, ended_at = NOW()
        WHERE id = $1 AND status = 'active'
        RETURNING id, mode, ended_at, is_dev
        `,
        [matchId, winnerId]
      );
      const completedMatch = completedRows[0];

      // Idempotency guard: if already completed/abandoned, skip aggregate updates.
      if (!completedMatch) {
        return;
      }

      // Dev matches don't affect user stats
      if (completedMatch.is_dev) {
        return;
      }

      const matchPlayers = await tx.unsafe<Pick<MatchPlayerRow, 'user_id'>[]>(
        `
        SELECT user_id
        FROM match_players
        WHERE match_id = $1
        `,
        [matchId]
      );

      if (matchPlayers.length > 0) {
        // Build a single multi-row upsert instead of one INSERT per player
        const values: (string | number | Date | null)[] = [];
        const placeholders: string[] = [];
        for (let i = 0; i < matchPlayers.length; i++) {
          const player = matchPlayers[i];
          const isDraw = winnerId === null;
          const isWinner = winnerId !== null && winnerId === player.user_id;
          const offset = i * 6;
          placeholders.push(
            `($${offset + 1}, $${offset + 2}, 1, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, NOW())`
          );
          values.push(
            player.user_id,
            completedMatch.mode,
            isWinner ? 1 : 0,
            !isDraw && !isWinner ? 1 : 0,
            isDraw ? 1 : 0,
            completedMatch.ended_at,
          );
        }

        await tx.unsafe(
          `
          INSERT INTO user_mode_match_stats (
            user_id, mode, games_played, wins, losses, draws, last_match_at, updated_at
          )
          VALUES ${placeholders.join(', ')}
          ON CONFLICT (user_id, mode) DO UPDATE
          SET
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
          values
        );
      }
    });
  },

  async updatePlayerAvgTime(matchId: string, userId: string, avgTimeMs: number | null): Promise<void> {
    await sql`
      UPDATE match_players
      SET avg_time_ms = ${avgTimeMs}
      WHERE match_id = ${matchId} AND user_id = ${userId}
    `;
  },

  async setPlayerForfeitWinTotals(
    matchId: string,
    userId: string,
    totalPoints: number,
    correctAnswers: number
  ): Promise<void> {
    await sql`
      UPDATE match_players
      SET total_points = ${totalPoints},
          correct_answers = ${correctAnswers}
      WHERE match_id = ${matchId} AND user_id = ${userId}
    `;
  },

  async getAverageTimes(matchId: string): Promise<Array<{ user_id: string; avg_time_ms: number | null }>> {
    return sql<{ user_id: string; avg_time_ms: number | null }[]>`
      SELECT user_id, AVG(time_ms)::int as avg_time_ms
      FROM match_answers
      WHERE match_id = ${matchId}
      GROUP BY user_id
    `;
  },

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
