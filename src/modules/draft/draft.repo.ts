import { sql, withStatementTimeout, type TransactionSql } from '../../db/index.js';
import type { AvatarCustomization } from '../users/avatar-customization.js';
import type { DailyPlayer } from '../daily/daily.repo.js';
import type { RunSetup, RunState } from './draft.run.js';
import type { MatchDay, Pick } from './draft.rules.js';

const exec = (tx: TransactionSql): typeof sql => tx as unknown as typeof sql;

export interface FreeRunRow {
  id: string;
  user_id: string | null;
  guest_id: string | null;
  kind: 'free' | 'challenge';
  challenge_code: string | null;
  setup: RunSetup;
  state: RunState;
  state_version: number;
  done: boolean;
  coins_earned: number;
  ranked: boolean;
  league_id: string | null;
  week: string | null;
  created_at: Date;
}

/** One member's best run of a league's week, with what the board shows of them. */
export interface LeagueBoardRow {
  rank: number; runId: string; userId: string; username: string; avatarUrl: string | null; avatarCustomization: AvatarCustomization | null; country: string | null; tier: string | null; score: number; record: number;
}
const BOARD_MS = 5_000;

export interface ChallengeRow {
  code: string;
  user_id: string | null;
  guest_id: string | null;
  from_name: string;
  setup: RunSetup;
  day: string | null;
  picks: (Pick | null)[];
  record: { w: number; d: number; l: number; points: number; gf: number; ga: number };
  respins_used: number;
  source_run: string;
  created_at: Date;
}

export interface TieRow {
  id: string; a_run: string; b_run: string; a_user: string | null; a_guest: string | null; b_user: string | null; b_guest: string | null;
  a_name: string; b_name: string; a_picks: (Pick | null)[]; b_picks: (Pick | null)[]; seed: string; result: MatchDay; formation: string; created_at: Date;
}
interface TieSideData { run: string; player: DailyPlayer; name: string; picks: (Pick | null)[] }

const ownerColumns = (p: DailyPlayer) => (p.kind === 'member' ? { user_id: p.userId, guest_id: null } : { user_id: null, guest_id: p.guestId });

