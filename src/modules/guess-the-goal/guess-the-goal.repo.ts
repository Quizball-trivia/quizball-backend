import { sql, type TransactionSql } from '../../db/index.js';
import type { GoalChoreographyRow, GgtPlayer, GgtSessionRow } from './guess-the-goal.types.js';
import { GGT_REWARD_EVENT, GGT_XP_SOURCE } from './guess-the-goal.constants.js';

/** postgres.js TransactionSql loses its call signature through the type
 *  re-export; the repo-wide convention is to cast (see tuning.repo.ts). */
const exec = (tx: TransactionSql): typeof sql => tx as unknown as typeof sql;

const ownedBy = (q: typeof sql, player: GgtPlayer) =>
  player.kind === 'member' ? q`user_id = ${player.userId}` : q`guest_id = ${player.guestId}`;

/** Goals the player has solved: a member's solves rows; a guest has none, so its correct sessions. */
const solvedGoalIds = (q: typeof sql, player: GgtPlayer) =>
  player.kind === 'member'
    ? q`SELECT goal_id FROM guess_the_goal_solves WHERE user_id = ${player.userId}`
    : q`SELECT goal_id FROM guess_the_goal_sessions WHERE guest_id = ${player.guestId} AND guess_correct`;

const startLockKey = (player: GgtPlayer) =>
  player.kind === 'member' ? 'ggt:' + player.userId : 'ggt:guest:' + player.guestId;

