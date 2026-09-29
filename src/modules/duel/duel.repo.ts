import { sql, type TransactionSql } from '../../db/index.js';
import { parseStoredAvatarCustomization, type AvatarCustomization } from '../users/avatar-customization.js';
import type { DuelGameId, DuelLocale } from './duel.types.js';

type Q = TransactionSql | typeof sql;
const exec = (q?: Q) => (q ?? sql) as typeof sql;

export type DuelStatus = 'ready' | 'countdown' | 'active' | 'paused' | 'completed' | 'cancelled';
export const LIVE_STATUSES: readonly DuelStatus[] = ['ready', 'countdown', 'active', 'paused'];

export interface DuelResult {
  scores: [number, number];
  winnerSeat: 0 | 1 | null;
  reason: 'score' | 'forfeit' | 'idle' | 'disconnect' | 'cancelled';
  leftSeat: 0 | 1 | null;
}

export interface DuelMatchRow {
  id: string;
  game: DuelGameId;
  engine_version: number;
  lobby_id: string | null;
  status: DuelStatus;
  state: unknown;
  state_version: number;
  phase_token: number;
  phase_deadline_at: Date | null;
  rng_counter: number;
  paused_from: 'countdown' | 'active' | null;
  paused_remaining_ms: number | null;
  /** When the current pause began (kept across a re-pause); null while not paused. */
  paused_at: Date | null;
  result: DuelResult | null;
  /** The database clock when the row was read (clock_timestamp()). */
  now: Date;
}

export interface DuelParticipantRow {
  seat: 0 | 1;
  user_id: string;
  is_guest: boolean;
  locale: DuelLocale;
  ready_at: Date | null;
  connected: boolean;
  absent_since: Date | null;
  absence_deadline_at: Date | null;
  absence_budget_ms: number;
  presence_gen: number;
  nickname: string | null;
  avatar_url: string | null;
  avatar_customization: AvatarCustomization | null;
}

export interface PoolItem { item_id: string; difficulty: string; payload: unknown }

const MATCH_COLUMNS = `id, game, engine_version, lobby_id, status, state, state_version, phase_token, phase_deadline_at,
  rng_counter, paused_from, paused_remaining_ms, paused_at, result, clock_timestamp() AS now`;

