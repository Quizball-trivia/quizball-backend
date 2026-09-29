import { sql, type TransactionSql } from '../../db/index.js';
import { normalizeSupportedCountryCode } from '../../core/country.js';
import { parseStoredAvatarCustomization } from '../users/avatar-customization.js';
import type { AvatarCustomization } from '../users/avatar-customization.js';

const exec = (tx: TransactionSql): typeof sql => tx as unknown as typeof sql;

/** Who is playing: a signed-in member or a guest session. */
export type DailyPlayer = { kind: 'member'; userId: string } | { kind: 'guest'; guestId: string };

/** The columns every daily game's runs table has; `stat` is the game's second board column (solved, answers). */
export interface DailyRunRowBase<State> {
  id: string;
  user_id: string | null;
  guest_id: string | null;
  day: string;
  ranked: boolean;
  content_version: number;
  state: State;
  state_version: number;
  done: boolean;
  score: number | null;
  completed_at: Date | null;
  closes_at: Date;
  /** The database clock has passed closes_at (evaluated when the row was read or written). */
  closed: boolean;
}

export interface DailyBoardEntryBase {
  rank: number;
  userId: string;
  username: string;
  avatarUrl: string | null;
  avatarCustomization: AvatarCustomization | null;
  country: string | null;
  tier: string | null;
  score: number;
}

export interface DailyTables {
  runs: string;
  days: string;
  /** The days table's content column (rounds, categories). */
  payload: string;
  /** The runs table's second board column (solved, answers); returned under the same name. */
  stat: string;
}

/**
 * One daily game's runs and days tables. Table and column names are fixed configuration (checked below), never
 * input, so they are inlined as SQL text.
 *
 * `closed` is the database clock against the row's closes_at (Buenos Aires midnight ending its day), evaluated
 * when the row is read or written: the same boundary as the ranked write fence, so an answer is never disclosed
 * while a ranked write for that day can still land.
 */
