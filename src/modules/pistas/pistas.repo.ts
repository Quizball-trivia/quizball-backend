import { sql, type TransactionSql } from '../../db/index.js';
import { normalizeSupportedCountryCode } from '../../core/country.js';
import { parseStoredAvatarCustomization } from '../users/avatar-customization.js';
import type { LeaderboardEntry, PistasDayRow, PistasRunRow, Player, RunState } from './pistas.types.js';

const exec = (tx: TransactionSql): typeof sql => tx as unknown as typeof sql;

type RawRow = Omit<PistasRunRow, 'content_version'> & { content_version: string | number };
// content_version is bigint (a content hash); postgres.js returns int8 as a string.
const toRow = (row: RawRow | undefined): PistasRunRow | null => (row ? { ...row, content_version: Number(row.content_version) } : null);

type RawEntry = Omit<LeaderboardEntry, 'avatarCustomization'> & { avatarCustomization: unknown };
const toEntry = (row: RawEntry): LeaderboardEntry => ({
  ...row,
  avatarCustomization: parseStoredAvatarCustomization(row.avatarCustomization),
  country: normalizeSupportedCountryCode(row.country),
  tier: row.tier ?? null,
});

const ownedBy = (q: typeof sql, player: Player) =>
  player.kind === 'member' ? q`user_id = ${player.userId}` : q`guest_id = ${player.guestId}`;

/**
 * `closed` is the database clock against the row's closes_at (Buenos Aires midnight ending its day),
 * evaluated when the row is read or written: the same boundary as the ranked write fence below, so an
 * answer is never disclosed while a ranked write for that day can still land.
 */
const RUN_COLUMNS = `id, user_id, guest_id, day::text AS day, ranked, content_version, state, state_version, done, score, solved,
  completed_at, closes_at, clock_timestamp() >= closes_at AS closed`;