export const duelRepo = {
  withTx<T>(fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
    return sql.begin((tx) => fn(tx)) as Promise<T>;
  },

  /**
   * Picks `wanted` items per difficulty, preferring items neither player met in their recent duels; when
   * the pool runs short for a difficulty, recently seen items fill the gap. Read outside the start transaction.
   */
  async pickPool(game: DuelGameId, userIds: string[], wanted: Record<string, number>): Promise<PoolItem[]> {
    const difficulties = Object.keys(wanted);
    const counts = difficulties.map((d) => wanted[d]);
    return sql<PoolItem[]>`
      WITH recent_matches AS (
        SELECT p.match_id FROM duel_participants p
        JOIN duel_matches m ON m.id = p.match_id
        WHERE p.user_id = ANY(${userIds}::uuid[]) AND m.game = ${game}
        ORDER BY m.created_at DESC LIMIT 40
      ), recent AS (
        SELECT DISTINCT unnest(c.item_ids) AS item_id FROM duel_match_content c WHERE c.match_id IN (SELECT match_id FROM recent_matches)
      ), wanted AS (
        SELECT * FROM unnest(${difficulties}::text[], ${counts}::int[]) AS w(difficulty, n)
      ), ranked AS (
        SELECT p.item_id, p.difficulty, p.payload,
               row_number() OVER (PARTITION BY p.difficulty ORDER BY (p.item_id IN (SELECT item_id FROM recent)), random()) AS rn
        FROM duel_pool p WHERE p.game = ${game} AND p.enabled AND p.difficulty IN (SELECT difficulty FROM wanted)
      )
      SELECT r.item_id, r.difficulty, r.payload FROM ranked r JOIN wanted w ON w.difficulty = r.difficulty WHERE r.rn <= w.n
    `;
  },

  async insertMatch(
    tx: TransactionSql,
    data: {
      game: DuelGameId; engineVersion: number; lobbyId: string; readyMs: number; seed: string; itemIds: string[]; content: unknown;
      seats: Array<{ userId: string; isGuest: boolean }>;
    },
  ): Promise<{ id: string; phase_token: number; phase_deadline_at: Date }> {
    const q = exec(tx);
    const [match] = await q<Array<{ id: string; phase_token: number; phase_deadline_at: Date }>>`
      INSERT INTO duel_matches (game, engine_version, lobby_id, status, phase_token, phase_deadline_at)
      VALUES (${data.game}, ${data.engineVersion}, ${data.lobbyId}, 'ready', 1, clock_timestamp() + make_interval(secs => ${data.readyMs / 1000}))
      RETURNING id, phase_token, phase_deadline_at
    `;
    await q`
      INSERT INTO duel_match_content (match_id, seed, item_ids, content)
      VALUES (${match.id}, ${data.seed}, ${data.itemIds}, ${q.json(data.content as never)})
    `;
    for (const [seat, player] of data.seats.entries()) {
      await q`
        INSERT INTO duel_participants (match_id, seat, user_id, is_guest)
        VALUES (${match.id}, ${seat}, ${player.userId}, ${player.isGuest})
      `;
    }
    return match;
  },

  /**
   * The room this start came from, re-checked under lock: exactly these members, all ready, still waiting,
   * still a duel room of this game. Flips it active; false when anything changed since the host pressed start.
   */
  async claimLobby(tx: TransactionSql, lobbyId: string, game: DuelGameId, userIds: string[]): Promise<boolean> {
    const q = exec(tx);
    const members = await q<Array<{ user_id: string; is_ready: boolean }>>`
      SELECT user_id, is_ready FROM lobby_members WHERE lobby_id = ${lobbyId} ORDER BY user_id FOR UPDATE
    `;
    const expected = [...userIds].sort();
    if (members.length !== expected.length || members.some((m, i) => !m.is_ready || m.user_id !== expected[i])) return false;
    const activated = await q<Array<{ id: string }>>`
      UPDATE lobbies SET status = 'active', updated_at = now()
      WHERE id = ${lobbyId} AND status = 'waiting' AND game_mode = 'duel' AND duel_game = ${game}
      RETURNING id
    `;
    return activated.length === 1;
  },

  /**
   * Locks the match, then reads the database clock in a second statement: the row's projected columns are
   * evaluated before the lock wait, so a clock read with them could predate a long wait and admit a late command.
   */
  async lockMatch(tx: TransactionSql, id: string): Promise<DuelMatchRow | null> {
    const q = exec(tx);
    const [row] = await q<DuelMatchRow[]>`SELECT ${q.unsafe(MATCH_COLUMNS)} FROM duel_matches WHERE id = ${id} FOR UPDATE`;
    if (!row) return null;
    const [clock] = await q<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
    return { ...row, now: clock.now };
  },

  async getMatch(id: string): Promise<DuelMatchRow | null> {
    const [row] = await sql<DuelMatchRow[]>`SELECT ${sql.unsafe(MATCH_COLUMNS)} FROM duel_matches WHERE id = ${id}`;
    return row ?? null;
  },

  async getContent(q: Q | undefined, id: string): Promise<{ seed: string; content: unknown } | null> {
    const [row] = await exec(q)<Array<{ seed: string; content: unknown }>>`SELECT seed, content FROM duel_match_content WHERE match_id = ${id}`;
    return row ?? null;
  },

  async participants(q: Q | undefined, id: string): Promise<DuelParticipantRow[]> {
    const rows = await exec(q)<Array<Omit<DuelParticipantRow, 'avatar_customization'> & { avatar_customization: unknown }>>`
      SELECT p.seat, p.user_id, p.is_guest, p.locale, p.ready_at, p.connected, p.absent_since, p.absence_deadline_at,
             p.absence_budget_ms, p.presence_gen,
             u.nickname, u.avatar_url, u.avatar_customization
      FROM duel_participants p JOIN users u ON u.id = p.user_id
      WHERE p.match_id = ${id} ORDER BY p.seat
    `;
    return rows.map((r) => ({ ...r, avatar_customization: parseStoredAvatarCustomization(r.avatar_customization) }));
  },

  async markReady(tx: TransactionSql, id: string, seat: number, locale: DuelLocale): Promise<void> {
    await exec(tx)`UPDATE duel_participants SET ready_at = COALESCE(ready_at, clock_timestamp()), locale = ${locale} WHERE match_id = ${id} AND seat = ${seat}`;
  },

  async setLocale(id: string, userId: string, locale: DuelLocale): Promise<void> {
    await sql`UPDATE duel_participants SET locale = ${locale} WHERE match_id = ${id} AND user_id = ${userId} AND locale <> ${locale}`;
  },

  async findCommand(tx: TransactionSql, id: string, userId: string, commandId: string): Promise<{ payload_hash: string; result: unknown } | null> {
    const [row] = await exec(tx)<Array<{ payload_hash: string; result: unknown }>>`
      SELECT payload_hash, result FROM duel_commands WHERE match_id = ${id} AND user_id = ${userId} AND command_id = ${commandId}
    `;
    return row ?? null;
  },

  async insertCommand(tx: TransactionSql, id: string, userId: string, commandId: string, hash: string, result: unknown): Promise<void> {
    const q = exec(tx);
    await q`
      INSERT INTO duel_commands (match_id, user_id, command_id, payload_hash, result)
      VALUES (${id}, ${userId}, ${commandId}, ${hash}, ${q.json(result as never)})
    `;
  },

  /** Persists a step; `deadlineAt` null keeps the deadline, a new one also bumps the phase token (old timers go stale). */
  async saveStep(
    tx: TransactionSql,
    id: string,
    data: { status: DuelStatus; state: unknown; deadlineAt: Date | null; rngCounter: number; started?: boolean },
  ): Promise<{ phase_token: number; phase_deadline_at: Date }> {
    const q = exec(tx);
    const moving = data.deadlineAt !== null;
    const [row] = await q<Array<{ phase_token: number; phase_deadline_at: Date }>>`
      UPDATE duel_matches SET
        status = ${data.status},
        state = ${q.json(data.state as never)},
        state_version = state_version + 1,
        rng_counter = ${data.rngCounter},
        phase_token = CASE WHEN ${moving} THEN phase_token + 1 ELSE phase_token END,
        phase_deadline_at = CASE WHEN ${moving} THEN ${data.deadlineAt ?? null}::timestamptz ELSE phase_deadline_at END,
        started_at = CASE WHEN ${data.started ?? false} THEN clock_timestamp() ELSE started_at END
      WHERE id = ${id}
      RETURNING phase_token, phase_deadline_at
    `;
    return row;
  },

  /**
   * Ends the match in the caller's transaction: result, participant outcomes, no live seat left, and the
   * room back to waiting with readiness reset (rematch = Ready + Start in the same room).
   */
  async finish(tx: TransactionSql, row: Pick<DuelMatchRow, 'id' | 'lobby_id'>, data: { status: 'completed' | 'cancelled'; state: unknown; result: DuelResult; rngCounter: number }): Promise<void> {
    const q = exec(tx);
    await q`
      UPDATE duel_matches SET status = ${data.status}, state = ${q.json(data.state as never)}, state_version = state_version + 1,
        phase_token = phase_token + 1, phase_deadline_at = NULL, rng_counter = ${data.rngCounter},
        paused_from = NULL, paused_remaining_ms = NULL, paused_at = NULL,
        result = ${q.json(data.result as never)}, ended_at = clock_timestamp()
      WHERE id = ${row.id}
    `;
    const { scores, winnerSeat } = data.result;
    for (const seat of [0, 1] as const) {
      const outcome = data.status === 'cancelled' ? 'cancelled' : winnerSeat === null ? 'draw' : winnerSeat === seat ? 'win' : 'loss';
      await q`UPDATE duel_participants SET score = ${scores[seat]}, outcome = ${outcome}, active = false WHERE match_id = ${row.id} AND seat = ${seat}`;
    }
    if (row.lobby_id) {
      await q`UPDATE lobbies SET status = 'waiting', updated_at = now() WHERE id = ${row.lobby_id} AND status = 'active' AND game_mode = 'duel'`;
      await q`UPDATE lobby_members SET is_ready = false WHERE lobby_id = ${row.lobby_id}`;
    }
  },

  /**
   * Moves the match to another lifecycle phase without an engine step (ready → countdown, active ⇄ paused):
   * a new deadline and phase token, and the pause bookkeeping when pausing (cleared otherwise).
   */
  async setPhase(
    tx: TransactionSql,
    id: string,
    data: { status: DuelStatus; deadlineAt: Date; pausedFrom?: 'countdown' | 'active' | null; pausedRemainingMs?: number | null },
  ): Promise<{ phase_token: number; phase_deadline_at: Date }> {
    const q = exec(tx);
    const [row] = await q<Array<{ phase_token: number; phase_deadline_at: Date }>>`
      UPDATE duel_matches SET status = ${data.status}, state_version = state_version + 1, phase_token = phase_token + 1,
        phase_deadline_at = ${data.deadlineAt}::timestamptz,
        paused_from = ${data.pausedFrom ?? null}, paused_remaining_ms = ${data.pausedRemainingMs ?? null},
        -- The pause's first moment (a re-pause keeps it): resume grants at most the time actually paused.
        paused_at = CASE WHEN ${data.status} = 'paused' THEN COALESCE(CASE WHEN status = 'paused' THEN paused_at END, clock_timestamp()) END
      WHERE id = ${id}
      RETURNING phase_token, phase_deadline_at
    `;
    return row;
  },

  /**
   * The seat has no socket left: away from now (the first moment counts, not the latest), with its own reconnect
   * deadline once a pause runs (null at the ready gate, where nothing pauses).
   */
  async markAbsent(tx: TransactionSql, id: string, seat: number, deadlineAt: Date | null): Promise<void> {
    await exec(tx)`
      UPDATE duel_participants SET connected = false, absent_since = COALESCE(absent_since, clock_timestamp()),
        absence_deadline_at = ${deadlineAt}::timestamptz
      WHERE match_id = ${id} AND seat = ${seat}
    `;
  },

  /** The seat is back: `chargeMs` of absence comes off its budget, and older disconnect checks go stale. */
  async markPresent(tx: TransactionSql, id: string, seat: number, chargeMs: number): Promise<void> {
    await exec(tx)`
      UPDATE duel_participants SET connected = true, absent_since = NULL, absence_deadline_at = NULL,
        absence_budget_ms = GREATEST(0, absence_budget_ms - ${Math.max(0, Math.round(chargeMs))}), presence_gen = presence_gen + 1
      WHERE match_id = ${id} AND seat = ${seat}
    `;
  },

  /** A (re)connect of a seat that was never marked away still fences any disconnect check already in flight. */
  async bumpPresence(tx: TransactionSql, id: string, seat: number): Promise<void> {
    await exec(tx)`UPDATE duel_participants SET presence_gen = presence_gen + 1 WHERE match_id = ${id} AND seat = ${seat}`;
  },

  /** The presence generation of the user's seat in their live duel (null: no live duel, nothing to watch). */
  async presenceGeneration(userId: string): Promise<number | null> {
    const [row] = await sql<Array<{ presence_gen: number }>>`
      SELECT p.presence_gen FROM duel_participants p JOIN duel_matches m ON m.id = p.match_id
      WHERE p.user_id = ${userId} AND p.active AND m.status IN ('ready', 'countdown', 'active', 'paused')
      LIMIT 1
    `;
    return row?.presence_gen ?? null;
  },

  /**
   * An outage stretched a pause: the seat's genuine absence (up to its old deadline) is charged now, and its
   * absence restarts at the recovery with a fresh deadline, so the outage itself is never charged.
   */
  async settleOutage(tx: TransactionSql, id: string, seat: number, chargeMs: number, deadlineAt: Date): Promise<void> {
    await exec(tx)`
      UPDATE duel_participants SET absence_budget_ms = GREATEST(0, absence_budget_ms - ${Math.max(0, Math.round(chargeMs))}),
        absent_since = clock_timestamp(), absence_deadline_at = ${deadlineAt}::timestamptz
      WHERE match_id = ${id} AND seat = ${seat}
    `;
  },

  async setAbsenceDeadline(tx: TransactionSql, id: string, seat: number, deadlineAt: Date): Promise<void> {
    await exec(tx)`UPDATE duel_participants SET absence_deadline_at = ${deadlineAt}::timestamptz WHERE match_id = ${id} AND seat = ${seat}`;
  },

  /** Live matches older than the hard cap: a safety net for bugs, since every phase already has a deadline. */
  async staleLiveMatches(maxAgeMs: number, limit: number): Promise<string[]> {
    const rows = await sql<Array<{ id: string }>>`
      SELECT id FROM duel_matches
      WHERE status IN ('ready', 'countdown', 'active', 'paused') AND created_at < statement_timestamp() - make_interval(secs => ${maxAgeMs / 1000})
      ORDER BY created_at LIMIT ${limit}
    `;
    return rows.map((r) => r.id);
  },

  /**
   * Retention: the per-command inbox and the content snapshot (answers included) of matches that ended more than
   * `days` ago. The small duel_matches / duel_participants rows stay for history and stats. Bounded batches.
   */
  async purgeEnded(days: number, batch: number): Promise<{ commands: number; contents: number }> {
    const commands = await sql`
      DELETE FROM duel_commands WHERE ctid IN (
        SELECT c.ctid FROM duel_commands c JOIN duel_matches m ON m.id = c.match_id
        WHERE m.ended_at < statement_timestamp() - make_interval(days => ${days}) LIMIT ${batch}
      )
    `;
    const contents = await sql`
      DELETE FROM duel_match_content WHERE match_id IN (
        SELECT c.match_id FROM duel_match_content c JOIN duel_matches m ON m.id = c.match_id
        WHERE m.ended_at < statement_timestamp() - make_interval(days => ${days}) LIMIT ${batch}
      )
    `;
    return { commands: commands.count, contents: contents.count };
  },

  /**
   * Live matches whose clock has run out by the database clock (the recovery poll's work list). statement_timestamp()
   * (stable, unlike clock_timestamp()) lets the due index bound the scan; expire() re-reads the fresh clock under the lock.
   */
  async dueMatches(limit: number): Promise<Array<{ id: string; phase_token: number }>> {
    return sql<Array<{ id: string; phase_token: number }>>`
      SELECT id, phase_token FROM duel_matches
      WHERE status IN ('ready', 'countdown', 'active', 'paused') AND phase_deadline_at <= statement_timestamp()
      ORDER BY phase_deadline_at LIMIT ${limit}
    `;
  },

  async anyLive(): Promise<boolean> {
    const [row] = await sql<Array<{ live: boolean }>>`
      SELECT EXISTS (SELECT 1 FROM duel_matches WHERE status IN ('ready', 'countdown', 'active', 'paused')) AS live
    `;
    return row?.live ?? false;
  },

  async liveMatchForUser(userId: string): Promise<{ id: string; game: DuelGameId; lobby_id: string | null } | null> {
    const [row] = await sql<Array<{ id: string; game: DuelGameId; lobby_id: string | null }>>`
      SELECT m.id, m.game, m.lobby_id FROM duel_participants p JOIN duel_matches m ON m.id = p.match_id
      WHERE p.user_id = ${userId} AND p.active AND m.status IN ${sql(LIVE_STATUSES as DuelStatus[])}
      LIMIT 1
    `;
    return row ?? null;
  },
};

export type DuelRepo = typeof duelRepo;
