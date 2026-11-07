import { sql, type TransactionSql } from '../../db/index.js';
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
  created_at: Date;
}

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

  async insertFreeRun(tx: TransactionSql, data: { id: string; player: DailyPlayer; kind: FreeRunRow['kind']; challengeCode: string | null; setup: RunSetup; state: RunState }): Promise<FreeRunRow> {
    const owner = ownerColumns(data.player);
    const [row] = await exec(tx)<FreeRunRow[]>`
      INSERT INTO draft_free_runs (id, user_id, guest_id, kind, challenge_code, setup, state)
      VALUES (${data.id}, ${owner.user_id}, ${owner.guest_id}, ${data.kind}, ${data.challengeCode}, ${exec(tx).json(data.setup as never)}, ${exec(tx).json(data.state as never)})
      RETURNING *`;
    return row;
  },

  async lockFreeRun(tx: TransactionSql, id: string): Promise<FreeRunRow | null> {
    const [row] = await exec(tx)<FreeRunRow[]>`SELECT * FROM draft_free_runs WHERE id = ${id} FOR UPDATE`;
    return row ?? null;
  },

  async saveFreeRun(tx: TransactionSql, id: string, data: { state: RunState; version: number; done: boolean; score: number | null; coinsEarned: number }): Promise<FreeRunRow> {
    const [row] = await exec(tx)<FreeRunRow[]>`
      UPDATE draft_free_runs SET state = ${exec(tx).json(data.state as never)}, state_version = ${data.version}, done = ${data.done}, score = ${data.score}, coins_earned = ${data.coinsEarned},
        completed_at = CASE WHEN ${data.done} THEN coalesce(completed_at, now()) ELSE completed_at END, updated_at = now()
      WHERE id = ${id} RETURNING *`;
    return row;
  },

  async getFreeRun(id: string): Promise<FreeRunRow | null> {
    const [row] = await sql<FreeRunRow[]>`SELECT * FROM draft_free_runs WHERE id = ${id}`;
    return row ?? null;
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
