import { sql, type TransactionSql } from '../../db/index.js';
import { withSpan } from '../../core/tracing.js';
import type { MatchPlayerRow } from './matches.types.js';

/**
 * Pure-data repo for the `match_players` table.
 *
 * Owns inserts, reads, and updates of per-match player rows. Holds
 * tx-aware variants (`*InTx`) of methods that are used by
 * service-level orchestrators inside `matchesService` to compose
 * multi-table writes inside a single `sql.begin` transaction (e.g.
 * `recordPartyQuizAnswerIfMissing`,
 * `incrementGoalsAndInsertEventIfMissing`).
 */

export const matchPlayersRepo = {
  async insertMatchPlayers(
    matchId: string,
    players: Array<{ userId: string; seat: number }>,
  ): Promise<MatchPlayerRow[]> {
    if (players.length === 0) return [];
    const rows = players.map((p) => [matchId, p.userId, p.seat]);

    return sql<MatchPlayerRow[]>`
      INSERT INTO match_players (match_id, user_id, seat)
      VALUES ${sql(rows)}
      RETURNING *
    `;
  },

  async listMatchPlayers(matchId: string, tx?: TransactionSql): Promise<MatchPlayerRow[]> {
    // Accepts an optional transaction handle so callers like
    // matchesService.completeMatch can read roster INSIDE the same tx
    // that mutates user_mode_match_stats — keeps the snapshot consistent.
    return withSpan('db.matches.list_players', {
      'db.operation.name': 'select',
      'quizball.match_id': matchId,
    }, async () => {
      if (tx) {
        // postgres.js TransactionSql doesn't expose the tagged-template
        // call signature cleanly to TS, so use tx.unsafe inside the tx
        // (codebase precedent — see daily-challenges.repo, objectives.repo).
        return tx.unsafe<MatchPlayerRow[]>(
          `SELECT * FROM match_players WHERE match_id = $1 ORDER BY seat ASC`,
          [matchId],
        );
      }
      return sql<MatchPlayerRow[]>`
        SELECT * FROM match_players WHERE match_id = ${matchId} ORDER BY seat ASC
      `;
    });
  },

  async getPlayerTotalPoints(matchId: string, userId: string): Promise<number> {
    const [row] = await sql<{ total_points: number }[]>`
      SELECT total_points FROM match_players
      WHERE match_id = ${matchId} AND user_id = ${userId}
    `;
    return row?.total_points ?? 0;
  },

  async updatePlayerTotals(
    matchId: string,
    userId: string,
    points: number,
    isCorrect: boolean,
  ): Promise<MatchPlayerRow | null> {
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

  /**
   * Tx-aware variant of updatePlayerTotals. Used by
   * matchesService.recordPartyQuizAnswerIfMissing to compose with a
   * match_answers insert in one transaction.
   */
  async updatePlayerTotalsInTx(
    tx: TransactionSql,
    matchId: string,
    userId: string,
    points: number,
    isCorrect: boolean,
  ): Promise<MatchPlayerRow | null> {
    const rows = await tx.unsafe<MatchPlayerRow[]>(
      `
      UPDATE match_players
      SET total_points = total_points + $3,
          correct_answers = correct_answers + $4
      WHERE match_id = $1 AND user_id = $2
      RETURNING *
      `,
      [matchId, userId, points, isCorrect ? 1 : 0],
    );
    return rows[0] ?? null;
  },

  async setPlayerFinalTotals(
    matchId: string,
    userId: string,
    values: {
      totalPoints: number;
      correctAnswers: number;
      goals: number;
      penaltyGoals: number;
    },
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

  async updatePlayerGoalTotals(
    matchId: string,
    userId: string,
    changes: { goals?: number; penaltyGoals?: number },
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

  /**
   * Tx-aware variant of updatePlayerGoalTotals. Used by
   * matchesService.incrementGoalsAndInsertEventIfMissing to compose
   * with a match_goal_events insert in one transaction.
   */
  async updatePlayerGoalTotalsInTx(
    tx: TransactionSql,
    matchId: string,
    userId: string,
    changes: { goals?: number; penaltyGoals?: number },
  ): Promise<MatchPlayerRow | null> {
    const rows = await tx.unsafe<MatchPlayerRow[]>(
      `
      UPDATE match_players
      SET goals = goals + $3,
          penalty_goals = penalty_goals + $4
      WHERE match_id = $1 AND user_id = $2
      RETURNING *
      `,
      [matchId, userId, changes.goals ?? 0, changes.penaltyGoals ?? 0],
    );
    return rows[0] ?? null;
  },

  async getPlayerBySeat(matchId: string, seat: 1 | 2): Promise<MatchPlayerRow | null> {
    const [row] = await sql<MatchPlayerRow[]>`
      SELECT * FROM match_players
      WHERE match_id = ${matchId} AND seat = ${seat}
      LIMIT 1
    `;
    return row ?? null;
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
    correctAnswers: number,
  ): Promise<void> {
    await sql`
      UPDATE match_players
      SET total_points = ${totalPoints},
          correct_answers = ${correctAnswers}
      WHERE match_id = ${matchId} AND user_id = ${userId}
    `;
  },
};
