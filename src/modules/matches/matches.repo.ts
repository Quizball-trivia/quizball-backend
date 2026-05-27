import { sql, type TransactionSql } from '../../db/index.js';
import { matchAnswersRepo } from './match-answers.repo.js';
import { matchEventsRepo } from './match-events.repo.js';
import { matchPlayersRepo } from './match-players.repo.js';
import { matchQuestionsRepo } from './match-questions.repo.js';
import type { Json } from '../../db/types.js';
import { withSpan } from '../../core/tracing.js';
import type {
  MatchRow,
  MatchGoalEventRow,
  MatchQuestionPhaseKind,
} from './matches.types.js';
import type { RankedLobbyContext } from '../lobbies/lobbies.types.js';

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

  // ─── match_questions facade delegates ───
  // Real implementations live in matchQuestionsRepo. Kept here so existing
  // matchesRepo.* call sites compile unchanged.
  insertMatchQuestions: (
    matchId: string,
    questions: Parameters<typeof matchQuestionsRepo.insertMatchQuestions>[1],
  ) => matchQuestionsRepo.insertMatchQuestions(matchId, questions),

  insertMatchQuestionIfMissing: (question: Parameters<typeof matchQuestionsRepo.insertMatchQuestionIfMissing>[0]) =>
    matchQuestionsRepo.insertMatchQuestionIfMissing(question),

  getRandomQuestionsForCategory: (categoryId: string, limit: number) =>
    matchQuestionsRepo.getRandomQuestionsForCategory(categoryId, limit),

  getRandomQuestionCandidatesForMatch: (params: Parameters<typeof matchQuestionsRepo.getRandomQuestionCandidatesForMatch>[0]) =>
    matchQuestionsRepo.getRandomQuestionCandidatesForMatch(params),

  getRandomQuestionForMatch: (params: Parameters<typeof matchQuestionsRepo.getRandomQuestionForMatch>[0]) =>
    matchQuestionsRepo.getRandomQuestionForMatch(params),

  getMatchQuestion: (matchId: string, qIndex: number) =>
    matchQuestionsRepo.getMatchQuestion(matchId, qIndex),

  getMatchQuestionTiming: (matchId: string, qIndex: number) =>
    matchQuestionsRepo.getMatchQuestionTiming(matchId, qIndex),

  setQuestionTiming: (matchId: string, qIndex: number, shownAt: Date, deadlineAt: Date) =>
    matchQuestionsRepo.setQuestionTiming(matchId, qIndex, shownAt, deadlineAt),

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
  // cleanupOldDevMatches moved to matchesService in Step 7 of the repo
  // split. It's a lifecycle/admin operation that spans 5 tables (4 match
  // tables + orphan AI users), so it belongs in the service layer rather
  // than this table-pure repo.

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
