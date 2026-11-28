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
/** How often the builds are looked at. */
const TICK_MS = 45_000;
/** How many built websites are asked for their preview in one round. */
const PREVIEW_ROUND = 10;
/** Whose turn it is among the websites waiting for a preview: one step per sync that ran, not per tick of the clock (a slow sync skips ticks, and would then keep landing on the same rows). */
let previewTurn = 0;

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

/** Pure: whether this is still the build that was started. A rebuild or a drop in between ends it. */
export function stillBuilding(row: Pick<Row, 'build_id' | 'status'> | undefined, buildId: string): boolean {
  return !!row && row.build_id === buildId && row.status === 'building';
}

/**
 * Pure: the rows whose turn it is, `size` at a time. Each round starts where the last one stopped, so rows that keep
 * having nothing new (a website with no preview yet) cannot keep the ones behind them from ever being looked at.
 */
export function takeTurn<T>(rows: T[], size: number, turn: number): T[] {
  if (rows.length <= size) return rows;
  const start = (Math.max(0, Math.floor(turn)) * size) % rows.length;
  return Array.from({ length: size }, (_, i) => rows[(start + i) % rows.length]!);
}

/** A pull request as GitHub shows it: only what HQ judges it by. */
export interface Pull {
  state?: string;
  merged?: boolean;
  base?: { ref?: string };
  head?: { sha?: string };
}

/**
 * Pure: why a pull request, as GitHub shows it now, is not the one that was built and approved. Null when it is.
 * A merged pull request is judged like an open one: merged by someone else into another branch, or with other code,
 * is not "merged into staging".
 */
export function pullProblem(pull: Pull | null | undefined, headSha: string | undefined, part: string): string | null {
  const merged = !!pull?.merged;
  if (!merged && pull?.state !== 'open') return `The ${part} pull request was closed on GitHub.`;
  if (pull?.base?.ref !== BASE) {
    return merged
      ? `The ${part} pull request was merged on GitHub into "${String(pull?.base?.ref ?? 'another branch').slice(0, 80)}", not into ${BASE}. HQ cannot undo that: someone has to look at it on GitHub.`
      : `The ${part} pull request no longer goes into ${BASE}. Build it again.`;
  }
  if (!headSha || pull?.head?.sha !== headSha) {
    return merged
      ? `The ${part} pull request was merged on GitHub with code other than what was built and approved here. Someone has to look at it on GitHub.`
      : `The ${part} code changed on GitHub since it was built. Build it again.`;
  }
  return null;
}

/**
 * Pure: a part once GitHub has shown its pull request. Whatever an earlier merge left unknown is known now, and the
 * part counts as merged only when the approved code went into staging.
 */