export const draftRepo = {
  withTx: <T>(fn: (tx: TransactionSql) => Promise<T>): Promise<T> => sql.begin((tx) => fn(tx as unknown as TransactionSql)) as Promise<T>,

  /** A member's best finished daily of a version. The table name comes from a closed list. */
  async bestOf(variant: 'budget' | 'classic' | 'knowledge', userId: string): Promise<{ score: number; record: number } | null> {
    const rows = await sql.unsafe<Array<{ score: number; record: number }>>(`SELECT score, record FROM draft_runs_${variant} WHERE user_id = $1 AND done ORDER BY score DESC LIMIT 1`, [userId]);
    return rows[0] ?? null;
  },

  async insertFreeRun(tx: TransactionSql, data: { id: string; player: DailyPlayer; kind: FreeRunRow['kind']; challengeCode: string | null; setup: RunSetup; state: RunState; ranked?: boolean }): Promise<FreeRunRow> {
    const owner = ownerColumns(data.player);
    const [row] = await exec(tx)<FreeRunRow[]>`
      INSERT INTO draft_free_runs (id, user_id, guest_id, kind, challenge_code, setup, state, ranked)
      VALUES (${data.id}, ${owner.user_id}, ${owner.guest_id}, ${data.kind}, ${data.challengeCode}, ${exec(tx).json(data.setup as never)}, ${exec(tx).json(data.state as never)}, ${data.ranked ?? false})
      RETURNING *, week::text AS week`;
    return row;
  },

  async lockFreeRun(tx: TransactionSql, id: string): Promise<FreeRunRow | null> {
    const [row] = await exec(tx)<FreeRunRow[]>`SELECT *, week::text AS week FROM draft_free_runs WHERE id = ${id} FOR UPDATE`;
    return row ?? null;
  },

  /** `board`: where a finished run lands (its league and week); set once, with the result. */
  async saveFreeRun(tx: TransactionSql, id: string, data: { state: RunState; version: number; done: boolean; score: number | null; coinsEarned: number; record?: number | null; board?: { leagueId: string; week: string } | null }): Promise<FreeRunRow> {
    const [row] = await exec(tx)<FreeRunRow[]>`
      UPDATE draft_free_runs SET state = ${exec(tx).json(data.state as never)}, state_version = ${data.version}, done = ${data.done}, score = ${data.score}, coins_earned = ${data.coinsEarned},
        record = coalesce(record, ${data.record ?? null}), league_id = coalesce(league_id, ${data.board?.leagueId ?? null}), week = coalesce(week, ${data.board?.week ?? null}::date),
        completed_at = CASE WHEN ${data.done} THEN coalesce(completed_at, now()) ELSE completed_at END, updated_at = now()
      WHERE id = ${id} RETURNING *, week::text AS week`;
    return row;
  },

  /** The setups of this player's latest free runs in a league: what they have just been dealt. */
  async recentSetups(player: DailyPlayer, leagueId: string, limit: number): Promise<RunSetup[]> {
    const rows = player.kind === 'member'
      ? await sql<Array<{ setup: RunSetup }>>`SELECT setup FROM draft_free_runs WHERE user_id = ${player.userId} AND kind = 'free' AND setup->>'leagueId' = ${leagueId} ORDER BY created_at DESC LIMIT ${limit}`
      : await sql<Array<{ setup: RunSetup }>>`SELECT setup FROM draft_free_runs WHERE guest_id = ${player.guestId} AND kind = 'free' AND setup->>'leagueId' = ${leagueId} ORDER BY created_at DESC LIMIT ${limit}`;
    return rows.map((r) => r.setup);
  },

  async getFreeRun(id: string): Promise<FreeRunRow | null> {
    const [row] = await sql<FreeRunRow[]>`SELECT *, week::text AS week FROM draft_free_runs WHERE id = ${id}`;
    return row ?? null;
  },

  /** A league's weekly board: each member's best finished ranked run, best first. Guests, bots and deleted accounts never show. */
  async leagueBoard(leagueId: string, week: string, limit: number): Promise<{ players: number; top: LeagueBoardRow[] }> {
    const rows = await withStatementTimeout((tx) => exec(tx)<Array<LeagueBoardRow & { players: number }>>`
      WITH best AS MATERIALIZED (
        SELECT DISTINCT ON (r.user_id) r.id, r.user_id, r.score, r.record, r.completed_at
        FROM draft_free_runs r JOIN users u ON u.id = r.user_id
        WHERE r.ranked AND r.done AND r.league_id = ${leagueId} AND r.week = ${week}::date
          AND u.is_ai = false AND u.is_guest = false AND u.is_seed = false AND u.is_deleted = false
          AND u.deleted_at IS NULL AND u.pending_deletion_at IS NULL
        ORDER BY r.user_id, r.score DESC, r.completed_at ASC, r.id ASC
      ), leaders AS (
        SELECT b.*, (row_number() OVER (ORDER BY b.score DESC, b.completed_at ASC, b.id ASC))::int AS rank, (count(*) OVER ())::int AS players
        FROM best b ORDER BY b.score DESC, b.completed_at ASC, b.id ASC LIMIT ${limit}
      )
      SELECT r.rank, r.players, r.id AS "runId", u.id AS "userId", COALESCE(NULLIF(u.nickname, ''), 'Player') AS "username", u.avatar_url AS "avatarUrl",
        u.avatar_customization AS "avatarCustomization", u.country, CASE WHEN rp.placement_status = 'placed' THEN rp.tier END AS "tier", r.score, r.record
      FROM leaders r JOIN users u ON u.id = r.user_id LEFT JOIN ranked_profiles rp ON rp.user_id = u.id
      ORDER BY r.rank`, BOARD_MS);
    return { players: rows[0]?.players ?? 0, top: rows.map(({ players: _players, ...row }) => row) };
  },

  /** One member's best on a league's weekly board, ranked against everyone's best (a tie with an earlier run ranks below it). */
  async leagueBoardRank(userId: string, leagueId: string, week: string): Promise<LeagueBoardRow | null> {
    const [row] = await withStatementTimeout((tx) => exec(tx)<LeagueBoardRow[]>`
      WITH mine AS (
        SELECT r.id, r.score, r.record, r.completed_at FROM draft_free_runs r
        WHERE r.user_id = ${userId} AND r.ranked AND r.done AND r.league_id = ${leagueId} AND r.week = ${week}::date
        ORDER BY r.score DESC, r.completed_at ASC, r.id ASC LIMIT 1
      )
      SELECT (1 + (
          SELECT count(DISTINCT r.user_id) FROM draft_free_runs r JOIN users u ON u.id = r.user_id
          WHERE r.ranked AND r.done AND r.league_id = ${leagueId} AND r.week = ${week}::date AND r.user_id <> ${userId}
            AND (r.score > m.score OR (r.score = m.score AND (r.completed_at < m.completed_at OR (r.completed_at = m.completed_at AND r.id < m.id))))
            AND u.is_ai = false AND u.is_guest = false AND u.is_seed = false AND u.is_deleted = false AND u.deleted_at IS NULL AND u.pending_deletion_at IS NULL
        ))::int AS rank,
        m.id AS "runId", u.id AS "userId", COALESCE(NULLIF(u.nickname, ''), 'Player') AS "username", u.avatar_url AS "avatarUrl", u.avatar_customization AS "avatarCustomization",
        u.country, CASE WHEN rp.placement_status = 'placed' THEN rp.tier END AS "tier", m.score, m.record
      FROM mine m JOIN users u ON u.id = ${userId} LEFT JOIN ranked_profiles rp ON rp.user_id = u.id`, BOARD_MS);
    return row ?? null;
  },

  /** A member's best of the week in every league they played. */
  async weekBests(userId: string, week: string): Promise<Array<{ leagueId: string; score: number; record: number }>> {
    return sql<Array<{ leagueId: string; score: number; record: number }>>`
      SELECT DISTINCT ON (league_id) league_id AS "leagueId", score, record FROM draft_free_runs
      WHERE user_id = ${userId} AND ranked AND done AND week = ${week}::date
      ORDER BY league_id, score DESC, completed_at ASC`;
  },

  async anyChallengeRun(player: DailyPlayer, code: string): Promise<FreeRunRow | null> {
    const [row] = player.kind === 'member'
      ? await sql<FreeRunRow[]>`SELECT * FROM draft_free_runs WHERE challenge_code = ${code} AND user_id = ${player.userId}`
      : await sql<FreeRunRow[]>`SELECT * FROM draft_free_runs WHERE challenge_code = ${code} AND guest_id = ${player.guestId}`;
    return row ?? null;
  },

  async findChallengeRun(player: DailyPlayer, code: string): Promise<FreeRunRow | null> {
    const [row] = player.kind === 'member'
      ? await sql<FreeRunRow[]>`SELECT * FROM draft_free_runs WHERE challenge_code = ${code} AND user_id = ${player.userId} AND done ORDER BY completed_at LIMIT 1`
      : await sql<FreeRunRow[]>`SELECT * FROM draft_free_runs WHERE challenge_code = ${code} AND guest_id = ${player.guestId} AND done ORDER BY completed_at LIMIT 1`;
    return row ?? null;
  },

  /** Rewarded free runs of this player today (Buenos Aires day), under the run's transaction. */
  async rewardedToday(tx: TransactionSql, userId: string, day: string): Promise<number> {
    const [row] = await exec(tx)<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM draft_coin_awards WHERE user_id = ${userId} AND day = ${day} AND source = 'free'`;
    return row.n;
  },

  /** Once per run: false when it was already paid. */
  async recordAward(tx: TransactionSql, data: { runId: string; userId: string; day: string; source: 'daily' | 'free'; coins: number }): Promise<boolean> {
    const rows = await exec(tx)`
      INSERT INTO draft_coin_awards (run_id, user_id, day, source, coins) VALUES (${data.runId}, ${data.userId}, ${data.day}, ${data.source}, ${data.coins})
      ON CONFLICT (run_id) DO NOTHING RETURNING run_id`;
    return rows.length > 0;
  },

  async insertChallenge(data: Omit<ChallengeRow, 'created_at'>): Promise<ChallengeRow> {
    const [row] = await sql<ChallengeRow[]>`
      INSERT INTO draft_challenges (code, user_id, guest_id, from_name, setup, day, picks, record, respins_used, source_run)
      VALUES (${data.code}, ${data.user_id}, ${data.guest_id}, ${data.from_name}, ${sql.json(data.setup as never)}, ${data.day}, ${sql.json(data.picks as never)}, ${sql.json(data.record as never)}, ${data.respins_used}, ${data.source_run})
      ON CONFLICT (source_run) DO UPDATE SET source_run = EXCLUDED.source_run
      RETURNING *, day::text AS day`;
    return row;
  },

  /** The challenge made from this run, if any (a run makes at most one). */
  async challengeOfRun(runId: string): Promise<ChallengeRow | null> {
    const [row] = await sql<ChallengeRow[]>`SELECT *, day::text AS day FROM draft_challenges WHERE source_run = ${runId}`;
    return row ?? null;
  },

  /** Which of these challenges this player has finished a run of, in one query. */
  async finishedChallengeCodes(player: DailyPlayer, codes: readonly string[]): Promise<Set<string>> {
    if (!codes.length) return new Set();
    const rows = player.kind === 'member'
      ? await sql<Array<{ code: string }>>`SELECT DISTINCT challenge_code AS code FROM draft_free_runs WHERE challenge_code = ANY(${codes as string[]}) AND user_id = ${player.userId} AND done`
      : await sql<Array<{ code: string }>>`SELECT DISTINCT challenge_code AS code FROM draft_free_runs WHERE challenge_code = ANY(${codes as string[]}) AND guest_id = ${player.guestId} AND done`;
    return new Set(rows.map((r) => r.code));
  },

  /** The challenges made from any of these runs, in one query. */
  async challengesOfRuns(runIds: readonly string[]): Promise<ChallengeRow[]> {
    if (!runIds.length) return [];
    return sql<ChallengeRow[]>`SELECT *, day::text AS day FROM draft_challenges WHERE source_run = ANY(${runIds as string[]}::uuid[])`;
  },

  async getChallenge(code: string): Promise<ChallengeRow | null> {
    const [row] = await sql<ChallengeRow[]>`SELECT *, day::text AS day FROM draft_challenges WHERE code = ${code}`;
    return row ?? null;
  },

  /** The stored tie, or this one when it is the first: a pairing is only ever played once. */
  async saveTie(data: { a: TieSideData; b: TieSideData; seed: string; result: MatchDay; formation: string }): Promise<TieRow> {
    const a = ownerColumns(data.a.player), b = ownerColumns(data.b.player);
    const inserted = await sql<TieRow[]>`
      INSERT INTO draft_ties (a_run, b_run, a_user, a_guest, b_user, b_guest, a_name, b_name, a_picks, b_picks, seed, result, formation)
      VALUES (${data.a.run}, ${data.b.run}, ${a.user_id}, ${a.guest_id}, ${b.user_id}, ${b.guest_id}, ${data.a.name}, ${data.b.name}, ${sql.json(data.a.picks as never)}, ${sql.json(data.b.picks as never)}, ${data.seed}, ${sql.json(data.result as never)}, ${data.formation})
      ON CONFLICT (a_run, b_run) DO NOTHING RETURNING *`;
    if (inserted[0]) return inserted[0];
    const [row] = await sql<TieRow[]>`SELECT * FROM draft_ties WHERE a_run = ${data.a.run} AND b_run = ${data.b.run}`;
    return row;
  },

  async myTies(player: DailyPlayer, limit: number): Promise<TieRow[]> {
    return player.kind === 'member'
      ? sql<TieRow[]>`
          (SELECT * FROM draft_ties WHERE a_user = ${player.userId} ORDER BY created_at DESC LIMIT ${limit})
          UNION ALL (SELECT * FROM draft_ties WHERE b_user = ${player.userId} ORDER BY created_at DESC LIMIT ${limit})
          ORDER BY created_at DESC LIMIT ${limit}`
      : sql<TieRow[]>`
          (SELECT * FROM draft_ties WHERE a_guest = ${player.guestId} ORDER BY created_at DESC LIMIT ${limit})
          UNION ALL (SELECT * FROM draft_ties WHERE b_guest = ${player.guestId} ORDER BY created_at DESC LIMIT ${limit})
          ORDER BY created_at DESC LIMIT ${limit}`;
  },

  async purgeShared(days: number, batch: number): Promise<number> {
    const challenges = await sql`DELETE FROM draft_challenges WHERE code IN (SELECT code FROM draft_challenges WHERE created_at < now() - make_interval(days => ${days}) LIMIT ${batch}) RETURNING code`;
    const ties = await sql`DELETE FROM draft_ties WHERE id IN (SELECT id FROM draft_ties WHERE created_at < now() - make_interval(days => ${days}) LIMIT ${batch}) RETURNING id`;
    return challenges.length + ties.length;
  },

  /** Unfinished free runs are worth nothing after a while, finished ones a bit later. Challenges and ties keep their own copies of the teams. */
  async purgeAbandoned(openDays: number, doneDays: number, batch: number): Promise<number> {
    const rows = await sql`
      DELETE FROM draft_free_runs WHERE id IN (
        (SELECT id FROM draft_free_runs WHERE NOT done AND created_at < now() - make_interval(days => ${openDays}) LIMIT ${batch})
        UNION ALL (SELECT id FROM draft_free_runs WHERE done AND completed_at < now() - make_interval(days => ${doneDays}) LIMIT ${batch})
      ) RETURNING id`;
    return rows.length;
  },
};