export const guessTheGoalRepo = {
  /** Serialize all session-starting work for one user (advisory xact lock):
   *  parallel starts otherwise race the nonce check and the abandon step. */
  async acquireStartLock(tx: TransactionSql, player: GgtPlayer): Promise<void> {
    await exec(tx)`SELECT pg_advisory_xact_lock(hashtextextended(${startLockKey(player)}, 0))`;
  },

  /**
   * Goals STARTED so far in the player's local day. Counts sessions, not
   * solves: opening a goal spends an attempt whether or not it is answered,
   * otherwise a player could reroll until they recognise one.
   *
   * `started_at` is timestamptz, so the comparison converts to the game's
   * timezone rather than the server's — the boundary must be the same clock
   * the player sees.
   */
  async countSessionsStartedToday(
    tx: TransactionSql,
    player: GgtPlayer,
    timezone: string
  ): Promise<number> {
    const q = exec(tx);
    const [row] = await q<{ n: number }[]>`
      SELECT count(*)::int AS n
        FROM guess_the_goal_sessions
       WHERE ${ownedBy(q, player)}
         AND (started_at AT TIME ZONE ${timezone})::date
             = (now() AT TIME ZONE ${timezone})::date
    `;
    return row?.n ?? 0;
  },

  /** Dev reset: remove today's sessions + their solves for one user. */
  async deleteTodaySessions(
    tx: TransactionSql,
    userId: string,
    timezone: string
  ): Promise<number> {
    await exec(tx)`
      DELETE FROM guess_the_goal_solves s
      USING guess_the_goal_sessions sess
      WHERE s.session_id = sess.id AND sess.user_id = ${userId}
        AND (sess.started_at AT TIME ZONE ${timezone})::date
            = (now() AT TIME ZONE ${timezone})::date
    `;
    // The reward ledger's idempotency keys (ggt:<user>:<goal>...) must go too,
    // or replaying a reset goal collides on uq_store_tx_guess_the_goal_idempotency
    // and 500s. Scoped to TODAY's sessions' goals — earlier days' rows are the
    // user's lifetime earnings history. Dev lever only — the route is admin-gated.
    await exec(tx)`
      DELETE FROM store_transaction_logs t
      USING guess_the_goal_sessions sess
      WHERE t.event_type = 'guess_the_goal_reward'
        AND sess.user_id = ${userId}
        AND (sess.started_at AT TIME ZONE ${timezone})::date
            = (now() AT TIME ZONE ${timezone})::date
        AND t.idempotency_key LIKE 'ggt:' || ${userId} || ':' || sess.goal_id || '%'
    `;
    const rows = await exec(tx)`
      DELETE FROM guess_the_goal_sessions
      WHERE user_id = ${userId}
        AND (started_at AT TIME ZONE ${timezone})::date
            = (now() AT TIME ZONE ${timezone})::date
      RETURNING id
    `;
    return rows.length;
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
  async pickNextGoal(tx: TransactionSql, player: GgtPlayer): Promise<GoalChoreographyRow | null> {
    const q = exec(tx);
    const [lastServed] = await q<Array<{ goal_id: string }>>`
      SELECT goal_id FROM guess_the_goal_sessions
      WHERE ${ownedBy(q, player)}
      ORDER BY started_at DESC
      LIMIT 1
    `;
    const lastGoalId = lastServed?.goal_id ?? null;
    const [row] = await q<GoalChoreographyRow[]>`
      SELECT g.* FROM goal_choreographies g
      WHERE g.status = 'published'
        AND g.id NOT IN (${solvedGoalIds(q, player)})
        AND (${lastGoalId}::uuid IS NULL OR g.id <> ${lastGoalId}::uuid)
      ORDER BY
        g.id IN (
          SELECT ss.goal_id FROM guess_the_goal_sessions ss WHERE ${ownedBy(q, player)}
        ) ASC,
        -- Curated onboarding: the famous five come first for everyone, then
        -- the pool randomizes. Applies within the never-seen tier, so a
        -- returning player is never forced back through the intro.
        g.featured_rank ASC NULLS LAST,
        random()
      LIMIT 1
    `;
    if (row) return row;
    // Single-goal pool (or the only unsolved goal was just served): allow the
    // repeat rather than stall the kick-off.
    const [unsolvedRepeat] = await q<GoalChoreographyRow[]>`
      SELECT g.* FROM goal_choreographies g
      WHERE g.status = 'published'
        AND g.id NOT IN (${solvedGoalIds(q, player)})
      ORDER BY random()
      LIMIT 1
    `;
    if (unsolvedRepeat) return unsolvedRepeat;
    const [fallback] = await q<GoalChoreographyRow[]>`
      SELECT * FROM goal_choreographies
      WHERE status = 'published'
      ORDER BY random()
      LIMIT 1
    `;
    return fallback ?? null;
  },

  async hasSeenGoal(tx: TransactionSql, player: GgtPlayer, goalId: string): Promise<boolean> {
    const q = exec(tx);
    const [row] = await q<Array<{ seen: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM guess_the_goal_sessions
        WHERE ${ownedBy(q, player)} AND goal_id = ${goalId}
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
    player: GgtPlayer,
    clientNonce: string
  ): Promise<GgtSessionRow | null> {
    const q = exec(tx);
    const [row] = await q<GgtSessionRow[]>`
      SELECT * FROM guess_the_goal_sessions
      WHERE ${ownedBy(q, player)} AND client_nonce = ${clientNonce}
    `;
    return row ?? null;
  },

  /** Finished (guessed/complete) session lookup — mutation-retry replay. */
  async getFinishedSession(
    tx: TransactionSql,
    player: GgtPlayer,
    sessionId: string
  ): Promise<GgtSessionRow | null> {
    const q = exec(tx);
    const [row] = await q<GgtSessionRow[]>`
      SELECT * FROM guess_the_goal_sessions
      WHERE id = ${sessionId} AND ${ownedBy(q, player)} AND state IN ('guessed', 'complete')
    `;
    return row ?? null;
  },

  async getOpenSession(player: GgtPlayer): Promise<GgtSessionRow | null> {
    const [row] = await sql<GgtSessionRow[]>`
      SELECT * FROM guess_the_goal_sessions
      WHERE ${ownedBy(sql, player)} AND state IN ('active', 'guessed')
    `;
    return row ?? null;
  },

  async getOpenSessionForUpdate(
    tx: TransactionSql,
    player: GgtPlayer
  ): Promise<GgtSessionRow | null> {
    const q = exec(tx);
    const [row] = await q<GgtSessionRow[]>`
      SELECT * FROM guess_the_goal_sessions
      WHERE ${ownedBy(q, player)} AND state IN ('active', 'guessed')
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
      player: GgtPlayer;
      goalId: string;
      goalSnapshot: unknown;
      maxPoints: number;
      clientNonce: string | null;
    }
  ): Promise<GgtSessionRow> {
    const userId = data.player.kind === 'member' ? data.player.userId : null;
    const guestId = data.player.kind === 'guest' ? data.player.guestId : null;
    const [row] = await exec(tx)<GgtSessionRow[]>`
      INSERT INTO guess_the_goal_sessions (user_id, guest_id, goal_id, goal_snapshot, max_points, client_nonce)
      VALUES (
        ${userId}, ${guestId}, ${data.goalId}, ${sql.json(data.goalSnapshot as never)},
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
    player: GgtPlayer
  ): Promise<
    Array<{
      difficulty: string;
      title: unknown;
      year: number;
      video_url: string | null;
      solved_at: string;
      points: number | null;
      bonus_correct: boolean | null;
      players: unknown;
      steps: unknown;
      clip_start_s: number | null;
      clip_end_s: number | null;
    }>
  > {
    // Board data comes from the LIVE choreography, not the frozen session
    // snapshot: solved goals have nothing left to hide, and content fixes
    // should reach the collection immediately.
    const q = exec(tx);
    // A guest has no solves rows: its first correct session of each goal stands in for one.
    const solves = player.kind === 'member'
      ? q`SELECT goal_id, session_id, solved_at FROM guess_the_goal_solves WHERE user_id = ${player.userId}`
      : q`SELECT DISTINCT ON (goal_id) goal_id, id AS session_id, guessed_at AS solved_at
            FROM guess_the_goal_sessions
           WHERE guest_id = ${player.guestId} AND guess_correct
           ORDER BY goal_id, guessed_at`;
    return q`
      SELECT g.difficulty, g.year,
             sess.goal_snapshot->'title' AS title,
             COALESCE(g.mirrored_url, sess.goal_snapshot->>'mirrored_url', sess.goal_snapshot->>'video_url') AS video_url,
             g.players, g.steps, g.clip_start_s, g.clip_end_s,
             s.solved_at, sess.points, sess.bonus_correct
      FROM (${solves}) s
      JOIN goal_choreographies g ON g.id = s.goal_id AND g.status = 'published'
      JOIN guess_the_goal_sessions sess ON sess.id = s.session_id
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
        players: unknown;
        steps: unknown;
        clip_start_s: number | null;
        clip_end_s: number | null;
      }>
    >;
  },

  /** Unsolved goals as per-difficulty COUNTS only — even redacted rows leak a
   *  stable global ordering, so unplayed goals never get individual entries. */
  async unsolvedCounts(tx: TransactionSql, player: GgtPlayer): Promise<Record<string, number>> {
    const q = exec(tx);
    const rows = await q<Array<{ difficulty: string; count: number | string }>>`
      SELECT g.difficulty, COUNT(*) AS count
      FROM goal_choreographies g
      WHERE g.status = 'published' AND g.id NOT IN (${solvedGoalIds(q, player)})
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
  async countSolved(player: GgtPlayer): Promise<number> {
    const [row] = await sql<Array<{ count: number | string }>>`
      SELECT COUNT(*) AS count
      FROM goal_choreographies g
      WHERE g.status = 'published' AND g.id IN (${solvedGoalIds(sql, player)})
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
