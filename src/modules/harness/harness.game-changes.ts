import { ConflictError, NotFoundError, ValidationError } from '../../core/errors.js';
import { sql } from '../../db/index.js';
import { GAMES } from './harness.games.js';

// Changes to a game (table harness.game_changes): a person writes what they
// want changed, the Game Planner agent (harness worker, job kind game_plan)
// turns it into a plan they can read, and from there it is built, played and
// approved. This module covers asking and planning.

type Db = typeof sql;

export type GameChangeStatus = 'suggested' | 'planning' | 'planned' | 'building' | 'ready' | 'merged' | 'declined' | 'cancelled' | 'failed';

/** What the planner writes. Every list may be empty; the worker checks the shape before saving. */
export interface GameChangePlan {
  summary: string;
  size: 'small' | 'medium' | 'large';
  changes: Array<{ area: 'website' | 'server' | 'both'; what: string }>;
  risks: string[];
  test: string[];
  questions: string[];
}

export interface GameChangeRow {
  id: string;
  number: number;
  game_key: string;
  title: string;
  request: string;
  source: 'person' | 'agent';
  requested_by: string | null;
  status: GameChangeStatus;
  plan: GameChangePlan | null;
  error: string | null;
  decided_by: string | null;
  /** Which build this is, and one entry per part being built (harness.game-builds.ts). */
  build_id?: string | null;
  build_started_at?: Date | string | null;
  builds?: Record<string, GameBuild> | null;
  approving_until?: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}
type Row = GameChangeRow;
export const GAME_CHANGE_COLUMNS = sql`id, number, game_key, title, request, source, requested_by, status, plan, error, decided_by, build_id, build_started_at, builds, approving_until, created_at, updated_at`;
const COLUMNS = GAME_CHANGE_COLUMNS;

/** One part of a change being built: the website or the server, each in its own repository. */
export interface GameBuild {
  state: 'starting' | 'running' | 'ready' | 'failed';
  runId?: number;
  runUrl?: string;
  headSha?: string;
  prNumber?: number;
  prUrl?: string;
  previewUrl?: string;
  error?: string;
  builtAt?: string;
  mergedAt?: string;
}
const PART_OF: Record<string, 'website' | 'server'> = { web: 'website', backend: 'server' };

/** Pure: the builds as the Games page shows them, website first. */
export function buildsView(builds: Record<string, GameBuild> | null | undefined) {
  return Object.entries(builds ?? {})
    .filter(([repo]) => repo in PART_OF)
    .sort(([a], [b]) => (a === 'web' ? -1 : b === 'web' ? 1 : 0))
    .map(([repo, b]) => ({
      repo,
      part: PART_OF[repo]!,
      state: b.state,
      runUrl: b.runUrl ?? null,
      headSha: b.headSha ?? null,
      prNumber: b.prNumber ?? null,
      prUrl: b.prUrl ?? null,
      previewUrl: b.previewUrl ?? null,
      error: b.error ?? null,
      merged: !!b.mergedAt,
    }));
}

const gameName = (key: string) => GAMES.find((g) => g.key === key)?.name ?? key;

