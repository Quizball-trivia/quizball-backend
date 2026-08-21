import { sql, type TransactionSql } from '../../db/index.js';
import type { GoalChoreographyRow, GgtSessionRow } from './guess-the-goal.types.js';
import { GGT_REWARD_EVENT, GGT_XP_SOURCE } from './guess-the-goal.constants.js';

/** postgres.js TransactionSql loses its call signature through the type
 *  re-export; the repo-wide convention is to cast (see tuning.repo.ts). */
const exec = (tx: TransactionSql): typeof sql => tx as unknown as typeof sql;

export const guessTheGoalRepo = {
  /** Serialize all session-starting work for one user (advisory xact lock):
   *  parallel starts otherwise race the nonce check and the abandon step. */
  async acquireUserStartLock(tx: TransactionSql, userId: string): Promise<void> {
    await exec(tx)`SELECT pg_advisory_xact_lock(hashtextextended(${'ggt:' + userId}, 0))`;
  },

  async getPublishedGoal(goalId: string): Promise<GoalChoreographyRow | null> {
    const [row] = await sql<GoalChoreographyRow[]>`
      SELECT * FROM goal_choreographies
      WHERE id = ${goalId} AND status = 'published'
    `;
    return row ?? null;
  },

  /**
   * Pick the next goal for a user: published, not yet solved, preferring goals
   * never seen in any prior session, and (when the unsolved pool allows) never
   * the goal from the user's most recent session — back-to-back repeats read
   * as broken. Falls back to any published goal when the user has solved the
   * whole pool (replay for fun, no rewards).
   */
  async pickNextGoal(tx: TransactionSql, userId: string): Promise<GoalChoreographyRow | null> {
    const [lastServed] = await exec(tx)<Array<{ goal_id: string }>>`
      SELECT goal_id FROM guess_the_goal_sessions
      WHERE user_id = ${userId}
      ORDER BY started_at DESC
      LIMIT 1
    `;
    const lastGoalId = lastServed?.goal_id ?? null;
    const [row] = await exec(tx)<GoalChoreographyRow[]>`
      SELECT g.* FROM goal_choreographies g
      WHERE g.status = 'published'
        AND NOT EXISTS (
          SELECT 1 FROM guess_the_goal_solves s
          WHERE s.user_id = ${userId} AND s.goal_id = g.id
        )
        AND (${lastGoalId}::uuid IS NULL OR g.id <> ${lastGoalId}::uuid)
      ORDER BY
        EXISTS (
          SELECT 1 FROM guess_the_goal_sessions ss
          WHERE ss.user_id = ${userId} AND ss.goal_id = g.id
        ) ASC,
        random()
      LIMIT 1
    `;
    if (row) return row;
    // Single-goal pool (or the only unsolved goal was just served): allow the
    // repeat rather than stall the kick-off.
    const [unsolvedRepeat] = await exec(tx)<GoalChoreographyRow[]>`
      SELECT g.* FROM goal_choreographies g
      WHERE g.status = 'published'
        AND NOT EXISTS (
          SELECT 1 FROM guess_the_goal_solves s
          WHERE s.user_id = ${userId} AND s.goal_id = g.id
        )
      ORDER BY random()
      LIMIT 1
    `;
    if (unsolvedRepeat) return unsolvedRepeat;
    const [fallback] = await exec(tx)<GoalChoreographyRow[]>`
      SELECT * FROM goal_choreographies
      WHERE status = 'published'
      ORDER BY random()
      LIMIT 1
    `;
    return fallback ?? null;
  },

  async hasSeenGoal(tx: TransactionSql, userId: string, goalId: string): Promise<boolean> {
    const [row] = await exec(tx)<Array<{ seen: boolean }>>`
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

  async getSessionByNonce(
    tx: TransactionSql,
    userId: string,
    clientNonce: string
  ): Promise<GgtSessionRow | null> {
    const [row] = await exec(tx)<GgtSessionRow[]>`
      SELECT * FROM guess_the_goal_sessions
      WHERE user_id = ${userId} AND client_nonce = ${clientNonce}
    `;
    return row ?? null;
  },

  /** Finished (guessed/complete) session lookup — mutation-retry replay. */
  async getFinishedSession(
    tx: TransactionSql,
    userId: string,
    sessionId: string
  ): Promise<GgtSessionRow | null> {
    const [row] = await exec(tx)<GgtSessionRow[]>`
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

  /** Solved gallery cards, read from the SOLVING SESSION'S immutable snapshot
   *  (title/video as the user actually saw them — the live row can be edited
   *  after the fact, and a live read would hand out a new, unplayed answer). */
  async solvedGalleryRows(
    tx: TransactionSql,
    userId: string
  ): Promise<
    Array<{
      difficulty: string;
      title: unknown;
      year: number;
      video_url: string | null;
      solved_at: string;
      points: number | null;
      bonus_correct: boolean | null;
    }>
  > {
    return exec(tx)`
      SELECT g.difficulty, g.year,
             sess.goal_snapshot->'title' AS title,
             sess.goal_snapshot->>'video_url' AS video_url,
             s.solved_at, sess.points, sess.bonus_correct
      FROM guess_the_goal_solves s
      JOIN goal_choreographies g ON g.id = s.goal_id AND g.status = 'published'
      JOIN guess_the_goal_sessions sess ON sess.id = s.session_id
      WHERE s.user_id = ${userId}
      ORDER BY s.solved_at
    ` as unknown as Promise<
      Array<{
        difficulty: string;
        title: unknown;
        year: number;
        video_url: string | null;
        solved_at: string;
        points: number | null;
        bonus_correct: boolean | null;
      }>
    >;
  },

  /** Unsolved goals as per-difficulty COUNTS only — even redacted rows leak a
   *  stable global ordering, so unplayed goals never get individual entries. */
  async unsolvedCounts(tx: TransactionSql, userId: string): Promise<Record<string, number>> {
    const rows = await exec(tx)<Array<{ difficulty: string; count: number | string }>>`
      SELECT g.difficulty, COUNT(*) AS count
      FROM goal_choreographies g
      LEFT JOIN guess_the_goal_solves s ON s.goal_id = g.id AND s.user_id = ${userId}
      WHERE g.status = 'published' AND s.user_id IS NULL
      GROUP BY g.difficulty
    `;
    return Object.fromEntries(rows.map((r) => [r.difficulty, Number(r.count)]));
  },

  /** All-time coins + XP earned from this mode (progress screen totals). */
  async lifetimeEarnings(tx: TransactionSql, userId: string): Promise<{ coins: number; xp: number }> {
    const [row] = await exec(tx)<Array<{ coins: number | string | null; xp: number | string | null }>>`
      SELECT
        (SELECT COALESCE(SUM(coins_delta), 0)
         FROM store_transaction_logs
         WHERE user_id = ${userId} AND event_type = ${GGT_REWARD_EVENT} AND outcome = 'success') AS coins,
        (SELECT COALESCE(SUM(xp_delta), 0)
         FROM user_xp_events
         WHERE user_id = ${userId} AND source_type = ${GGT_XP_SOURCE}) AS xp
    `;
    return { coins: Number(row?.coins ?? 0), xp: Number(row?.xp ?? 0) };
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