export const pistasRepo = {
  withTx<T>(fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
    return sql.begin((tx) => fn(tx)) as Promise<T>;
  },

  /** Null when the player already has a run for this day (one run per member or guest session per day). */
  async insertRun(
    tx: TransactionSql,
    data: { id: string; player: Player; day: string; ranked: boolean; contentVersion: number; state: RunState; closesAt: Date },
  ): Promise<PistasRunRow | null> {
    const q = exec(tx);
    const userId = data.player.kind === 'member' ? data.player.userId : null;
    const guestId = data.player.kind === 'guest' ? data.player.guestId : null;
    const [row] = await q<RawRow[]>`
      INSERT INTO pistas_runs (id, user_id, guest_id, day, ranked, content_version, state, state_version, closes_at)
      VALUES (${data.id}, ${userId}, ${guestId}, ${data.day}, ${data.ranked}, ${data.contentVersion}, ${q.json(data.state as never)}, 0, ${data.closesAt})
      ON CONFLICT DO NOTHING
      RETURNING ${q.unsafe(RUN_COLUMNS)}
    `;
    return toRow(row);
  },

  async lockOwnRun(tx: TransactionSql, player: Player, day: string): Promise<PistasRunRow | null> {
    const q = exec(tx);
    const [row] = await q<RawRow[]>`
      SELECT ${q.unsafe(RUN_COLUMNS)} FROM pistas_runs WHERE ${ownedBy(q, player)} AND day = ${day} FOR UPDATE
    `;
    return toRow(row);
  },

  /** The run's day, unlocked: a move share-locks the day before it locks the run, the order a seed correction takes. */
  async runDay(tx: TransactionSql, id: string): Promise<string | null> {
    const q = exec(tx);
    const [row] = await q<Array<{ day: string }>>`SELECT day::text AS day FROM pistas_runs WHERE id = ${id}`;
    return row?.day ?? null;
  },

  async lockRun(tx: TransactionSql, id: string): Promise<PistasRunRow | null> {
    const q = exec(tx);
    const [row] = await q<RawRow[]>`SELECT ${q.unsafe(RUN_COLUMNS)} FROM pistas_runs WHERE id = ${id} FOR UPDATE`;
    return toRow(row);
  },

  async getRun(player: Player, day: string): Promise<PistasRunRow | null> {
    const [row] = await sql<RawRow[]>`
      SELECT ${sql.unsafe(RUN_COLUMNS)} FROM pistas_runs WHERE ${ownedBy(sql, player)} AND day = ${day}
    `;
    return toRow(row);
  },

  /**
   * The day's content version as stored, share-locked until the transaction ends: a seed changing the
   * day takes FOR UPDATE on the row, so it waits for this run's write and this read waits for its
   * commit (then sees the new version). Null when the day is not stored.
   */
  async lockDay(tx: TransactionSql, day: string): Promise<number | null> {
    const q = exec(tx);
    const [row] = await q<Array<{ content_version: string }>>`SELECT content_version FROM pistas_days WHERE day = ${day} FOR SHARE`;
    return row ? Number(row.content_version) : null;
  },

  /** Plain read, to tell why a run UPDATE matched no row. */
  async dayVersion(tx: TransactionSql, day: string): Promise<number | null> {
    const q = exec(tx);
    const [row] = await q<Array<{ content_version: string }>>`SELECT content_version FROM pistas_days WHERE day = ${day}`;
    return row ? Number(row.content_version) : null;
  },

  /**
   * Null when the row is ranked and its day closed (closes_at, Buenos Aires midnight) before this
   * statement ran, or when the day's stored content version is no longer the run's (a correction).
   * clock_timestamp(), not now(): now() is the transaction start, so a request that began before
   * midnight and waited on the row lock would still pass. Unranked runs never close.
   */
  async saveState(
    tx: TransactionSql,
    id: string,
    data: { state: RunState; stateVersion: number; contentVersion: number; completion: { score: number; solved: number } | null },
  ): Promise<PistasRunRow | null> {
    const q = exec(tx);
    const c = data.completion;
    const [row] = await q<RawRow[]>`
      UPDATE pistas_runs
      SET state = ${q.json(data.state as never)}, state_version = ${data.stateVersion}, content_version = ${data.contentVersion},
          done = ${c !== null}, score = ${c?.score ?? null}, solved = ${c?.solved ?? null},
          completed_at = CASE WHEN ${c !== null} THEN clock_timestamp() END
      WHERE id = ${id} AND (NOT ranked OR clock_timestamp() < closes_at)
        AND EXISTS (SELECT 1 FROM pistas_days d WHERE d.day = pistas_runs.day AND d.content_version = ${data.contentVersion})
      RETURNING ${q.unsafe(RUN_COLUMNS)}
    `;
    return toRow(row);
  },

  /** An unfinished ranked run whose day has closed (by the database clock) goes on as an unranked one; null while the day is still open. */
  async unrankClosedRun(tx: TransactionSql, id: string): Promise<PistasRunRow | null> {
    const q = exec(tx);
    const [row] = await q<RawRow[]>`
      UPDATE pistas_runs SET ranked = false
      WHERE id = ${id} AND ranked AND NOT done AND clock_timestamp() >= closes_at
      RETURNING ${q.unsafe(RUN_COLUMNS)}
    `;
    return toRow(row);
  },

  /**
   * An unfinished run left on superseded content (a correction, which already unranked it) moves onto the
   * stored content with `state`; never ranked again. Null unless `contentVersion` is the stored one.
   */
  async rebaseRun(tx: TransactionSql, id: string, contentVersion: number, state: RunState): Promise<PistasRunRow | null> {
    const q = exec(tx);
    const [row] = await q<RawRow[]>`
      UPDATE pistas_runs SET content_version = ${contentVersion}, state = ${q.json(state as never)}, ranked = false, state_version = state_version + 1
      WHERE id = ${id} AND NOT done AND content_version <> ${contentVersion}
        AND EXISTS (SELECT 1 FROM pistas_days d WHERE d.day = pistas_runs.day AND d.content_version = ${contentVersion})
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
  async rankOf(userId: string, day: string, tx?: TransactionSql): Promise<LeaderboardEntry | null> {
    const q = tx ? exec(tx) : sql;
    const [row] = await q<RawEntry[]>`
      SELECT
        1 + (
          SELECT count(*) FROM pistas_runs o JOIN users ou ON ou.id = o.user_id
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
        me.solved
      FROM pistas_runs me
      JOIN users u ON u.id = me.user_id
      LEFT JOIN ranked_profiles rp ON rp.user_id = u.id
      WHERE me.user_id = ${userId} AND me.day = ${day} AND me.ranked AND me.done
        AND u.is_ai = false AND u.is_guest = false AND u.is_seed = false AND u.is_deleted = false
        AND u.deleted_at IS NULL AND u.pending_deletion_at IS NULL
    `;
    return row ? toEntry(row) : null;
  },

  /** Top ranked, finished runs and the player count from one snapshot. Guest and unranked runs never appear. */
  async leaderboard(day: string, limit: number): Promise<{ players: number; top: LeaderboardEntry[] }> {
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
        r.solved
      FROM pistas_runs r
      JOIN users u ON u.id = r.user_id
      LEFT JOIN ranked_profiles rp ON rp.user_id = u.id
      WHERE r.day = ${day} AND r.ranked AND r.done
        AND u.is_ai = false AND u.is_guest = false AND u.is_seed = false AND u.is_deleted = false
        AND u.deleted_at IS NULL AND u.pending_deletion_at IS NULL
      ORDER BY r.score DESC NULLS LAST, r.completed_at ASC, r.id ASC
      LIMIT ${limit}
    `;
    return { players: rows[0]?.players ?? 0, top: rows.map(({ players: _players, ...row }) => toEntry(row)) };
  },

  /** Changes on every seed that writes (updated_at is touched by trigger), and on any insert or delete. */
  async daysFingerprint(): Promise<string> {
    const [row] = await sql<Array<{ fingerprint: string }>>`
      SELECT concat_ws(':', count(*), extract(epoch FROM max(updated_at)), sum(content_version)) AS fingerprint FROM pistas_days
    `;
    return row?.fingerprint ?? '';
  },

  async loadDays(): Promise<PistasDayRow[]> {
    const rows = await sql<Array<Omit<PistasDayRow, 'contentVersion'> & { contentVersion: string | number }>>`
      SELECT day::text AS day, number, content_version AS "contentVersion", rounds FROM pistas_days ORDER BY day
    `;
    return rows.map((row) => ({ ...row, contentVersion: Number(row.contentVersion) }));
  },
};

export type PistasRepo = typeof pistasRepo;
