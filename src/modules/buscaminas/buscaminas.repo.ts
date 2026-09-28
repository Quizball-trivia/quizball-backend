import { sql, type TransactionSql } from '../../db/index.js';
import { normalizeSupportedCountryCode } from '../../core/country.js';
import { parseStoredAvatarCustomization } from '../users/avatar-customization.js';
import type { BuscaminasDayRow, BuscaminasRunRow, LeaderboardEntry, Player, RunState } from './buscaminas.types.js';

const exec = (tx: TransactionSql): typeof sql => tx as unknown as typeof sql;

type RawRow = Omit<BuscaminasRunRow, 'content_version'> & { content_version: string | number };
// content_version is bigint (a content hash); postgres.js returns int8 as a string.
const toRow = (row: RawRow | undefined): BuscaminasRunRow | null => (row ? { ...row, content_version: Number(row.content_version) } : null);

type RawEntry = Omit<LeaderboardEntry, 'avatarCustomization'> & { avatarCustomization: unknown };
const toEntry = (row: RawEntry): LeaderboardEntry => ({
  ...row,
  avatarCustomization: parseStoredAvatarCustomization(row.avatarCustomization),
  country: normalizeSupportedCountryCode(row.country),
  tier: row.tier ?? null,
});

const ownedBy = (q: typeof sql, player: Player) =>
  player.kind === 'member' ? q`user_id = ${player.userId}` : q`guest_id = ${player.guestId}`;

const RUN_COLUMNS = 'id, user_id, guest_id, day::text AS day, ranked, content_version, state, state_version, done, score, perfects, completed_at';

export const buscaminasRepo = {
  withTx<T>(fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
    return sql.begin((tx) => fn(tx)) as Promise<T>;
  },

  /** Null when the player already has a run for this day (one run per member or guest session per day). */
  async insertRun(tx: TransactionSql, data: { id: string; player: Player; day: string; ranked: boolean; contentVersion: number; state: RunState }): Promise<BuscaminasRunRow | null> {
    const q = exec(tx);
    const userId = data.player.kind === 'member' ? data.player.userId : null;
    const guestId = data.player.kind === 'guest' ? data.player.guestId : null;
    const [row] = await q<RawRow[]>`
      INSERT INTO buscaminas_runs (id, user_id, guest_id, day, ranked, content_version, state, state_version)
      VALUES (${data.id}, ${userId}, ${guestId}, ${data.day}, ${data.ranked}, ${data.contentVersion}, ${q.json(data.state as never)}, 0)
      ON CONFLICT DO NOTHING
      RETURNING ${q.unsafe(RUN_COLUMNS)}
    `;
    return toRow(row);
  },

  async lockOwnRun(tx: TransactionSql, player: Player, day: string): Promise<BuscaminasRunRow | null> {
    const q = exec(tx);
    const [row] = await q<RawRow[]>`
      SELECT ${q.unsafe(RUN_COLUMNS)} FROM buscaminas_runs WHERE ${ownedBy(q, player)} AND day = ${day} FOR UPDATE
    `;
    return toRow(row);
  },

  async lockRun(tx: TransactionSql, id: string): Promise<BuscaminasRunRow | null> {
    const q = exec(tx);
    const [row] = await q<RawRow[]>`SELECT ${q.unsafe(RUN_COLUMNS)} FROM buscaminas_runs WHERE id = ${id} FOR UPDATE`;
    return toRow(row);
  },

  async getRun(player: Player, day: string): Promise<BuscaminasRunRow | null> {
    const [row] = await sql<RawRow[]>`
      SELECT ${sql.unsafe(RUN_COLUMNS)} FROM buscaminas_runs WHERE ${ownedBy(sql, player)} AND day = ${day}
    `;
    return toRow(row);
  },

  /**
   * Null when the row is ranked and its day closed (`closesAt`, Buenos Aires midnight) before this
   * statement ran. clock_timestamp(), not now(): now() is the transaction start, so a request that
   * began before midnight and waited on the row lock would still pass. Unranked runs never close.
   */
  async saveState(
    tx: TransactionSql,
    id: string,
    data: { state: RunState; stateVersion: number; contentVersion: number; completion: { score: number; perfects: number } | null; closesAt: Date },
  ): Promise<BuscaminasRunRow | null> {
    const q = exec(tx);
    const c = data.completion;
    const [row] = await q<RawRow[]>`
      UPDATE buscaminas_runs
      SET state = ${q.json(data.state as never)}, state_version = ${data.stateVersion}, content_version = ${data.contentVersion},
          done = ${c !== null}, score = ${c?.score ?? null}, perfects = ${c?.perfects ?? null},
          completed_at = CASE WHEN ${c !== null} THEN clock_timestamp() END
      WHERE id = ${id} AND (NOT ranked OR clock_timestamp() < ${data.closesAt})
      RETURNING ${q.unsafe(RUN_COLUMNS)}
    `;
    return toRow(row);
  },

  /** An unfinished ranked run whose day has closed (by the database clock) goes on as an unranked one; null while the day is still open. */
  async unrankClosedRun(tx: TransactionSql, id: string, closesAt: Date): Promise<BuscaminasRunRow | null> {
    const q = exec(tx);
    const [row] = await q<RawRow[]>`
      UPDATE buscaminas_runs SET ranked = false
      WHERE id = ${id} AND ranked AND NOT done AND clock_timestamp() >= ${closesAt}
      RETURNING ${q.unsafe(RUN_COLUMNS)}
    `;
    return toRow(row);
  },

  /** The member's board row; null until the ranked run is finished or when the account is not board-visible. Same eligibility as the other public boards. */
  async rankOf(userId: string, day: string, tx?: TransactionSql): Promise<LeaderboardEntry | null> {
    const q = tx ? exec(tx) : sql;
    const [row] = await q<RawEntry[]>`
      SELECT
        1 + (
          SELECT count(*) FROM buscaminas_runs o JOIN users ou ON ou.id = o.user_id
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
        me.perfects
      FROM buscaminas_runs me
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
        r.perfects
      FROM buscaminas_runs r
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
      SELECT concat_ws(':', count(*), extract(epoch FROM max(updated_at)), sum(content_version)) AS fingerprint FROM buscaminas_days
    `;
    return row?.fingerprint ?? '';
  },

  async loadDays(): Promise<BuscaminasDayRow[]> {
    const rows = await sql<Array<Omit<BuscaminasDayRow, 'contentVersion'> & { contentVersion: string | number }>>`
      SELECT day::text AS day, number, content_version AS "contentVersion", board, answers FROM buscaminas_days ORDER BY day
    `;
    return rows.map((row) => ({ ...row, contentVersion: Number(row.contentVersion) }));
  },
};

export type BuscaminasRepo = typeof buscaminasRepo;