export function mergeKnown(build: GameBuild, pull: Pull | null | undefined, at: string): GameBuild {
  const { mergeUnsure: _known, ...rest } = build;
  return pull?.merged && !rest.mergedAt && pullProblem(pull, build.headSha, '') === null ? { ...rest, mergedAt: at } : rest;
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

/** A build's run, found by the build id in its title (starting a run returns nothing). Null: none yet. Undefined: GitHub could not be asked. */
async function findRun(gh: Github, slug: string, buildId: string | null | undefined, started: number): Promise<{ id: number; html_url: string; status?: string } | null | undefined> {
  const since = new Date(started - 5 * 60_000).toISOString().slice(0, 19) + 'Z';
  const runs = await gh('GET', `/repos/${slug}/actions/workflows/${WORKFLOW}/runs?event=workflow_dispatch&per_page=50&created=${encodeURIComponent(`>=${since}`)}`);
  if (!ok(runs)) return undefined;
  return (runs.data?.workflow_runs ?? []).find((r: { display_title?: string; name?: string }) => `${r.display_title ?? ''} ${r.name ?? ''}`.includes(`(${buildId})`)) ?? null;
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
    const found = await findRun(gh, slug, row.build_id, started);
    // GitHub not answering says nothing about the run: ask again next round.
    if (found === undefined) return build;
    if (found) return advance(gh, { ...build, state: 'running', runId: found.id, runUrl: found.html_url }, ctx);
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

/**
 * Stops what a dropped change still has on GitHub: a run that is going, and any pull request open from its branch.
 * It asks GitHub what is there instead of trusting what HQ had saved, because a run or a pull request can appear
 * after the change was dropped (HQ was in the middle of asking for it). Safe to repeat; a GitHub hiccup is skipped.
 */
export async function tidy(gh: Github, row: Pick<Row, 'number' | 'build_id' | 'build_started_at' | 'builds'>, now: number = Date.now()): Promise<void> {
  const started = row.build_started_at ? new Date(row.build_started_at).getTime() : now;
  for (const [repo, b] of Object.entries(row.builds ?? {})) {
    const slug = REPOS[repo as BuildRepo]?.slug;
    if (!slug) continue;
    try {
      if (b.state === 'starting' || b.state === 'running') {
        // A run that was asked for seconds ago may not have been seen yet: look for it before giving up on stopping it.
        const run = await findRun(gh, slug, row.build_id, started);
        const runId = run?.id ?? b.runId;
        if (runId && run?.status !== 'completed') await gh('POST', `/repos/${slug}/actions/runs/${runId}/cancel`);
      }
      // The branch belongs to this change alone, so every pull request open from it is this change's.
      const open = await gh('GET', `/repos/${slug}/pulls?state=open&head=${encodeURIComponent(`${slug.split('/')[0]}:${branchOf(row.number)}`)}&per_page=5`);
      const numbers: number[] = ok(open) && Array.isArray(open.data) ? open.data.map((p: { number: number }) => p.number) : b.prNumber ? [b.prNumber] : [];
      for (const number of numbers) await gh('PATCH', `/repos/${slug}/pulls/${number}`, { state: 'closed' });
    } catch (err) {
      logger.warn({ err, change: row.number, repo }, 'Could not tidy up a dropped game change on GitHub');
    }
  }
}

const UNSURE = (part: string) => `GitHub was asked to merge the ${part} part, and HQ could not find out whether it did. Approve again: HQ asks GitHub first and only merges what is not merged yet.`;

/**
 * Merges one part's pull request into staging, or says why not. Returns the part as it now stands. Never throws.
 *
 * GitHub's merge call cannot be told which branch it must merge into: it merges into whatever the pull request
 * points at in that instant. So the pull request is read again right before the call, and read once more right
 * after it to see where it landed. What is left is the instant between that last look and the merge itself: someone
 * who points the pull request elsewhere exactly then gets it merged there. HQ cannot prevent or undo that; it
 * notices (`misplaced`), does not count the part as merged, and tells a person.
 */
export async function mergePart(gh: Github, b: GameBuild, repo: BuildRepo, at: () => string = () => new Date().toISOString()): Promise<{ build: GameBuild; failure: string | null; misplaced?: boolean }> {
  const { slug, part } = REPOS[repo];
  const path = `/repos/${slug}/pulls/${b.prNumber}`;
  let build = b;
  // From the moment GitHub is asked to merge until it has shown the pull request again, HQ does not know the outcome.
  let asked = false;
  /** Reads the pull request and judges it. `stop` is set when there is nothing left to do for this part. */
  const look = async (): Promise<{ stop: boolean; failure: string | null; misplaced?: boolean; merged?: boolean }> => {
    const pr = await gh('GET', path);
    if (!ok(pr)) return { stop: true, failure: `The ${part} pull request could not be read (${why(pr)}).` };
    asked = false;
    build = mergeKnown(build, pr.data, at());
    const problem = pullProblem(pr.data, b.headSha, part);
    return { stop: !!problem || !!pr.data?.merged, failure: problem, misplaced: !!problem && !!pr.data?.merged, merged: !!pr.data?.merged };
  };
  try {
    const first = await look();
    if (first.stop) return { build, failure: first.failure, misplaced: first.misplaced };

    // CI runs on the pull request like on anyone's: merge only over a finished, green run. None yet is not green.
    const runs = await gh('GET', `/repos/${slug}/actions/runs?head_sha=${b.headSha}&event=pull_request&per_page=30`);
    type CiRun = { status: string; conclusion: string | null; workflow_id?: number; run_number?: number; created_at?: string };
    if (!ok(runs)) return { build, failure: `The ${part} checks could not be read (${why(runs)}).` };
    const ci = latestRuns<CiRun>(runs.data?.workflow_runs ?? []);
    if (ci.length === 0) return { build, failure: `The ${part} checks have not started on GitHub yet. Try again in a few minutes.` };
    if (ci.some((r) => r.status !== 'completed')) return { build, failure: `The ${part} checks are still running on GitHub. Try again in a few minutes.` };
    if (ci.some((r) => !['success', 'skipped', 'neutral'].includes(r.conclusion ?? ''))) return { build, failure: `The ${part} checks failed on GitHub. Build it again or fix the pull request.` };

    // Reading the checks took time: look once more, so the merge is asked for right after seeing it still goes into staging.
    const again = await look();
    if (again.stop) return { build, failure: again.failure, misplaced: again.misplaced };

    asked = true;
    const merged = await gh('PUT', `${path}/merge`, { merge_method: 'squash', sha: b.headSha });
    // A plain no (not mergeable, the commit moved, not allowed) is an answer. A server error is not: it may have merged.
    if (!ok(merged) && merged.status < 500) {
      asked = false;
      return { build, failure: `The ${part} pull request could not be merged (${why(merged)}).` };
    }
    const after = await look();
    if (after.failure) return { build: asked ? { ...build, mergeUnsure: true } : build, failure: asked ? UNSURE(part) : after.failure, misplaced: after.misplaced };
    if (after.merged) return { build, failure: null };
    // GitHub said it merged and still shows the pull request open: believe neither until it agrees with itself.
    return ok(merged) ? { build: { ...build, mergeUnsure: true }, failure: UNSURE(part) } : { build, failure: `The ${part} pull request could not be merged (${why(merged)}).` };
  } catch (err) {
    logger.warn({ err, repo, pullRequest: b.prNumber }, 'Game change merge call failed');
    return asked ? { build: { ...build, mergeUnsure: true }, failure: UNSURE(part) } : { build, failure: `GitHub did not answer while merging the ${part} part.` };
  }
}

// ── actions ────────────────────────────────────────────────────────────────

async function fresh(id: string): Promise<Row | undefined> {
  const [row] = await sql<Row[]>`SELECT ${GAME_CHANGE_COLUMNS} FROM harness.game_changes WHERE id = ${id}`;
  return row;
}

const MERGING = 'This change is being merged right now. Try again in a minute.';
const beingMerged = (row: Row) => !!row.approving_until && new Date(row.approving_until).getTime() > Date.now();
const MERGE_UNKNOWN = 'GitHub was asked to merge part of this change and HQ does not know whether it did. GitHub could not be asked just now: try again in a minute.';
const mergeUnknown = (row: Row) => Object.values(row.builds ?? {}).some((b) => b.mergeUnsure);

/** Something happened on GitHub that HQ cannot put right: it goes where a person will see it. */
async function alarm(db: Db, change: number, message: string): Promise<void> {
  logger.error({ change }, message);
  await db`INSERT INTO harness.events (type, level, message) VALUES ('game_change', 'error', ${`Change ${change}: ${message}`.slice(0, 1000)})`;
}

/**
 * Before a change is rebuilt or dropped: if an approval asked GitHub to merge a part and never learned the outcome,
 * ask GitHub now and save what it says. A part it did merge is then recorded as merged (and the change can only be
 * finished by approving); a part it did not merge is free again. If GitHub cannot answer, the part stays unknown and
 * the caller refuses.
 */
async function settleUnsureMerges(id: string, gh: Github): Promise<void> {
  const row = await fresh(id);
  if (!row || beingMerged(row) || !mergeUnknown(row) || !buildingConnected()) return;
  const next: Record<string, GameBuild> = { ...(row.builds ?? {}) };
  for (const [repo, b] of Object.entries(row.builds ?? {})) {
    const known = REPOS[repo as BuildRepo];
    if (!b.mergeUnsure || !known) continue;
    try {
      const pr = await gh('GET', `/repos/${known.slug}/pulls/${b.prNumber}`);
      if (!ok(pr)) continue;
      next[repo] = mergeKnown(b, pr.data, new Date().toISOString());
      const problem = pr.data?.merged ? pullProblem(pr.data, b.headSha, known.part) : null;
      if (problem) await alarm(sql, row.number, problem);
    } catch (err) {
      logger.warn({ err, change: row.number, repo }, 'Could not ask GitHub about an unfinished merge');
    }
  }
  // Only if nothing at all happened to the change meanwhile; otherwise the next attempt asks again. Comparing the
  // builds alone is not enough: an approval that ran in between and again ended without an answer leaves them
  // looking the same, and what GitHub said before that approval is then out of date. Every save moves updated_at
  // (compared to the millisecond, which is all a date read from the database keeps).
  await sql`
    UPDATE harness.game_changes SET builds = ${sql.json(next as never)}, updated_at = now()
     WHERE id = ${id} AND build_id = ${row.build_id ?? null} AND status = ${row.status} AND builds = ${sql.json((row.builds ?? {}) as never)}
       AND date_trunc('milliseconds', updated_at) = date_trunc('milliseconds', ${new Date(row.updated_at)}::timestamptz)
       AND (approving_until IS NULL OR approving_until < now())`;
}

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
    await settleUnsureMerges(id, gh);
    const started = await sql.begin(async (t) => {
      const tx = t as unknown as Db;
      const row = await lockWithJobs(tx, id);
      if (!['planned', 'failed', 'ready'].includes(row.status) || !row.plan) throw new ConflictError('Only a change with a plan can be built.');
      if (beingMerged(row)) throw new ConflictError(MERGING);
      if (Object.values(row.builds ?? {}).some((b) => b.mergedAt)) throw new ConflictError('Part of this change is already merged. Approve it again to finish the rest.');
      if (mergeUnknown(row)) throw new ConflictError(MERGE_UNKNOWN);
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
      // Dropped while the parts were being started: start nothing more. A start that was already on its way to GitHub
      // is found and stopped by the sync, which keeps tidying a dropped change for a while.
      const current = await fresh(id);
      if (!stillBuilding(current, buildId)) return changeView(current ?? started.row);
      try {
        const res = await gh('POST', `/repos/${REPOS[repo].slug}/actions/workflows/${WORKFLOW}/dispatches`, { ref: 'main', inputs: dispatchInputs(started.row, buildId) });
        if (res.status === 404) refused[repo] = 'The build could not be started: the build workflow is not in the repository yet, or HQ may not start it.';
        else if (!ok(res)) refused[repo] = `The build could not be started (${why(res)}).`;
      } catch (err) {
        // No answer is not a no: GitHub may have started it. The part stays "starting" and the run is looked for;
        // if none ever appears, it fails by itself after a few minutes.
        logger.warn({ err, repo }, 'Game change build dispatch got no answer');
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
    // A change dropped in the last minutes: a run or a pull request HQ was asking for at that moment can still appear
    // on GitHub after the drop, owned by nobody. Keep stopping what is there until nothing more can arrive. A dropped
    // change is over for good (it cannot be built again), so nothing found here belongs to a later build.
    const dropped = await sql<Row[]>`
      SELECT ${GAME_CHANGE_COLUMNS} FROM harness.game_changes
       WHERE status = 'cancelled' AND build_id IS NOT NULL AND updated_at > now() - interval '15 minutes'
       ORDER BY updated_at DESC LIMIT 10`;
    for (const row of dropped) await tidy(gh, row, now);

    // Builds in progress first; then built websites still waiting for their preview (it appears within minutes).
    const building = await sql<Row[]>`SELECT ${GAME_CHANGE_COLUMNS} FROM harness.game_changes WHERE status = 'building' ORDER BY updated_at LIMIT 20`;
    // A website without a preview does not change, so "the oldest ten" would be the same ten every round: take turns.
    const waiting = await sql<Row[]>`
      SELECT ${GAME_CHANGE_COLUMNS} FROM harness.game_changes
       WHERE status = 'ready' AND updated_at > now() - interval '2 hours'
         AND builds->'web'->>'state' = 'ready' AND builds->'web'->>'previewUrl' IS NULL AND builds->'web'->>'mergedAt' IS NULL
       ORDER BY number LIMIT 200`;
    const rows = [...building, ...takeTurn(waiting, PREVIEW_ROUND, previewTurn++)];
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
      const [held] = await tx<Row[]>`UPDATE harness.game_changes SET approving_until = now() + interval '5 minutes' WHERE id = ${id} RETURNING ${GAME_CHANGE_COLUMNS}`;
      return held!;
    });
    const builds: Record<string, GameBuild> = { ...(row.builds ?? {}) };
    const repos = (['backend', 'web'] as const).filter((r) => builds[r]);

    // No transaction is held while GitHub is asked: it can take longer than a transaction may sit idle. Two approvals
    // at once are safe without one: GitHub merges a pull request once, and only at the commit named here.
    let failure: string | null = null;
    const misplaced: string[] = [];
    for (const repo of repos) {
      if (builds[repo]!.mergedAt) continue;
      const done = await mergePart(gh, builds[repo]!, repo);
      builds[repo] = done.build;
      failure = done.failure;
      if (done.misplaced && failure) misplaced.push(failure);
      if (failure) break;
    }
    for (const message of misplaced) await alarm(sql, row.number, message).catch((err) => logger.error({ err, change: row.number }, message));

    const result = await sql.begin(async (t) => {
      const tx = t as unknown as Db;
      const current = await lockWithJobs(tx, id);
      // Only if the reservation ran out under a very slow GitHub and someone moved the change on: what is saved stands.
      if (current.status !== 'ready' || current.build_id !== row.build_id) return { row: current, failure: current.status === 'merged' ? null : (failure ?? 'This change is no longer waiting for approval.') };
      // What did merge is saved even when a later part failed, so approving again only does the rest.
      const kept: Record<string, GameBuild> = { ...(current.builds ?? {}) };
      // So is a merge whose outcome is unknown: it keeps the change from being rebuilt or dropped until GitHub is asked.
      for (const repo of repos) {
        if (!kept[repo] || kept[repo]!.mergedAt) continue;
        const { mergeUnsure: _before, ...rest } = kept[repo]!;
        kept[repo] = { ...rest, ...(builds[repo]!.mergedAt ? { mergedAt: builds[repo]!.mergedAt } : {}), ...(builds[repo]!.mergeUnsure ? { mergeUnsure: true } : {}) };
      }
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
    await settleUnsureMerges(id, gh);
    const row = await sql.begin(async (t) => {
      const tx = t as unknown as Db;
      const current = await lockWithJobs(tx, id);
      if (!['building', 'ready'].includes(current.status)) throw new ConflictError('This change is not being built.');
      if (beingMerged(current)) throw new ConflictError(MERGING);
      if (Object.values(current.builds ?? {}).some((b) => b.mergedAt)) throw new ConflictError('Part of this change is already merged. Approve it again to finish.');
      if (mergeUnknown(current)) throw new ConflictError(MERGE_UNKNOWN);
      const [next] = await tx<Row[]>`
        UPDATE harness.game_changes SET status = 'cancelled', decided_by = ${by}, updated_at = now() WHERE id = ${id} RETURNING ${GAME_CHANGE_COLUMNS}`;
      await note(tx, `Change ${current.number}: ${by} dropped what was built`);
      return next!;
    });
    // Tidying up on GitHub here is best effort: the change is over either way, and the sync repeats it for a while.
    if (buildingConnected()) await tidy(gh, row);
    return changeView(row);
  },
};

// ── background loop ────────────────────────────────────────────────────────

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