export function createDailyRunsRepo<State, Row extends DailyRunRowBase<State>, Entry extends DailyBoardEntryBase, DayRow>(t: DailyTables) {
  for (const name of Object.values(t)) if (!/^[a-z_]+$/.test(name)) throw new Error(`Bad table config: ${name}`);
  const RUNS = t.runs;
  const DAYS = t.days;
  const RUN_COLUMNS = `id, user_id, guest_id, day::text AS day, ranked, content_version, state, state_version, done, score, ${t.stat},
  completed_at, closes_at, clock_timestamp() >= closes_at AS closed`;

  type RawRow = Omit<Row, 'content_version'> & { content_version: string | number };
  // content_version is bigint (a content hash); postgres.js returns int8 as a string.
  const toRow = (row: RawRow | undefined): Row | null => (row ? ({ ...row, content_version: Number(row.content_version) } as Row) : null);

  type RawEntry = Omit<Entry, 'avatarCustomization'> & { avatarCustomization: unknown };
  const toEntry = (row: RawEntry): Entry => ({
    ...row,
    avatarCustomization: parseStoredAvatarCustomization(row.avatarCustomization),
    country: normalizeSupportedCountryCode(row.country),
    tier: row.tier ?? null,
  }) as Entry;

  const ownedBy = (q: typeof sql, player: DailyPlayer) =>
    player.kind === 'member' ? q`user_id = ${player.userId}` : q`guest_id = ${player.guestId}`;

  return {
    withTx<T>(fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
      return sql.begin((tx) => fn(tx)) as Promise<T>;
    },

    /** Null when the player already has a run for this day (one run per member or guest session per day). */
    async insertRun(
      tx: TransactionSql,
      data: { id: string; player: DailyPlayer; day: string; ranked: boolean; contentVersion: number; state: State; closesAt: Date },
    ): Promise<Row | null> {
      const q = exec(tx);
      const userId = data.player.kind === 'member' ? data.player.userId : null;
      const guestId = data.player.kind === 'guest' ? data.player.guestId : null;
      const [row] = await q<RawRow[]>`
      INSERT INTO ${q.unsafe(RUNS)} (id, user_id, guest_id, day, ranked, content_version, state, state_version, closes_at)
      VALUES (${data.id}, ${userId}, ${guestId}, ${data.day}, ${data.ranked}, ${data.contentVersion}, ${q.json(data.state as never)}, 0, ${data.closesAt})
      ON CONFLICT DO NOTHING
      RETURNING ${q.unsafe(RUN_COLUMNS)}
    `;
      return toRow(row);
    },

    async lockOwnRun(tx: TransactionSql, player: DailyPlayer, day: string): Promise<Row | null> {
      const q = exec(tx);
      const [row] = await q<RawRow[]>`
      SELECT ${q.unsafe(RUN_COLUMNS)} FROM ${q.unsafe(RUNS)} WHERE ${ownedBy(q, player)} AND day = ${day} FOR UPDATE
    `;
      return toRow(row);
    },

    /** The run's day, unlocked: a move share-locks the day before it locks the run, the order a seed correction takes. */
    async runDay(tx: TransactionSql, id: string): Promise<string | null> {
      const q = exec(tx);
      const [row] = await q<Array<{ day: string }>>`SELECT day::text AS day FROM ${q.unsafe(RUNS)} WHERE id = ${id}`;
      return row?.day ?? null;
    },

    async lockRun(tx: TransactionSql, id: string): Promise<Row | null> {
      const q = exec(tx);
      const [row] = await q<RawRow[]>`SELECT ${q.unsafe(RUN_COLUMNS)} FROM ${q.unsafe(RUNS)} WHERE id = ${id} FOR UPDATE`;
      return toRow(row);
    },

    async getRun(player: DailyPlayer, day: string): Promise<Row | null> {
      const [row] = await sql<RawRow[]>`
      SELECT ${sql.unsafe(RUN_COLUMNS)} FROM ${sql.unsafe(RUNS)} WHERE ${ownedBy(sql, player)} AND day = ${day}
    `;
      return toRow(row);
    },

    /**
     * The day's content version as stored, share-locked until the transaction ends: a seed changing the day takes
     * FOR UPDATE on the row, so it waits for this run's write and this read waits for its commit (then sees the new
     * version). Null when the day is not stored.
     */
    async lockDay(tx: TransactionSql, day: string): Promise<number | null> {
      const q = exec(tx);
      const [row] = await q<Array<{ content_version: string }>>`SELECT content_version FROM ${q.unsafe(DAYS)} WHERE day = ${day} FOR SHARE`;
      return row ? Number(row.content_version) : null;
    },

    /** Plain read, to tell why a run UPDATE matched no row. */
    async dayVersion(tx: TransactionSql, day: string): Promise<number | null> {
      const q = exec(tx);
      const [row] = await q<Array<{ content_version: string }>>`SELECT content_version FROM ${q.unsafe(DAYS)} WHERE day = ${day}`;
      return row ? Number(row.content_version) : null;
    },

    /**
     * Null when the row is ranked and its day closed (closes_at, Buenos Aires midnight) before this statement ran,
     * or when the day's stored content version is no longer the run's (a correction). clock_timestamp(), not now():
     * now() is the transaction start, so a request that began before midnight and waited on the row lock would
     * still pass. Unranked runs never close.
     */
    async saveState(
      tx: TransactionSql,
      id: string,
      data: { state: State; stateVersion: number; contentVersion: number; completion: { score: number; stat: number } | null },
      /**
       * A write that only records what the clock already decided (a category lost to time) at `settledAt`: a ranked
       * run that settled before its day closed is still written after the close. Never for a player's move.
       */
      settledAt?: Date,
    ): Promise<Row | null> {
      const q = exec(tx);
      const c = data.completion;
      const settledInTime = settledAt ? q` OR ${settledAt} < closes_at` : q.unsafe('');
      const [row] = await q<RawRow[]>`
      UPDATE ${q.unsafe(RUNS)}
      SET state = ${q.json(data.state as never)}, state_version = ${data.stateVersion}, content_version = ${data.contentVersion},
          done = ${c !== null}, score = ${c?.score ?? null}, ${q.unsafe(t.stat)} = ${c?.stat ?? null},
          completed_at = CASE WHEN ${c !== null} THEN clock_timestamp() END
      WHERE id = ${id} AND (NOT ranked OR clock_timestamp() < closes_at${settledInTime})
        AND EXISTS (SELECT 1 FROM ${q.unsafe(DAYS)} d WHERE d.day = ${q.unsafe(RUNS)}.day AND d.content_version = ${data.contentVersion})
      RETURNING ${q.unsafe(RUN_COLUMNS)}
    `;
      return toRow(row);
    },

    /** The database clock (ms), for games whose moves are timed: every replica then reads the same clock. */
    async clock(tx?: TransactionSql): Promise<number> {
      const q = tx ? exec(tx) : sql;
      const [row] = await q<Array<{ ms: number }>>`SELECT (extract(epoch FROM clock_timestamp()) * 1000)::float8 AS ms`;
      return Number(row.ms);
    },

    /** Unfinished runs whose state says an open clock ran out before `beforeMs` (the settling sweep's work list). */
    async overdueRuns(beforeMs: number, limit: number): Promise<string[]> {
      const rows = await sql<Array<{ id: string }>>`
      SELECT id FROM ${sql.unsafe(RUNS)}
      WHERE NOT done AND state->>'open' = 'true' AND (state->>'dl')::float8 < ${beforeMs}
      LIMIT ${limit}
    `;
      return rows.map((r) => r.id);
    },

    /** An unfinished ranked run whose day has closed (by the database clock) goes on as an unranked one; null while the day is still open. */
    async unrankClosedRun(tx: TransactionSql, id: string): Promise<Row | null> {
      const q = exec(tx);
      const [row] = await q<RawRow[]>`
      UPDATE ${q.unsafe(RUNS)} SET ranked = false
      WHERE id = ${id} AND ranked AND NOT done AND clock_timestamp() >= closes_at
      RETURNING ${q.unsafe(RUN_COLUMNS)}
    `;
      return toRow(row);
    },

    /**
     * An unfinished run left on superseded content (a correction, which already unranked it) moves onto the stored
     * content with `state`; never ranked again. Null unless `contentVersion` is the stored one.
     */
    async rebaseRun(tx: TransactionSql, id: string, contentVersion: number, state: State): Promise<Row | null> {
      const q = exec(tx);
      const [row] = await q<RawRow[]>`
      UPDATE ${q.unsafe(RUNS)} SET content_version = ${contentVersion}, state = ${q.json(state as never)}, ranked = false, state_version = state_version + 1
      WHERE id = ${id} AND NOT done AND content_version <> ${contentVersion}
        AND EXISTS (SELECT 1 FROM ${q.unsafe(DAYS)} d WHERE d.day = ${q.unsafe(RUNS)}.day AND d.content_version = ${contentVersion})
      RETURNING ${q.unsafe(RUN_COLUMNS)}
    `;
      return toRow(row);
    },

    /** The database clock has passed `closesAt`. */
    async isClosed(closesAt: Date): Promise<boolean> {
      const [row] = await sql<Array<{ closed: boolean }>>`SELECT clock_timestamp() >= ${closesAt} AS closed`;
      return row?.closed === true;
    },

    /** The member's board row; null until the ranked run is finished or when the account is not board-visible. Same eligibility as the other public boards. */
    async rankOf(userId: string, day: string, tx?: TransactionSql): Promise<Entry | null> {
      const q = tx ? exec(tx) : sql;
      const [row] = await q<RawEntry[]>`
      SELECT
        1 + (
          SELECT count(*) FROM ${q.unsafe(RUNS)} o JOIN users ou ON ou.id = o.user_id
          WHERE o.day = me.day AND o.ranked AND o.done
            AND ou.is_ai = false AND ou.is_guest = false AND ou.is_seed = false AND ou.is_deleted = false
            AND ou.deleted_at IS NULL AND ou.pending_deletion_at IS NULL
            AND (o.score > me.score OR (o.score = me.score AND (o.completed_at, o.id) < (me.completed_at, me.id)))
        )::int AS rank,
        u.id AS "userId",
        COALESCE(NULLIF(u.nickname, ''), 'Player') AS "username",
        u.avatar_url AS "avatarUrl",
        u.avatar_customization AS "avatarCustomization",
        u.country,
        CASE WHEN rp.placement_status = 'placed' THEN rp.tier END AS "tier",
        me.score,
        me.${q.unsafe(t.stat)}
      FROM ${q.unsafe(RUNS)} me
      JOIN users u ON u.id = me.user_id
      LEFT JOIN ranked_profiles rp ON rp.user_id = u.id
      WHERE me.user_id = ${userId} AND me.day = ${day} AND me.ranked AND me.done
        AND u.is_ai = false AND u.is_guest = false AND u.is_seed = false AND u.is_deleted = false
        AND u.deleted_at IS NULL AND u.pending_deletion_at IS NULL
    `;
      return row ? toEntry(row) : null;
    },

    /** Top ranked, finished runs and the player count from one snapshot. Guest and unranked runs never appear. */
    async leaderboard(day: string, limit: number): Promise<{ players: number; top: Entry[] }> {
      const rows = await sql<Array<RawEntry & { players: number }>>`
      SELECT
        (row_number() OVER (ORDER BY r.score DESC NULLS LAST, r.completed_at ASC, r.id ASC))::int AS rank,
        (count(*) OVER ())::int AS players,
        u.id AS "userId",
        COALESCE(NULLIF(u.nickname, ''), 'Player') AS "username",
        u.avatar_url AS "avatarUrl",
        u.avatar_customization AS "avatarCustomization",
        u.country,
        CASE WHEN rp.placement_status = 'placed' THEN rp.tier END AS "tier",
        r.score,
        r.${sql.unsafe(t.stat)}
      FROM ${sql.unsafe(RUNS)} r
      JOIN users u ON u.id = r.user_id
      LEFT JOIN ranked_profiles rp ON rp.user_id = u.id
      WHERE r.day = ${day} AND r.ranked AND r.done
        AND u.is_ai = false AND u.is_guest = false AND u.is_seed = false AND u.is_deleted = false
        AND u.deleted_at IS NULL AND u.pending_deletion_at IS NULL
      ORDER BY r.score DESC NULLS LAST, r.completed_at ASC, r.id ASC
      LIMIT ${limit}
    `;
      return { players: rows[0]?.players ?? 0, top: rows.map(({ players: _players, ...row }) => toEntry(row as unknown as RawEntry)) };
    },

    /** Changes on every seed that writes (updated_at is touched by trigger), and on any insert or delete. */
    async daysFingerprint(): Promise<string> {
      const [row] = await sql<Array<{ fingerprint: string }>>`
      SELECT concat_ws(':', count(*), extract(epoch FROM max(updated_at)), sum(content_version)) AS fingerprint FROM ${sql.unsafe(DAYS)}
    `;
      return row?.fingerprint ?? '';
    },

    async loadDays(): Promise<DayRow[]> {
      const rows = await sql<Array<Record<string, unknown> & { contentVersion: string | number }>>`
      SELECT day::text AS day, number, content_version AS "contentVersion", ${sql.unsafe(t.payload)} FROM ${sql.unsafe(DAYS)} ORDER BY day
    `;
      return rows.map((row) => ({ ...row, contentVersion: Number(row.contentVersion) }) as unknown as DayRow);
    },
  };
}

export type DailyRunsRepo<State, Row extends DailyRunRowBase<State>, Entry extends DailyBoardEntryBase, DayRow> =
  ReturnType<typeof createDailyRunsRepo<State, Row, Entry, DayRow>>;
