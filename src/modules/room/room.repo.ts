import { sql, type TransactionSql } from '../../db/index.js';
import { parseStoredAvatarCustomization, type AvatarCustomization } from '../users/avatar-customization.js';
import { LIVE_ROOM_STATUSES, type RoomGameId, type RoomLocale, type RoomResult, type RoomStatus } from './room.types.js';

type Q = TransactionSql | typeof sql;
const exec = (q?: Q) => (q ?? sql) as typeof sql;

export interface RoomMatchRow {
  id: string;
  game: RoomGameId;
  engine_version: number;
  lobby_id: string | null;
  status: RoomStatus;
  state: unknown;
  state_version: number;
  phase_token: number;
  phase_deadline_at: Date | null;
  result: RoomResult | null;
  /** The database clock when the row was locked (read after the lock wait). */
  now: Date;
  /** The match still has its content row (a replica keeps live content in memory and must notice when the row is gone). */
  has_content: boolean;
}

export interface RoomSeatRow {
  user_id: string;
  slot: number;
  seat: number | null;
  admitted: boolean;
  is_guest: boolean;
  locale: RoomLocale;
  ready_at: Date | null;
  connected: boolean;
  absent_since: Date | null;
  absence_deadline_at: Date | null;
  absence_used_ms: number;
  presence_gen: number;
  active: boolean;
  left_at: Date | null;
  place: number | null;
  points: number | null;
  nickname: string | null;
  avatar_url: string | null;
  avatar_customization: AvatarCustomization | null;
}

export interface PresenceFence { matchId: string; gen: number }

export interface RoomPoolItem { item_id: string; difficulty: string; payload: unknown }

const MATCH_COLUMNS = `id, game, engine_version, lobby_id, status, state, state_version, phase_token, phase_deadline_at, result, clock_timestamp() AS now,
  EXISTS (SELECT 1 FROM room_match_content c WHERE c.match_id = room_matches.id) AS has_content`;

