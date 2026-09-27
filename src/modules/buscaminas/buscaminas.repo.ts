import { sql, type TransactionSql } from '../../db/index.js';
import { normalizeSupportedCountryCode } from '../../core/country.js';
import { parseStoredAvatarCustomization } from '../users/avatar-customization.js';
import type { BuscaminasRunRow, LeaderboardEntry, RunPayload } from './buscaminas.types.js';

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

export const buscaminasRepo = {
  withTx<T>(fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
    return sql.begin((tx) => fn(tx)) as Promise<T>;
  },

  async insertRun(tx: TransactionSql, data: { id: string; userId: string; day: string; contentVersion: number; state: RunPayload }): Promise<BuscaminasRunRow | null> {
    const q = exec(tx);
    const [row] = await q<RawRow[]>`
      INSERT INTO buscaminas_runs (id, user_id, day, content_version, state, state_version)
      VALUES (${data.id}, ${data.userId}, ${data.day}, ${data.contentVersion}, ${q.json(data.state as never)}, ${data.state.sv})
      ON CONFLICT (user_id, day) DO NOTHING
      RETURNING id, user_id, day::text AS day, content_version, state, state_version, done, score, perfects, completed_at
    `;
    return toRow(row);
  },

  async lockRun(tx: TransactionSql, userId: string, day: string): Promise<BuscaminasRunRow | null> {
    const [row] = await exec(tx)<RawRow[]>`
      SELECT id, user_id, day::text AS day, content_version, state, state_version, done, score, perfects, completed_at
      FROM buscaminas_runs WHERE user_id = ${userId} AND day = ${day} FOR UPDATE
    `;
    return toRow(row);
  },

  async getRun(userId: string, day: string): Promise<BuscaminasRunRow | null> {
    const [row] = await sql<RawRow[]>`
      SELECT id, user_id, day::text AS day, content_version, state, state_version, done, score, perfects, completed_at
      FROM buscaminas_runs WHERE user_id = ${userId} AND day = ${day}
    `;
    return toRow(row);
  },

  /**
   * Null when the ranked day closed (`closesAt`, Buenos Aires midnight) before this
   * statement ran. clock_timestamp(), not now(): now() is the transaction start, so a
   * request that began before midnight and waited on the row lock would still pass.
   */
  async saveState(
    tx: TransactionSql,
    id: string,
    data: { state: RunPayload; contentVersion: number; completion: { score: number; perfects: number } | null; closesAt: Date },
  ): Promise<BuscaminasRunRow | null> {
    const q = exec(tx);
    const c = data.completion;
    const [row] = await q<RawRow[]>`
      UPDATE buscaminas_runs
      SET state = ${q.json(data.state as never)}, state_version = ${data.state.sv}, content_version = ${data.contentVersion},
          done = ${c !== null}, score = ${c?.score ?? null}, perfects = ${c?.perfects ?? null},
          completed_at = CASE WHEN ${c !== null} THEN clock_timestamp() END
      WHERE id = ${id} AND clock_timestamp() < ${data.closesAt}
      RETURNING id, user_id, day::text AS day, content_version, state, state_version, done, score, perfects, completed_at
    `;
    return toRow(row);
  },

  /** The user's board row; null until the run is finished or when the account is not board-visible. Same eligibility as the other public boards. */
  async rankOf(userId: string, day: string, tx?: TransactionSql): Promise<LeaderboardEntry | null> {
    const q = tx ? exec(tx) : sql;
    const [row] = await q<RawEntry[]>`
      SELECT
        1 + (
          SELECT count(*) FROM buscaminas_runs o JOIN users ou ON ou.id = o.user_id
          WHERE o.day = me.day AND o.done
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
      WHERE me.user_id = ${userId} AND me.day = ${day} AND me.done
        AND u.is_ai = false AND u.is_guest = false AND u.is_seed = false AND u.is_deleted = false
        AND u.deleted_at IS NULL AND u.pending_deletion_at IS NULL
    `;
    return row ? toEntry(row) : null;
  },

  /** Top rows and the player count from one snapshot. */
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
      WHERE r.day = ${day} AND r.done
        AND u.is_ai = false AND u.is_guest = false AND u.is_seed = false AND u.is_deleted = false
        AND u.deleted_at IS NULL AND u.pending_deletion_at IS NULL
      ORDER BY r.score DESC NULLS LAST, r.completed_at ASC, r.id ASC
      LIMIT ${limit}
    `;
    return { players: rows[0]?.players ?? 0, top: rows.map(({ players: _players, ...row }) => toEntry(row)) };
  },
};

export type BuscaminasRepo = typeof buscaminasRepo;
