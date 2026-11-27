import { randomBytes } from 'node:crypto';
import { config } from '../../core/config.js';
import { ConflictError, ExternalServiceError, ValidationError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import { sql } from '../../db/index.js';
import { GAMES } from './harness.games.js';
import { GAME_CHANGE_COLUMNS, changeView, lockWithJobs, note, type GameBuild, type GameChangePlan, type GameChangeRow } from './harness.game-changes.js';

// Building a planned change. A person presses "Build it" on a plan they have
// read; HQ starts the `hq-build-change` GitHub Actions workflow in each
// repository the plan touches. An agent writes the change there on top of
// staging and the run pushes the branch hq/change-<number>. HQ then opens the
// pull request into staging (so CI and review run on it as for anyone's pull
// request), shows the preview, and merges only when a person approves.
//
// HQ reaches GitHub with HQ_GITHUB_TOKEN. Without it nothing here runs and the
// page says building is not connected.

type Db = typeof sql;
type Row = GameChangeRow;

export type BuildRepo = 'web' | 'backend';
const REPOS: Record<BuildRepo, { slug: string; part: string }> = {
  web: { slug: 'Quizball-trivia/web', part: 'website' },
  backend: { slug: 'Quizball-trivia/quizball-backend', part: 'server' },
};
const WORKFLOW = 'hq-build-change.yml';
const BASE = 'staging';
/** No run showed up this long after it was asked for: GitHub never started it. */
const START_LIMIT_MS = 10 * 60_000;
/** Longer than the workflow's own time limits together. */
const RUN_LIMIT_MS = 100 * 60_000;

export const branchOf = (number: number) => `hq/change-${number}`;
export const buildingConnected = () => !!config.HQ_GITHUB_TOKEN;
const NOT_CONNECTED = 'Building is not connected yet: HQ has no access to GitHub. Until it is set up, a plan can be read but not built.';

// ── GitHub ─────────────────────────────────────────────────────────────────

export interface GithubReply {
  status: number;
  data: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}
/** One call to the GitHub REST API. Never throws on an HTTP status: the caller decides what each one means. */
export type Github = (method: 'GET' | 'POST' | 'PUT' | 'PATCH', path: string, body?: unknown) => Promise<GithubReply>;

const github: Github = async (method, path, body) => {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${config.HQ_GITHUB_TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'quizball-hq',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { message: text.slice(0, 200) };
  }
  return { status: res.status, data };
};

const ok = (r: GithubReply) => r.status >= 200 && r.status < 300;
const why = (r: GithubReply) => `GitHub answered ${r.status}${typeof r.data?.message === 'string' ? `: ${r.data.message.slice(0, 200)}` : ''}`;

// ── pure helpers ───────────────────────────────────────────────────────────

/** Pure: which repositories a plan touches, server first (the website may depend on it). */
export function reposForPlan(plan: GameChangePlan | null): BuildRepo[] {
  const areas = new Set((plan?.changes ?? []).map((c) => c.area));
  const out: BuildRepo[] = [];
  if (areas.has('server') || areas.has('both')) out.push('backend');
  if (areas.has('website') || areas.has('both')) out.push('web');
  return out;
}

/** Pure: what the workflow is started with. The plan travels as base64 so no character in it can break the run. */
export function dispatchInputs(row: Pick<Row, 'number' | 'title' | 'request' | 'game_key' | 'plan'>, buildId: string) {
  const game = GAMES.find((g) => g.key === row.game_key);
  const brief = { game: { key: row.game_key, name: game?.name ?? row.game_key, what: game?.what ?? '' }, request: row.request, plan: row.plan };
  return {
    change_number: String(row.number),
    build_id: buildId,
    // One line: it becomes the commit subject.
    title: row.title.replace(/\s+/g, ' ').trim(),
    brief_b64: Buffer.from(JSON.stringify(brief), 'utf8').toString('base64'),
  };
}

/** Pure: the pull request's description. */
export function prBody(row: Pick<Row, 'number' | 'request' | 'plan' | 'requested_by'>, repo: BuildRepo): string {
  const p = row.plan;
  const list = (items: string[]) => (items.length ? items.map((x) => `- ${x}`).join('\n') : '- (none)');
  return [
    `Asked in QuizBall HQ, change #${row.number}${row.requested_by ? ` (by ${row.requested_by})` : ''}. This is the ${REPOS[repo].part} part, written by an agent from the plan below. It is merged from HQ once a person has played it and approved.`,
    `## What was asked\n${row.request}`,
    `## The plan\n${p?.summary ?? ''}`,
    `## What changes\n${list((p?.changes ?? []).map((c) => `**${c.area}**: ${c.what}`))}`,
    `## What could go wrong\n${list(p?.risks ?? [])}`,
    `## How to check it by playing\n${list(p?.test ?? [])}`,
  ].join('\n\n');
}

/** Pure: the change's status from its parts. Waits while any part is still going. */
export function settle(builds: Record<string, GameBuild>): { status: 'building' | 'ready' | 'failed'; error: string | null } {
  const all = Object.entries(builds);
  if (all.some(([, b]) => b.state === 'starting' || b.state === 'running')) return { status: 'building', error: null };
  const failed = all.filter(([, b]) => b.state === 'failed');
  if (failed.length || all.length === 0) {
    return { status: 'failed', error: failed.map(([repo, b]) => `The ${REPOS[repo as BuildRepo]?.part ?? repo} part: ${b.error ?? 'failed'}`).join(' ') || 'Nothing was built.' };
  }
  return { status: 'ready', error: null };
}

// ── one part, one step forward ─────────────────────────────────────────────

interface StepContext {
  row: Row;
  repo: BuildRepo;
  now: number;
}

/** Why a finished run did not succeed, in a person's words: the step it stopped at. */
async function failureOf(gh: Github, slug: string, runId: number, conclusion: string): Promise<string> {
  if (conclusion === 'cancelled') return 'The build was cancelled.';
  if (conclusion === 'timed_out') return 'The build ran out of time.';
  const jobs = await gh('GET', `/repos/${slug}/actions/runs/${runId}/jobs?per_page=30`);
  const step = ok(jobs)
    ? (jobs.data?.jobs ?? []).flatMap((j: { steps?: Array<{ name: string; conclusion: string | null }> }) => j.steps ?? []).find((s: { conclusion: string | null }) => s.conclusion === 'failure')
    : null;
  return step ? `The build stopped at "${String(step.name).slice(0, 80)}".` : 'The build failed.';
}

/** The preview deployment of a commit, when its host (Vercel) reports one to GitHub. Null until there is one. */
async function previewOf(gh: Github, slug: string, sha: string): Promise<string | null> {
  const deployments = await gh('GET', `/repos/${slug}/deployments?sha=${sha}&per_page=10`);
  if (!ok(deployments) || !Array.isArray(deployments.data)) return null;
  for (const d of deployments.data as Array<{ id: number; environment?: string }>) {
    if (/prod/i.test(d.environment ?? '')) continue;
    const statuses = await gh('GET', `/repos/${slug}/deployments/${d.id}/statuses?per_page=5`);
    const done = ok(statuses) && Array.isArray(statuses.data) ? statuses.data.find((s: { state: string; environment_url?: string }) => s.state === 'success' && s.environment_url) : null;
    if (done && /^https:\/\//.test(done.environment_url)) return done.environment_url as string;
  }
  return null;
}

/**
 * Moves one part forward by asking GitHub where it is: finds its run, waits for it, then opens the pull request.
 * Returns the part as it now stands (the same object when nothing changed). A GitHub hiccup changes nothing: the
 * next round asks again.
 */
export async function advance(gh: Github, build: GameBuild, ctx: StepContext): Promise<GameBuild> {
  const { row, repo, now } = ctx;
  const slug = REPOS[repo].slug;
  const started = row.build_started_at ? new Date(row.build_started_at).getTime() : now;

  if (build.state === 'starting' || (build.state === 'running' && !build.runId)) {
    // The dispatch call returns nothing, so the run is found by the build id in its title.
    const since = new Date(started - 5 * 60_000).toISOString().slice(0, 19) + 'Z';
    const runs = await gh('GET', `/repos/${slug}/actions/workflows/${WORKFLOW}/runs?event=workflow_dispatch&per_page=50&created=${encodeURIComponent(`>=${since}`)}`);
    const run = ok(runs)
      ? (runs.data?.workflow_runs ?? []).find((r: { display_title?: string; name?: string }) => `${r.display_title ?? ''} ${r.name ?? ''}`.includes(`(${row.build_id})`))
      : null;
    if (run) return advance(gh, { ...build, state: 'running', runId: run.id, runUrl: run.html_url }, ctx);
    if (now - started > START_LIMIT_MS) return { ...build, state: 'failed', error: 'GitHub never started the build.' };
    return build;
  }

  if (build.state === 'running' && build.runId) {
    const run = await gh('GET', `/repos/${slug}/actions/runs/${build.runId}`);
    if (!ok(run)) return build;
    if (run.data.status !== 'completed') {
      return now - started > RUN_LIMIT_MS ? { ...build, state: 'failed', error: 'The build ran out of time.' } : build;
    }
    if (run.data.conclusion !== 'success') return { ...build, state: 'failed', error: await failureOf(gh, slug, build.runId, String(run.data.conclusion)) };

    // Built and checked: the branch is there. Open its pull request (or find the one a rebuild already has).
    const branch = branchOf(row.number);
    const ref = await gh('GET', `/repos/${slug}/git/ref/heads/${branch}`);
    if (!ok(ref)) return ref.status === 404 ? { ...build, state: 'failed', error: 'The build finished but pushed no branch.' } : build;
    const headSha = String(ref.data.object.sha);
    const owner = slug.split('/')[0];
    const open = await gh('GET', `/repos/${slug}/pulls?state=open&base=${BASE}&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=5`);
    if (!ok(open)) return build;
    let pr: { number: number; html_url: string; created_at?: string } | undefined = (open.data as Array<{ number: number; html_url: string; created_at?: string }>)[0];
    if (pr?.created_at && new Date(pr.created_at).getTime() < started) {
      // Left open by an earlier build. The run's own push starts no checks (GitHub's rule for its built-in token), so
      // close and reopen it as HQ: that does.
      const closed = await gh('PATCH', `/repos/${slug}/pulls/${pr.number}`, { state: 'closed' });
      const reopened = ok(closed) ? await gh('PATCH', `/repos/${slug}/pulls/${pr.number}`, { state: 'open' }) : closed;
      if (!ok(reopened)) return build;
    }
    if (!pr) {
      const created = await gh('POST', `/repos/${slug}/pulls`, { title: `HQ change ${row.number}: ${row.title.replace(/\s+/g, ' ').trim()}`, head: branch, base: BASE, body: prBody(row, repo) });
      if (ok(created)) pr = created.data;
      else if (created.status !== 422) return build;
      else {
        // 422 is also what a second HQ instance gets when the first one opened it a moment ago.
        const again = await gh('GET', `/repos/${slug}/pulls?state=open&base=${BASE}&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=5`);
        pr = ok(again) ? (again.data as Array<{ number: number; html_url: string; created_at?: string }>)[0] : undefined;
        if (!pr) return { ...build, state: 'failed', error: `The pull request could not be opened (${why(created)}).` };
      }
    }
    return { ...build, state: 'ready', headSha, prNumber: pr!.number, prUrl: pr!.html_url, builtAt: new Date(now).toISOString(), error: undefined };
  }

  // Ready: the website's preview appears a few minutes after the branch is pushed.
  if (build.state === 'ready' && repo === 'web' && !build.previewUrl && build.headSha) {
    const previewUrl = await previewOf(gh, slug, build.headSha);
    if (previewUrl) return { ...build, previewUrl };
  }
  return build;
}

// ── actions ────────────────────────────────────────────────────────────────

async function fresh(id: string): Promise<Row | undefined> {
  const [row] = await sql<Row[]>`SELECT ${GAME_CHANGE_COLUMNS} FROM harness.game_changes WHERE id = ${id}`;
  return row;
}

const MERGING = 'This change is being merged right now. Try again in a minute.';
const beingMerged = (row: Row) => !!row.approving_until && new Date(row.approving_until).getTime() > Date.now();

/** Pure: the newest run of each workflow. A reopened pull request keeps its older runs, and those no longer count. */
export function latestRuns<T extends { workflow_id?: number; run_number?: number; created_at?: string }>(runs: T[]): T[] {
  const newest = new Map<number | undefined, T>();
  const age = (r: T) => `${r.created_at ?? ''}#${String(r.run_number ?? 0).padStart(9, '0')}`;
  for (const r of runs) {
    const have = newest.get(r.workflow_id);
    if (!have || age(r) > age(have)) newest.set(r.workflow_id, r);
  }
  return [...newest.values()];
}

export const gameBuilds = {
  /** A person read the plan and wants it built (or built again after a failure). */
  async build(id: string, by: string, gh: Github = github) {
    if (!buildingConnected()) throw new ConflictError(NOT_CONNECTED);
    const buildId = randomBytes(6).toString('hex');
    const started = await sql.begin(async (t) => {
      const tx = t as unknown as Db;
      const row = await lockWithJobs(tx, id);
      if (!['planned', 'failed', 'ready'].includes(row.status) || !row.plan) throw new ConflictError('Only a change with a plan can be built.');
      if (beingMerged(row)) throw new ConflictError(MERGING);
      if (Object.values(row.builds ?? {}).some((b) => b.mergedAt)) throw new ConflictError('Part of this change is already merged. Approve it again to finish the rest.');
      const repos = reposForPlan(row.plan);
      if (!repos.length) throw new ValidationError('The plan names nothing to change, so there is nothing to build. Rewrite the request to plan it again.');
      const builds = Object.fromEntries(repos.map((r) => [r, { state: 'starting' } satisfies GameBuild]));
      const [next] = await tx<Row[]>`
        UPDATE harness.game_changes
           SET status = 'building', build_id = ${buildId}, build_started_at = now(), builds = ${sql.json(builds)}, error = NULL, decided_by = NULL, updated_at = now()
         WHERE id = ${id} RETURNING ${GAME_CHANGE_COLUMNS}`;
      await note(tx, `Change ${row.number}: ${by} started the build (${repos.map((r) => REPOS[r].part).join(' and ')})`);
      return { row: next!, repos };
    });

    // Outside the transaction: GitHub is slow compared with a row lock.
    const refused: Record<string, string> = {};
    for (const repo of started.repos) {
      try {
        const res = await gh('POST', `/repos/${REPOS[repo].slug}/actions/workflows/${WORKFLOW}/dispatches`, { ref: 'main', inputs: dispatchInputs(started.row, buildId) });
        if (res.status === 404) refused[repo] = 'The build could not be started: the build workflow is not in the repository yet, or HQ may not start it.';
        else if (!ok(res)) refused[repo] = `The build could not be started (${why(res)}).`;
      } catch (err) {
        logger.warn({ err, repo }, 'Game change build dispatch failed');
        refused[repo] = 'The build could not be started: GitHub did not answer.';
      }
    }
    if (!Object.keys(refused).length) return changeView(started.row);
    // A part that did start keeps running and stays followed; the change fails once every part has ended.
    const builds: Record<string, GameBuild> = Object.fromEntries(started.repos.map((r) => [r, refused[r] ? { state: 'failed', error: refused[r] } : { state: 'starting' }]));
    const outcome = settle(builds);
    const [saved] = await sql<Row[]>`
      UPDATE harness.game_changes SET builds = ${sql.json(builds as never)}, status = ${outcome.status}, error = ${outcome.error}, updated_at = now()
       WHERE id = ${id} AND build_id = ${buildId} AND status = 'building' RETURNING ${GAME_CHANGE_COLUMNS}`;
    return changeView(saved ?? (await fresh(id)) ?? started.row);
  },

  /** Asks GitHub about every change being built and saves what moved. Safe to run at any time, from any instance. */
  async sync(gh: Github = github, now: number = Date.now()): Promise<number> {
    if (!buildingConnected()) return 0;
    // Builds in progress first; then built websites still waiting for their preview (it appears within minutes).
    const rows = await sql<Row[]>`
      (SELECT ${GAME_CHANGE_COLUMNS} FROM harness.game_changes WHERE status = 'building' ORDER BY updated_at LIMIT 20)
      UNION ALL
      (SELECT ${GAME_CHANGE_COLUMNS} FROM harness.game_changes
        WHERE status = 'ready' AND updated_at > now() - interval '2 hours'
          AND builds->'web'->>'state' = 'ready' AND builds->'web'->>'previewUrl' IS NULL AND builds->'web'->>'mergedAt' IS NULL
        ORDER BY updated_at LIMIT 10)`;
    let moved = 0;
    for (const row of rows) {
      const next: Record<string, GameBuild> = {};
      let changed = false;
      for (const [repo, build] of Object.entries(row.builds ?? {})) {
        if (!(repo in REPOS)) continue;
        try {
          next[repo] = await advance(gh, build, { row, repo: repo as BuildRepo, now });
        } catch (err) {
          logger.warn({ err, change: row.number, repo }, 'Game change build check skipped');
          next[repo] = build;
        }
        if (next[repo] !== build) changed = true;
      }
      const outcome = settle(next);
      if (!changed && outcome.status === row.status) continue;
      // Only if this is still the same build in the same state: a rebuild, a merge or a cancel in between wins.
      const saved = await sql`
        UPDATE harness.game_changes
           SET builds = ${sql.json(next as never)}, status = ${outcome.status}, error = ${outcome.error}, updated_at = now()
         WHERE id = ${row.id} AND build_id = ${row.build_id ?? null} AND status = ${row.status} AND builds = ${sql.json((row.builds ?? {}) as never)}
         RETURNING id`;
      if (saved.length) {
        moved += 1;
        if (outcome.status !== row.status) {
          await sql`INSERT INTO harness.events (type, level, message) VALUES ('game_change', ${outcome.status === 'failed' ? 'warn' : 'info'},
            ${(outcome.status === 'ready' ? `Change ${row.number} is built and ready to play` : `Change ${row.number}: the build failed. ${outcome.error ?? ''}`).slice(0, 1000)})`;
        }
      }
    }
    return moved;
  },

  /**
   * A person played it and approves: merge the pull request(s) into staging. `seen` is the commit of each part as the
   * page showed it; a part whose code changed since is not merged.
   */
  async merge(id: string, seen: Record<string, string>, by: string, gh: Github = github) {
    if (!buildingConnected()) throw new ConflictError(NOT_CONNECTED);
    // Reserve the change first: until this approval has saved its outcome, nobody can rebuild, drop or approve it.
    // The reservation runs out by itself, so a crash in the middle cannot lock the change for good.
    const row = await sql.begin(async (t) => {
      const tx = t as unknown as Db;
      const current = await lockWithJobs(tx, id);
      if (current.status !== 'ready') throw new ConflictError('This change is not waiting for approval.');
      if (beingMerged(current)) throw new ConflictError(MERGING);
      for (const [repo, b] of Object.entries(current.builds ?? {})) {
        if (!b.mergedAt && (!b.headSha || seen[repo] !== b.headSha)) throw new ConflictError('The code changed since you looked. Reload, look again, then approve.');
      }
      const [held] = await tx<Row[]>`UPDATE harness.game_changes SET approving_until = now() + interval '3 minutes' WHERE id = ${id} RETURNING ${GAME_CHANGE_COLUMNS}`;
      return held!;
    });
    const builds: Record<string, GameBuild> = { ...(row.builds ?? {}) };
    const repos = (['backend', 'web'] as const).filter((r) => builds[r]);

    // No transaction is held while GitHub is asked: it can take longer than a transaction may sit idle. Two approvals
    // at once are safe without one: GitHub merges a pull request once, and only at the commit named here.
    let failure: string | null = null;
    for (const repo of repos) {
      const b = builds[repo]!;
      if (b.mergedAt) continue;
      const slug = REPOS[repo].slug;
      const part = REPOS[repo].part;
      try {
        const pr = await gh('GET', `/repos/${slug}/pulls/${b.prNumber}`);
        if (!ok(pr)) failure = `The ${part} pull request could not be read (${why(pr)}).`;
        else if (pr.data.merged) builds[repo] = { ...b, mergedAt: new Date().toISOString() };
        else if (pr.data.state !== 'open') failure = `The ${part} pull request was closed on GitHub.`;
        else if (pr.data.base?.ref !== BASE) failure = `The ${part} pull request no longer goes into ${BASE}. Build it again.`;
        else if (pr.data.head?.sha !== b.headSha) failure = `The ${part} code changed on GitHub since it was built. Build it again.`;
        else {
          // CI runs on the pull request like on anyone's: merge only over a finished, green run. None yet is not green.
          const runs = await gh('GET', `/repos/${slug}/actions/runs?head_sha=${b.headSha}&event=pull_request&per_page=30`);
          type CiRun = { status: string; conclusion: string | null; workflow_id?: number; run_number?: number; created_at?: string };
          const ci: CiRun[] = ok(runs) ? latestRuns<CiRun>(runs.data?.workflow_runs ?? []) : [];
          if (!ok(runs)) failure = `The ${part} checks could not be read (${why(runs)}).`;
          else if (ci.length === 0) failure = `The ${part} checks have not started on GitHub yet. Try again in a few minutes.`;
          else if (ci.some((r) => r.status !== 'completed')) failure = `The ${part} checks are still running on GitHub. Try again in a few minutes.`;
          else if (ci.some((r) => !['success', 'skipped', 'neutral'].includes(r.conclusion ?? ''))) failure = `The ${part} checks failed on GitHub. Build it again or fix the pull request.`;
          else {
            const merged = await gh('PUT', `/repos/${slug}/pulls/${b.prNumber}/merge`, { merge_method: 'squash', sha: b.headSha });
            if (ok(merged)) builds[repo] = { ...b, mergedAt: new Date().toISOString() };
            else failure = `The ${part} pull request could not be merged (${why(merged)}).`;
          }
        }
      } catch (err) {
        logger.warn({ err, change: row.number, repo }, 'Game change merge call failed');
        failure = `GitHub did not answer while merging the ${part} part.`;
      }
      if (failure) break;
    }

    const result = await sql.begin(async (t) => {
      const tx = t as unknown as Db;
      const current = await lockWithJobs(tx, id);
      // Only if the reservation ran out under a very slow GitHub and someone moved the change on: what is saved stands.
      if (current.status !== 'ready' || current.build_id !== row.build_id) return { row: current, failure: current.status === 'merged' ? null : (failure ?? 'This change is no longer waiting for approval.') };
      // What did merge is saved even when a later part failed, so approving again only does the rest.
      const kept: Record<string, GameBuild> = { ...(current.builds ?? {}) };
      for (const repo of repos) if (builds[repo]!.mergedAt && kept[repo] && !kept[repo]!.mergedAt) kept[repo] = { ...kept[repo]!, mergedAt: builds[repo]!.mergedAt };
      const done = !failure && Object.keys(kept).length > 0 && Object.values(kept).every((b) => b.mergedAt);
      const [next] = await tx<Row[]>`
        UPDATE harness.game_changes
           SET builds = ${sql.json(kept as never)}, status = ${done ? 'merged' : 'ready'}, decided_by = ${done ? by : current.decided_by}, error = ${failure}, approving_until = NULL, updated_at = now()
         WHERE id = ${id} RETURNING ${GAME_CHANGE_COLUMNS}`;
      if (done) await note(tx, `Change ${current.number} approved by ${by} and merged into staging`);
      return { row: next!, failure };
    });
    if (result.failure) throw new ExternalServiceError(result.failure);
    return changeView(result.row);
  },

  /** A person does not want what was built (or is being built): the change ends, its run stops, its pull request closes. */
  async discard(id: string, by: string, gh: Github = github) {
    const row = await sql.begin(async (t) => {
      const tx = t as unknown as Db;
      const current = await lockWithJobs(tx, id);
      if (!['building', 'ready'].includes(current.status)) throw new ConflictError('This change is not being built.');
      if (beingMerged(current)) throw new ConflictError(MERGING);
      if (Object.values(current.builds ?? {}).some((b) => b.mergedAt)) throw new ConflictError('Part of this change is already merged. Approve it again to finish.');
      const [next] = await tx<Row[]>`
        UPDATE harness.game_changes SET status = 'cancelled', decided_by = ${by}, updated_at = now() WHERE id = ${id} RETURNING ${GAME_CHANGE_COLUMNS}`;
      await note(tx, `Change ${current.number}: ${by} dropped what was built`);
      return next!;
    });
    // Tidying up on GitHub is best effort: the change is over either way.
    if (buildingConnected()) {
      for (const [repo, b] of Object.entries(row.builds ?? {})) {
        const slug = REPOS[repo as BuildRepo]?.slug;
        if (!slug) continue;
        try {
          if (b.runId && b.state !== 'ready' && b.state !== 'failed') await gh('POST', `/repos/${slug}/actions/runs/${b.runId}/cancel`);
          if (b.prNumber) await gh('PATCH', `/repos/${slug}/pulls/${b.prNumber}`, { state: 'closed' });
        } catch (err) {
          logger.warn({ err, change: row.number, repo }, 'Could not tidy up a dropped game change on GitHub');
        }
      }
    }
    return changeView(row);
  },
};

// ── background loop ────────────────────────────────────────────────────────

const TICK_MS = 45_000;
let timer: ReturnType<typeof setInterval> | undefined;
let running = false;

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await gameBuilds.sync();
  } catch (err) {
    logger.warn({ err }, 'Game build sync skipped');
  } finally {
    running = false;
  }
}

/** Follows the builds on GitHub. Production only (HQ lives there), and only when HQ is connected to GitHub. */
export function startGameBuildLoop(): void {
  if (timer || config.NODE_ENV !== 'prod' || !buildingConnected()) return;
  timer = setInterval(() => void tick(), TICK_MS);
  timer.unref();
}

export function stopGameBuildLoop(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
