import { sql, type TransactionSql } from '../../db/index.js';
import type { GoalChoreographyRow, GgtSessionRow } from './guess-the-goal.types.js';
import { GGT_REWARD_EVENT } from './guess-the-goal.constants.js';

/** postgres.js TransactionSql loses its call signature through the type
 *  re-export; the repo-wide convention is to cast (see tuning.repo.ts). */
const exec = (tx: TransactionSql): typeof sql => tx as unknown as typeof sql;

export const guessTheGoalRepo = {
  async getPublishedGoal(goalId: string): Promise<GoalChoreographyRow | null> {
    const [row] = await sql<GoalChoreographyRow[]>`
      SELECT * FROM goal_choreographies
      WHERE id = ${goalId} AND status = 'published'
    `;
    return row ?? null;
  },

  /**
   * Pick the next goal for a user: published, not yet solved, preferring goals
   * never seen in any prior session. Falls back to any published goal when the
   * user has solved the whole pool (replay for fun, no rewards).
   */
  async pickNextGoal(userId: string): Promise<GoalChoreographyRow | null> {
    const [row] = await sql<GoalChoreographyRow[]>`
      SELECT g.* FROM goal_choreographies g
      WHERE g.status = 'published'
        AND NOT EXISTS (
          SELECT 1 FROM guess_the_goal_solves s
          WHERE s.user_id = ${userId} AND s.goal_id = g.id
        )
      ORDER BY
        EXISTS (
          SELECT 1 FROM guess_the_goal_sessions ss
          WHERE ss.user_id = ${userId} AND ss.goal_id = g.id
        ) ASC,
        random()
      LIMIT 1
    `;
    if (row) return row;
    const [fallback] = await sql<GoalChoreographyRow[]>`
      SELECT * FROM goal_choreographies
      WHERE status = 'published'
      ORDER BY random()
      LIMIT 1
    `;
    return fallback ?? null;
  },

  async hasSeenGoal(userId: string, goalId: string): Promise<boolean> {
    const [row] = await sql<Array<{ seen: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM guess_the_goal_sessions
        WHERE user_id = ${userId} AND goal_id = ${goalId}
      ) AS seen
    `;
    return row?.seen ?? false;
  },

  async hasSolvedGoal(userId: string, goalId: string): Promise<boolean> {
    const [row] = await sql<Array<{ solved: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM guess_the_goal_solves
        WHERE user_id = ${userId} AND goal_id = ${goalId}
      ) AS solved
    `;
    return row?.solved ?? false;
  },

  async getSessionByNonce(userId: string, clientNonce: string): Promise<GgtSessionRow | null> {
    const [row] = await sql<GgtSessionRow[]>`
      SELECT * FROM guess_the_goal_sessions
      WHERE user_id = ${userId} AND client_nonce = ${clientNonce}
    `;
    return row ?? null;
  },

  /** Finished (guessed/complete) session lookup — mutation-retry replay. */
  async getFinishedSession(userId: string, sessionId: string): Promise<GgtSessionRow | null> {
    const [row] = await sql<GgtSessionRow[]>`
      SELECT * FROM guess_the_goal_sessions
      WHERE id = ${sessionId} AND user_id = ${userId} AND state IN ('guessed', 'complete')
    `;
    return row ?? null;
  },

  async getOpenSession(userId: string): Promise<GgtSessionRow | null> {
    const [row] = await sql<GgtSessionRow[]>`
      SELECT * FROM guess_the_goal_sessions
      WHERE user_id = ${userId} AND state IN ('active', 'guessed')
    `;
    return row ?? null;
  },

  async getOpenSessionForUpdate(
    tx: TransactionSql,
    userId: string
  ): Promise<GgtSessionRow | null> {
    const [row] = await exec(tx)<GgtSessionRow[]>`
      SELECT * FROM guess_the_goal_sessions
      WHERE user_id = ${userId} AND state IN ('active', 'guessed')
      FOR UPDATE
    `;
    return row ?? null;
  },

  async abandonSession(tx: TransactionSql, sessionId: string): Promise<void> {
    await exec(tx)`
      UPDATE guess_the_goal_sessions
      SET state = 'abandoned'
      WHERE id = ${sessionId} AND state IN ('active', 'guessed')
    `;
  },

  async insertSession(
    tx: TransactionSql,
    data: {
      userId: string;
      goalId: string;
      goalSnapshot: unknown;
      maxPoints: number;
      clientNonce: string | null;
    }
  ): Promise<GgtSessionRow> {
    const [row] = await exec(tx)<GgtSessionRow[]>`
      INSERT INTO guess_the_goal_sessions (user_id, goal_id, goal_snapshot, max_points, client_nonce)
      VALUES (
        ${data.userId}, ${data.goalId}, ${sql.json(data.goalSnapshot as never)},
        ${data.maxPoints}, ${data.clientNonce}
      )
      RETURNING *
    `;
    return row;
  },

  async updateSession(
    tx: TransactionSql,
    sessionId: string,
    patch: Record<string, unknown>
  ): Promise<GgtSessionRow | null> {
    const [row] = await exec(tx)<GgtSessionRow[]>`
      UPDATE guess_the_goal_sessions
      SET ${exec(tx)(patch as Record<string, never>)}
      WHERE id = ${sessionId}
      RETURNING *
    `;
    return row ?? null;
  },

  /** First-solve gate: returns true when this insert wins the (user, goal) PK. */
  async insertSolve(
    tx: TransactionSql,
    data: { userId: string; goalId: string; sessionId: string }
  ): Promise<boolean> {
    const rows = await exec(tx)<Array<{ user_id: string }>>`
      INSERT INTO guess_the_goal_solves (user_id, goal_id, session_id)
      VALUES (${data.userId}, ${data.goalId}, ${data.sessionId})
      ON CONFLICT (user_id, goal_id) DO NOTHING
      RETURNING user_id
    `;
    return rows.length > 0;
  },

  /** Coins already granted by this mode since UTC midnight (daily faucet cap). */
  async coinsGrantedToday(tx: TransactionSql, userId: string): Promise<number> {
    const [row] = await exec(tx)<Array<{ total: number | string | null }>>`
      SELECT COALESCE(SUM(coins_delta), 0) AS total
      FROM store_transaction_logs
      WHERE user_id = ${userId}
        AND event_type = ${GGT_REWARD_EVENT}
        AND outcome = 'success'
        AND created_at >= date_trunc('day', now() AT TIME ZONE 'utc') AT TIME ZONE 'utc'
    `;
    return Number(row?.total ?? 0);
  },

  /** Solved count over CURRENTLY PUBLISHED goals so progress can never read
   *  as 40/37 after content is archived. */
  async countSolved(userId: string): Promise<number> {
    const [row] = await sql<Array<{ count: number | string }>>`
      SELECT COUNT(*) AS count
      FROM guess_the_goal_solves s
      JOIN goal_choreographies g ON g.id = s.goal_id AND g.status = 'published'
      WHERE s.user_id = ${userId}
    `;
    return Number(row?.count ?? 0);
  },

  async countPublished(): Promise<number> {
    const [row] = await sql<Array<{ count: number | string }>>`
      SELECT COUNT(*) AS count FROM goal_choreographies WHERE status = 'published'
    `;
    return Number(row?.count ?? 0);
  },

  runInTransaction<T>(callback: (tx: TransactionSql) => Promise<T>): Promise<T> {
    return sql.begin(callback) as Promise<T>;
  },
};