/** Pure: a change as the Games page shows it. */
export function changeView(r: Row) {
  return {
    id: r.id,
    number: r.number,
    gameKey: r.game_key,
    gameName: gameName(r.game_key),
    title: r.title,
    request: r.request,
    source: r.source,
    requestedBy: r.requested_by,
    status: r.status,
    plan: r.plan,
    error: r.error,
    decidedBy: r.decided_by,
    builds: buildsView(r.builds),
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

async function enqueuePlan(tx: Db, id: string, gameKey: string): Promise<void> {
  const game = GAMES.find((g) => g.key === gameKey);
  // What the planner needs to know about the game travels with the job (the worker has no copy of the games list).
  const input = { game: { key: gameKey, name: game?.name ?? gameKey, what: game?.what ?? '', group: game?.group ?? null, route: game?.route ?? null } };
  // A person is waiting to read the plan: ahead of the content queue.
  await tx`INSERT INTO harness.jobs (kind, agent_slug, game_change_id, priority, input) VALUES ('game_plan', 'game-planner', ${id}, 0, ${sql.json(input)})`;
}

export async function note(tx: Db, message: string): Promise<void> {
  await tx`INSERT INTO harness.events (type, level, message) VALUES ('game_change', 'info', ${message.slice(0, 1000)})`;
}

async function lock(tx: Db, id: string): Promise<Row> {
  const [row] = await tx<Row[]>`SELECT ${COLUMNS} FROM harness.game_changes WHERE id = ${id} FOR UPDATE`;
  if (!row) throw new NotFoundError('That change no longer exists.');
  return row;
}

/**
 * For a person's action on a change. One action per change at a time (the advisory lock): without it, three overlapping
 * rewrites could each see a different set of jobs and lock them in clashing orders. Then jobs first, then the change:
 * the order a finishing planning job takes them in (its job row, then the change).
 */
export async function lockWithJobs(tx: Db, id: string): Promise<Row> {
  await tx`SELECT pg_advisory_xact_lock(hashtext('harness_game_change'), hashtext(${id}))`;
  await tx`SELECT id FROM harness.jobs WHERE game_change_id = ${id} ORDER BY id FOR UPDATE`;
  return lock(tx, id);
}

export const gameChanges = {
  /** Every change still open, however many, plus the newest that ended in the last two weeks. */
  async list() {
    const rows = await sql<Row[]>`
      (SELECT ${COLUMNS} FROM harness.game_changes WHERE status IN ('suggested', 'planning', 'planned', 'building', 'ready'))
      UNION ALL
      (SELECT ${COLUMNS} FROM harness.game_changes
        WHERE status NOT IN ('suggested', 'planning', 'planned', 'building', 'ready') AND updated_at > now() - interval '14 days'
        ORDER BY updated_at DESC LIMIT 100)
      ORDER BY created_at DESC`;
    return rows.map(changeView);
  },

  async create(input: { gameKey: string; title: string; request: string }, by: string) {
    if (!GAMES.some((g) => g.key === input.gameKey)) throw new ValidationError('That game is not in the Games list.');
    return sql.begin(async (t) => {
      const tx = t as unknown as Db;
      const [row] = await tx<Row[]>`
        INSERT INTO harness.game_changes (game_key, title, request, requested_by)
        VALUES (${input.gameKey}, ${input.title}, ${input.request}, ${by})
        RETURNING ${COLUMNS}`;
      await enqueuePlan(tx, row!.id, input.gameKey);
      await note(tx, `Change ${row!.number} asked for ${gameName(input.gameKey)} by ${by}: ${input.title}`);
      return changeView(row!);
    });
  },

  /** A person rewrote the request (often to answer the planner's questions): plan it again. */
  async replan(id: string, request: string, by: string) {
    return sql.begin(async (t) => {
      const tx = t as unknown as Db;
      const row = await lockWithJobs(tx, id);
      if (!['planned', 'failed', 'planning'].includes(row.status)) throw new ConflictError('This change can no longer be planned again.');
      await tx`
        UPDATE harness.jobs SET status = 'cancelled', finished_at = now(), error = 'request rewritten', lease_owner = NULL, lease_token = NULL, lease_until = NULL
        WHERE game_change_id = ${id} AND status IN ('queued', 'running')`;
      const [next] = await tx<Row[]>`
        UPDATE harness.game_changes SET request = ${request}, status = 'planning', plan = NULL, error = NULL, updated_at = now()
        WHERE id = ${id} RETURNING ${COLUMNS}`;
      await enqueuePlan(tx, id, row.game_key);
      await note(tx, `Change ${row.number}: ${by} rewrote the request`);
      return changeView(next!);
    });
  },

  async cancel(id: string, by: string) {
    return sql.begin(async (t) => {
      const tx = t as unknown as Db;
      const row = await lockWithJobs(tx, id);
      if (!['suggested', 'planning', 'planned', 'failed'].includes(row.status)) throw new ConflictError('This change is already being built or is over.');
      await tx`
        UPDATE harness.jobs SET status = 'cancelled', finished_at = now(), error = 'change cancelled', lease_owner = NULL, lease_token = NULL, lease_until = NULL
        WHERE game_change_id = ${id} AND status IN ('queued', 'running')`;
      const [next] = await tx<Row[]>`
        UPDATE harness.game_changes SET status = ${row.status === 'suggested' ? 'declined' : 'cancelled'}, decided_by = ${by}, updated_at = now()
        WHERE id = ${id} RETURNING ${COLUMNS}`;
      await note(tx, `Change ${row.number} cancelled by ${by}`);
      return changeView(next!);
    });
  },
};