export const roomRepo = {
  withTx<T>(fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
    return sql.begin((tx) => fn(tx)) as Promise<T>;
  },

  /**
   * `wanted` items per difficulty (of one tag, when given), preferring items none of the players met in their last 40
   * room matches of the game.
   */
  async pickPool(game: RoomGameId, userIds: string[], wanted: Record<string, number>, tag: string | null = null): Promise<RoomPoolItem[]> {
    const difficulties = Object.keys(wanted);
    const counts = difficulties.map((d) => wanted[d]);
    return sql<RoomPoolItem[]>`
      WITH recent_matches AS (
        -- Each player's own last 40 matches (a group playing together shares them; a seat-row LIMIT would cover only
        -- 40 / group-size matches).
        SELECT DISTINCT r.match_id FROM unnest(${userIds}::uuid[]) AS u(user_id)
        CROSS JOIN LATERAL (
          SELECT s.match_id FROM room_seats s JOIN room_matches m ON m.id = s.match_id
          WHERE s.user_id = u.user_id AND m.game = ${game}
          ORDER BY m.created_at DESC LIMIT 40
        ) r
      ), recent AS (
        SELECT DISTINCT unnest(c.item_ids) AS item_id FROM room_match_content c WHERE c.match_id IN (SELECT match_id FROM recent_matches)
      ), wanted AS (
        SELECT * FROM unnest(${difficulties}::text[], ${counts}::int[]) AS w(difficulty, n)
      ), ranked AS (
        -- Ids only: the payloads (about 1 KB each) are fetched for the picked rows, not sorted with the whole pool.
        SELECT p.item_id, p.difficulty,
               row_number() OVER (PARTITION BY p.difficulty ORDER BY (p.item_id IN (SELECT item_id FROM recent)), random()) AS rn
        FROM room_pool p WHERE p.game = ${game} AND p.enabled AND p.difficulty IN (SELECT difficulty FROM wanted)
          AND (${tag}::text IS NULL OR p.tags @> ARRAY[${tag}]::text[])
      )
      SELECT r.item_id, r.difficulty, p.payload FROM ranked r JOIN wanted w ON w.difficulty = r.difficulty
      JOIN room_pool p ON p.game = ${game} AND p.item_id = r.item_id
      WHERE r.rn <= w.n
    `;
  },

  /**
   * The room this start came from, re-checked under lock: exactly these members, all ready, still waiting, still a
   * room-game room of this game. Flips it active; false when anything changed since the host pressed start.
   */
  async claimLobby(tx: TransactionSql, lobbyId: string, game: RoomGameId, userIds: string[], options: unknown = null): Promise<boolean> {
    const q = exec(tx);
    const members = await q<Array<{ user_id: string; is_ready: boolean }>>`
      SELECT user_id, is_ready FROM lobby_members WHERE lobby_id = ${lobbyId} ORDER BY user_id FOR UPDATE
    `;
    const expected = [...userIds].sort();
    if (members.length !== expected.length || members.some((m, i) => !m.is_ready || m.user_id !== expected[i])) return false;
    const activated = await q<Array<{ id: string }>>`
      UPDATE lobbies SET status = 'active', updated_at = now()
      WHERE id = ${lobbyId} AND status = 'waiting' AND game_mode = 'room_game' AND room_game = ${game}
        AND room_options IS NOT DISTINCT FROM ${options === null || options === undefined ? null : q.json(options as never)}::jsonb
      RETURNING id
    `;
    return activated.length === 1;
  },

  async insertMatch(
    tx: TransactionSql,
    data: { game: RoomGameId; engineVersion: number; lobbyId: string; readyMs: number; itemIds: string[]; content: unknown; seats: Array<{ userId: string; isGuest: boolean }> },
  ): Promise<{ id: string; phase_token: number; phase_deadline_at: Date }> {
    const q = exec(tx);
    const [match] = await q<Array<{ id: string; phase_token: number; phase_deadline_at: Date }>>`
      INSERT INTO room_matches (game, engine_version, lobby_id, status, phase_token, phase_deadline_at)
      VALUES (${data.game}, ${data.engineVersion}, ${data.lobbyId}, 'ready', 1, clock_timestamp() + make_interval(secs => ${data.readyMs / 1000}))
      RETURNING id, phase_token, phase_deadline_at
    `;
    await q`INSERT INTO room_match_content (match_id, item_ids, content) VALUES (${match.id}, ${data.itemIds}, ${q.json(data.content as never)})`;
    const seats = data.seats.map((player, slot) => ({ match_id: match.id, user_id: player.userId, slot, is_guest: player.isGuest }));
    await q`INSERT INTO room_seats ${q(seats, 'match_id', 'user_id', 'slot', 'is_guest')}`;
    return match;
  },

  /** Locks the match, then reads the database clock in a second statement (after the lock wait). */
  async lockMatch(tx: TransactionSql, id: string): Promise<RoomMatchRow | null> {
    const q = exec(tx);
    const [row] = await q<RoomMatchRow[]>`SELECT ${q.unsafe(MATCH_COLUMNS)} FROM room_matches WHERE id = ${id} FOR UPDATE`;
    if (!row) return null;
    const [clock] = await q<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
    return { ...row, now: clock.now };
  },

  async getMatch(id: string): Promise<RoomMatchRow | null> {
    const [row] = await sql<RoomMatchRow[]>`SELECT ${sql.unsafe(MATCH_COLUMNS)} FROM room_matches WHERE id = ${id}`;
    return row ?? null;
  },

  /** A match with its content, for a player who was admitted to it (live or ended); null for anyone else. */
  async seatedMatch(id: string, userId: string): Promise<{ game: RoomGameId; engine_version: number; state: unknown; content: unknown } | null> {
    const [row] = await sql<Array<{ game: RoomGameId; engine_version: number; state: unknown; content: unknown }>>`
      SELECT m.game, m.engine_version, m.state, c.content
      FROM room_seats s JOIN room_matches m ON m.id = s.match_id JOIN room_match_content c ON c.match_id = m.id
      WHERE s.match_id = ${id} AND s.user_id = ${userId} AND s.admitted
    `;
    return row ?? null;
  },

  async getContent(q: Q | undefined, id: string): Promise<unknown | null> {
    const [row] = await exec(q)<Array<{ content: unknown }>>`SELECT content FROM room_match_content WHERE match_id = ${id}`;
    return row?.content ?? null;
  },

  async seats(q: Q | undefined, id: string): Promise<RoomSeatRow[]> {
    const rows = await exec(q)<Array<Omit<RoomSeatRow, 'avatar_customization'> & { avatar_customization: unknown }>>`
      SELECT s.user_id, s.slot, s.seat, s.admitted, s.is_guest, s.locale, s.ready_at, s.connected, s.absent_since,
             s.absence_deadline_at, s.absence_used_ms, s.presence_gen, s.active, s.left_at, s.place, s.points,
             u.nickname, u.avatar_url, u.avatar_customization
      FROM room_seats s JOIN users u ON u.id = s.user_id
      WHERE s.match_id = ${id} ORDER BY s.slot
    `;
    return rows.map((r) => ({ ...r, avatar_customization: parseStoredAvatarCustomization(r.avatar_customization) }));
  },

  async markReady(tx: TransactionSql, id: string, userId: string, locale: RoomLocale): Promise<void> {
    await exec(tx)`UPDATE room_seats SET ready_at = COALESCE(ready_at, clock_timestamp()), locale = ${locale} WHERE match_id = ${id} AND user_id = ${userId}`;
  },

  async setLocale(id: string, userId: string, locale: RoomLocale): Promise<void> {
    await sql`UPDATE room_seats SET locale = ${locale} WHERE match_id = ${id} AND user_id = ${userId} AND locale <> ${locale}`;
  },

  /** The ready gate closed: ready seats get their engine index (dense, join order); the rest leave the match. */
  async admit(tx: TransactionSql, id: string, admitted: Array<{ userId: string; seat: number }>): Promise<void> {
    const q = exec(tx);
    await q`
      UPDATE room_seats s SET seat = a.seat, admitted = true
      FROM unnest(${admitted.map((a) => a.userId)}::uuid[], ${admitted.map((a) => a.seat)}::smallint[]) AS a(user_id, seat)
      WHERE s.match_id = ${id} AND s.user_id = a.user_id
    `;
    await q`UPDATE room_seats SET active = false WHERE match_id = ${id} AND NOT admitted`;
  },

  /** Out of the match for good; `voluntary` = the player left (kept so their screen says so, not "left out"). */
  async deactivate(tx: TransactionSql, id: string, userId: string, voluntary = false): Promise<void> {
    await exec(tx)`
      UPDATE room_seats SET active = false, ready_at = CASE WHEN admitted THEN ready_at END,
        left_at = CASE WHEN ${voluntary} THEN clock_timestamp() ELSE left_at END
      WHERE match_id = ${id} AND user_id = ${userId}
    `;
  },

  /** A live match of this user's room in which the user no longer plays (left it, withdrawn, or left out at the gate). */
  async sittingOutMatchForUser(userId: string): Promise<{ id: string; lobby_id: string | null; left: boolean } | null> {
    const [row] = await sql<Array<{ id: string; lobby_id: string | null; left: boolean }>>`
      SELECT m.id, m.lobby_id, s.left_at IS NOT NULL AS left FROM room_seats s JOIN room_matches m ON m.id = s.match_id
      WHERE s.user_id = ${userId} AND NOT s.active AND m.status IN ('ready', 'active')
        AND EXISTS (SELECT 1 FROM lobby_members lm WHERE lm.lobby_id = m.lobby_id AND lm.user_id = ${userId})
      ORDER BY m.created_at DESC LIMIT 1
    `;
    return row ?? null;
  },

  async findCommand(tx: TransactionSql, id: string, userId: string, commandId: string): Promise<{ payload_hash: string; result: unknown } | null> {
    const [row] = await exec(tx)<Array<{ payload_hash: string; result: unknown }>>`
      SELECT payload_hash, result FROM room_commands WHERE match_id = ${id} AND user_id = ${userId} AND command_id = ${commandId}
    `;
    return row ?? null;
  },

  async insertCommand(tx: TransactionSql, id: string, userId: string, commandId: string, hash: string, result: unknown): Promise<void> {
    const q = exec(tx);
    await q`INSERT INTO room_commands (match_id, user_id, command_id, payload_hash, result) VALUES (${id}, ${userId}, ${commandId}, ${hash}, ${q.json(result as never)})`;
  },

  /** Persists the state; a new deadline also bumps the phase token (older timers go stale). */
  async saveState(
    tx: TransactionSql,
    id: string,
    data: { status: 'active'; state: unknown; deadlineAt: Date; started?: boolean },
  ): Promise<{ phase_token: number; phase_deadline_at: Date }> {
    const q = exec(tx);
    const [row] = await q<Array<{ phase_token: number; phase_deadline_at: Date }>>`
      UPDATE room_matches SET
        status = ${data.status},
        state = ${q.json(data.state as never)},
        state_version = state_version + 1,
        phase_token = CASE WHEN phase_deadline_at IS DISTINCT FROM ${data.deadlineAt}::timestamptz THEN phase_token + 1 ELSE phase_token END,
        phase_deadline_at = ${data.deadlineAt}::timestamptz,
        started_at = CASE WHEN ${data.started ?? false} THEN clock_timestamp() ELSE started_at END
      WHERE id = ${id}
      RETURNING phase_token, phase_deadline_at
    `;
    return row;
  },

  /** Ends the match in the caller's transaction: result, seat places, no live seat left, the room back to waiting. */
  async finish(tx: TransactionSql, row: Pick<RoomMatchRow, 'id' | 'lobby_id'>, data: { status: 'completed' | 'cancelled'; state: unknown; result: RoomResult }): Promise<void> {
    const q = exec(tx);
    await q`
      UPDATE room_matches SET status = ${data.status}, state = ${q.json((data.state ?? null) as never)}, state_version = state_version + 1,
        phase_token = phase_token + 1, phase_deadline_at = NULL, result = ${q.json(data.result as never)}, ended_at = clock_timestamp()
      WHERE id = ${row.id}
    `;
    // Include seats excluded at the gate and cancelled matches (empty standings): every seat is released atomically.
    await q`
      WITH standings AS (
        SELECT * FROM unnest(
          ${data.result.standings.map((s) => s.userId)}::uuid[],
          ${data.result.standings.map((s) => s.place)}::smallint[],
          ${data.result.standings.map((s) => s.points)}::int[]
        ) AS r(user_id, place, points)
      )
      UPDATE room_seats s SET active = false, place = COALESCE(r.place, s.place), points = COALESCE(r.points, s.points)
      FROM room_seats roster LEFT JOIN standings r ON r.user_id = roster.user_id
      WHERE roster.match_id = ${row.id} AND s.match_id = roster.match_id AND s.user_id = roster.user_id
    `;
    if (row.lobby_id) {
      await q`UPDATE lobbies SET status = 'waiting', updated_at = now() WHERE id = ${row.lobby_id} AND status = 'active' AND game_mode = 'room_game'`;
      await q`UPDATE lobby_members SET is_ready = false WHERE lobby_id = ${row.lobby_id}`;
    }
  },

  async setPhase(tx: TransactionSql, id: string, deadlineAt: Date): Promise<{ phase_token: number; phase_deadline_at: Date }> {
    const [row] = await exec(tx)<Array<{ phase_token: number; phase_deadline_at: Date }>>`
      UPDATE room_matches SET phase_token = phase_token + 1, phase_deadline_at = ${deadlineAt}::timestamptz, state_version = state_version + 1
      WHERE id = ${id} RETURNING phase_token, phase_deadline_at
    `;
    return row;
  },

  /** No socket left: away from now (the first moment counts), with its own deadline (null at the ready gate). */
  async markAbsent(tx: TransactionSql, id: string, userId: string, deadlineAt: Date | null): Promise<void> {
    await exec(tx)`
      UPDATE room_seats SET connected = false, absent_since = COALESCE(absent_since, clock_timestamp()), absence_deadline_at = ${deadlineAt}::timestamptz
      WHERE match_id = ${id} AND user_id = ${userId}
    `;
  },

  /** Back: `chargeMs` of absence is added to the budget used, and older disconnect checks go stale. */
  async markPresent(tx: TransactionSql, id: string, userId: string, chargeMs: number): Promise<void> {
    await exec(tx)`
      UPDATE room_seats SET connected = true, absent_since = NULL, absence_deadline_at = NULL,
        absence_used_ms = absence_used_ms + ${Math.max(0, Math.round(chargeMs))}, presence_gen = presence_gen + 1
      WHERE match_id = ${id} AND user_id = ${userId}
    `;
  },

  async setAbsenceDeadline(tx: TransactionSql, id: string, userId: string, deadlineAt: Date | null): Promise<void> {
    // The window (and the time charged on return) starts now: time away at the ready gate is never charged.
    await exec(tx)`UPDATE room_seats SET absence_deadline_at = ${deadlineAt}::timestamptz, absent_since = clock_timestamp() WHERE match_id = ${id} AND user_id = ${userId}`;
  },

  /**
   * After an outage that began at `outageStart`: each open absence window restarts from `now` with what it had left
   * when the outage began (at least `graceMs`), and the outage itself is never charged (the charge start moves on too).
   */
  async rebaseAbsences(tx: TransactionSql, id: string, outageStart: Date, now: Date, graceMs: number): Promise<void> {
    await exec(tx)`
      UPDATE room_seats SET
        absence_deadline_at = ${now}::timestamptz + GREATEST(absence_deadline_at - ${outageStart}::timestamptz, make_interval(secs => ${graceMs / 1000})),
        absent_since = absent_since + (${now}::timestamptz - ${outageStart}::timestamptz)
      WHERE match_id = ${id} AND active AND NOT connected AND absence_deadline_at IS NOT NULL
    `;
  },

  /** Whether the user still plays in (or waits at the gate of) the live room match of this lobby. */
  async hasLiveSeat(userId: string, lobbyId: string): Promise<boolean> {
    const [row] = await sql<Array<{ live: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM room_seats s JOIN room_matches m ON m.id = s.match_id
        WHERE m.lobby_id = ${lobbyId} AND m.status IN ('ready', 'active') AND s.user_id = ${userId} AND s.active
      ) AS live
    `;
    return row?.live === true;
  },

  /**
   * Seats in live matches that the database calls connected (the presence sweep checks them against sockets), one
   * page at a time in key order: `after` is the last seat of the previous page, so every seat is reached.
   */
  async connectedLiveSeats(
    limit: number,
    after: { userId: string; matchId: string } | null = null,
  ): Promise<Array<{ user_id: string; match_id: string; presence_gen: number }>> {
    return sql<Array<{ user_id: string; match_id: string; presence_gen: number }>>`
      SELECT s.user_id, s.match_id, s.presence_gen FROM room_seats s JOIN room_matches m ON m.id = s.match_id
      WHERE m.status IN ('ready', 'active') AND s.active AND s.connected
        ${after ? sql`AND (s.user_id, s.match_id) > (${after.userId}::uuid, ${after.matchId}::uuid)` : sql``}
      ORDER BY s.user_id, s.match_id
      LIMIT ${limit}
    `;
  },

  async bumpPresence(tx: TransactionSql, id: string, userId: string): Promise<void> {
    await exec(tx)`UPDATE room_seats SET presence_gen = presence_gen + 1 WHERE match_id = ${id} AND user_id = ${userId}`;
  },

  /** The user's live seat's presence fence: the match and its generation (a generation alone repeats across matches). */
  async presenceGeneration(userId: string): Promise<PresenceFence | null> {
    const [row] = await sql<Array<{ match_id: string; presence_gen: number }>>`
      SELECT s.match_id, s.presence_gen FROM room_seats s JOIN room_matches m ON m.id = s.match_id
      WHERE s.user_id = ${userId} AND s.active AND m.status IN ('ready', 'active') LIMIT 1
    `;
    return row ? { matchId: row.match_id, gen: row.presence_gen } : null;
  },

  async liveMatchForUser(userId: string): Promise<{ id: string; game: RoomGameId; lobby_id: string | null } | null> {
    const [row] = await sql<Array<{ id: string; game: RoomGameId; lobby_id: string | null }>>`
      SELECT m.id, m.game, m.lobby_id FROM room_seats s JOIN room_matches m ON m.id = s.match_id
      WHERE s.user_id = ${userId} AND s.active AND m.status IN ${sql(LIVE_ROOM_STATUSES as RoomStatus[])}
      LIMIT 1
    `;
    return row ?? null;
  },

  /**
   * The user's live seat as of this read (`as_of`, database time): an answer that says "none" can be told apart from a
   * start the client already heard about (a read on another replica can finish after that start was broadcast).
   */
  /** Database time now (outside any transaction): taken after a commit, every later read is at least this late. */
  async dbNowMs(): Promise<number> {
    const [row] = await sql<Array<{ ms: number }>>`SELECT (extract(epoch FROM clock_timestamp()) * 1000)::float8 AS ms`;
    return Number(row.ms);
  },

  async livePointerFor(userId: string): Promise<{ asOf: number; live: { id: string; game: RoomGameId; lobby_id: string | null } | null }> {
    const [row] = await sql<Array<{ as_of: number; id: string | null; game: RoomGameId | null; lobby_id: string | null }>>`
      SELECT (extract(epoch FROM statement_timestamp()) * 1000)::float8 AS as_of, live.id, live.game, live.lobby_id
      FROM (SELECT 1) AS one
      LEFT JOIN LATERAL (
        SELECT m.id, m.game, m.lobby_id FROM room_seats s JOIN room_matches m ON m.id = s.match_id
        WHERE s.user_id = ${userId} AND s.active AND m.status IN ${sql(LIVE_ROOM_STATUSES as RoomStatus[])}
        LIMIT 1
      ) live ON true
    `;
    return { asOf: Number(row.as_of), live: row.id ? { id: row.id, game: row.game!, lobby_id: row.lobby_id } : null };
  },

  async dueMatches(limit: number): Promise<Array<{ id: string; phase_token: number }>> {
    return sql<Array<{ id: string; phase_token: number }>>`
      SELECT id, phase_token FROM room_matches
      WHERE status IN ('ready', 'active') AND phase_deadline_at <= statement_timestamp()
      ORDER BY phase_deadline_at LIMIT ${limit}
    `;
  },

  async anyLive(): Promise<boolean> {
    const [row] = await sql<Array<{ live: boolean }>>`SELECT EXISTS (SELECT 1 FROM room_matches WHERE status IN ('ready', 'active')) AS live`;
    return row?.live ?? false;
  },

  async staleLiveMatches(maxAgeMs: number, limit: number): Promise<string[]> {
    const rows = await sql<Array<{ id: string }>>`
      SELECT id FROM room_matches
      WHERE status IN ('ready', 'active') AND created_at < statement_timestamp() - make_interval(secs => ${maxAgeMs / 1000})
      ORDER BY created_at LIMIT ${limit}
    `;
    return rows.map((r) => r.id);
  },

  /** Retention: the command inbox and the content snapshot (values included) of matches that ended `days` ago. */
  async purgeEnded(days: number, batch: number): Promise<{ commands: number; contents: number }> {
    const commands = await sql`
      DELETE FROM room_commands WHERE ctid IN (
        SELECT c.ctid FROM room_commands c JOIN room_matches m ON m.id = c.match_id
        WHERE m.ended_at < statement_timestamp() - make_interval(days => ${days}) LIMIT ${batch}
      )
    `;
    const contents = await sql`
      DELETE FROM room_match_content WHERE match_id IN (
        SELECT c.match_id FROM room_match_content c JOIN room_matches m ON m.id = c.match_id
        WHERE m.ended_at < statement_timestamp() - make_interval(days => ${days}) LIMIT ${batch}
      )
    `;
    return { commands: commands.count, contents: contents.count };
  },
};
