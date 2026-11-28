import { describe, expect, it } from 'vitest';
import '../setup.js';

const { advance, branchOf, dispatchInputs, latestRuns, mergeKnown, mergePart, prBody, pullProblem, reposForPlan, settle, stillBuilding, takeTurn, tidy } = await import('../../src/modules/harness/harness.game-builds.js');
const { buildsView, changeView } = await import('../../src/modules/harness/harness.game-changes.js');
const { mergeGameChangeBodySchema } = await import('../../src/modules/harness/harness.schemas.js');
type Github = import('../../src/modules/harness/harness.game-builds.js').Github;
type GameBuild = import('../../src/modules/harness/harness.game-changes.js').GameBuild;

const plan = { summary: 'Four lives in the daily game.', size: 'small' as const, changes: [{ area: 'server' as const, what: 'Lives go from 3 to 4.' }, { area: 'website' as const, what: 'The counter shows four.' }], risks: ['Scores rise.'], test: ['Give four wrong answers.'], questions: [] };
const T0 = Date.parse('2026-11-27T10:00:00Z');
const row = {
  id: 'c1', number: 12, game_key: 'tenable', title: 'Four  lives\ninstead of three', request: 'Give players four lives; keep "three" in rooms $(x).', source: 'person' as const, requested_by: 'Nika',
  status: 'building' as const, plan, error: null, decided_by: null, build_id: 'abcdef012345', build_started_at: new Date(T0).toISOString(), builds: {}, created_at: new Date(T0), updated_at: new Date(T0),
};
const SHA = 'a'.repeat(40);

/** A fake GitHub: answers by the first matching rule, and remembers what it was asked. */
function fake(rules: Array<[RegExp, { status: number; data?: unknown }]>) {
  const calls: string[] = [];
  const gh: Github = async (method, path) => {
    calls.push(`${method} ${path}`);
    const hit = rules.find(([re]) => re.test(`${method} ${path}`));
    return hit ? { status: hit[1].status, data: hit[1].data ?? null } : { status: 404, data: { message: 'Not Found' } };
  };
  return { gh, calls };
}
const ctx = (repo: 'web' | 'backend', now = T0 + 60_000) => ({ row, repo, now });

describe('building a game change', () => {
  it('builds the parts the plan names, server first', () => {
    expect(reposForPlan(plan)).toEqual(['backend', 'web']);
    expect(reposForPlan({ ...plan, changes: [{ area: 'both', what: 'x' }] })).toEqual(['backend', 'web']);
    expect(reposForPlan({ ...plan, changes: [{ area: 'website', what: 'x' }] })).toEqual(['web']);
    expect(reposForPlan({ ...plan, changes: [] })).toEqual([]);
    expect(reposForPlan(null)).toEqual([]);
  });

  it('sends the plan to the workflow as base64, with a one-line title', () => {
    const inputs = dispatchInputs(row, 'abcdef012345');
    expect(inputs).toMatchObject({ change_number: '12', build_id: 'abcdef012345', title: 'Four lives instead of three' });
    const brief = JSON.parse(Buffer.from(inputs.brief_b64, 'base64').toString('utf8'));
    expect(brief.request).toBe(row.request);
    expect(brief.game).toMatchObject({ key: 'tenable', name: 'Football Tenable' });
    expect(brief.plan.changes).toHaveLength(2);
    expect(branchOf(12)).toBe('hq/change-12');
  });

  it('writes a pull request description a reviewer can read', () => {
    const body = prBody(row, 'web');
    expect(body).toContain('change #12 (by Nika)');
    expect(body).toContain('website part');
    expect(body).toContain('- **server**: Lives go from 3 to 4.');
    expect(body).toContain('- Give four wrong answers.');
  });

  it('settles the change from its parts', () => {
    expect(settle({ web: { state: 'ready' }, backend: { state: 'running' } }).status).toBe('building');
    expect(settle({ web: { state: 'ready' }, backend: { state: 'ready' } })).toEqual({ status: 'ready', error: null });
    // One part failed while the other still runs: wait, then fail with the part named.
    expect(settle({ web: { state: 'failed', error: 'The build stopped at "Check the code (tests)".' }, backend: { state: 'running' } }).status).toBe('building');
    expect(settle({ web: { state: 'failed', error: 'The build stopped at "Check the code (tests)".' }, backend: { state: 'ready' } })).toEqual({ status: 'failed', error: 'The website part: The build stopped at "Check the code (tests)".' });
    expect(settle({}).status).toBe('failed');
  });

  it('finds its run by the build id, and waits while it runs', async () => {
    const { gh } = fake([
      [/GET .*\/workflows\/hq-build-change\.yml\/runs/, { status: 200, data: { workflow_runs: [{ id: 5, display_title: 'HQ change 12 (ffffffffffff)', html_url: 'u5' }, { id: 7, display_title: 'HQ change 12 (abcdef012345)', html_url: 'https://github.com/run/7' }] } }],
      [/GET .*\/actions\/runs\/7$/, { status: 200, data: { status: 'in_progress', conclusion: null } }],
    ]);
    expect(await advance(gh, { state: 'starting' }, ctx('web'))).toEqual({ state: 'running', runId: 7, runUrl: 'https://github.com/run/7' });
  });

  it('gives up on a run that never started, but not before', async () => {
    const { gh } = fake([[/GET .*\/runs\?/, { status: 200, data: { workflow_runs: [] } }]]);
    const start: GameBuild = { state: 'starting' };
    expect(await advance(gh, start, ctx('web', T0 + 5 * 60_000))).toBe(start);
    expect(await advance(gh, start, ctx('web', T0 + 11 * 60_000))).toMatchObject({ state: 'failed', error: 'GitHub never started the build.' });
    // GitHub down is not a verdict.
    const down = fake([[/./, { status: 502 }]]);
    expect(await advance(down.gh, start, ctx('web', T0 + 5 * 60_000))).toBe(start);
  });

  it('opens the pull request into staging when the run succeeds', async () => {
    const posted: unknown[] = [];
    const calls: string[] = [];
    const gh: Github = async (method, path, body) => {
      calls.push(`${method} ${path}`);
      if (/\/actions\/runs\/7$/.test(path)) return { status: 200, data: { status: 'completed', conclusion: 'success' } };
      if (path.endsWith('/git/ref/heads/hq/change-12')) return { status: 200, data: { object: { sha: SHA } } };
      if (method === 'GET' && path.includes('/pulls?')) return { status: 200, data: [] };
      if (method === 'POST' && path.endsWith('/pulls')) { posted.push(body); return { status: 201, data: { number: 900, html_url: 'https://github.com/pr/900' } }; }
      return { status: 404, data: null };
    };
    const done = await advance(gh, { state: 'running', runId: 7, runUrl: 'u' }, ctx('web'));
    expect(done).toMatchObject({ state: 'ready', headSha: SHA, prNumber: 900, prUrl: 'https://github.com/pr/900' });
    expect(posted[0]).toMatchObject({ title: 'HQ change 12: Four lives instead of three', head: 'hq/change-12', base: 'staging' });
    expect(calls.find((c) => c.includes('/pulls?'))).toContain(encodeURIComponent('Quizball-trivia:hq/change-12'));
  });

  it('reuses the pull request a rebuild already has, and the one another instance just opened', async () => {
    const existing = fake([
      [/\/actions\/runs\/7$/, { status: 200, data: { status: 'completed', conclusion: 'success' } }],
      [/\/git\/ref\/heads\//, { status: 200, data: { object: { sha: SHA } } }],
      [/GET .*\/pulls\?/, { status: 200, data: [{ number: 41, html_url: 'p41' }] }],
    ]);
    expect(await advance(existing.gh, { state: 'running', runId: 7 }, ctx('backend'))).toMatchObject({ state: 'ready', prNumber: 41 });
    expect(existing.calls.some((c) => c.startsWith('POST'))).toBe(false);

    let lists = 0;
    const race: Github = async (method, path) => {
      if (/\/actions\/runs\/7$/.test(path)) return { status: 200, data: { status: 'completed', conclusion: 'success' } };
      if (path.includes('/git/ref/')) return { status: 200, data: { object: { sha: SHA } } };
      if (method === 'GET' && path.includes('/pulls?')) return { status: 200, data: lists++ === 0 ? [] : [{ number: 42, html_url: 'p42' }] };
      if (method === 'POST') return { status: 422, data: { message: 'A pull request already exists' } };
      return { status: 404, data: null };
    };
    expect(await advance(race, { state: 'running', runId: 7 }, ctx('backend'))).toMatchObject({ state: 'ready', prNumber: 42 });
  });

  it('restarts the checks on a pull request left open by an earlier build', async () => {
    const old = fake([
      [/\/actions\/runs\/7$/, { status: 200, data: { status: 'completed', conclusion: 'success' } }],
      [/\/git\/ref\/heads\//, { status: 200, data: { object: { sha: SHA } } }],
      [/GET .*\/pulls\?/, { status: 200, data: [{ number: 41, html_url: 'p41', created_at: new Date(T0 - 3_600_000).toISOString() }] }],
      [/PATCH .*\/pulls\/41$/, { status: 200, data: {} }],
    ]);
    expect(await advance(old.gh, { state: 'running', runId: 7 }, ctx('backend'))).toMatchObject({ state: 'ready', prNumber: 41 });
    expect(old.calls.filter((c) => c.startsWith('PATCH'))).toHaveLength(2);
    // Opened during this build (by this or another HQ instance): left alone.
    const mine = fake([
      [/\/actions\/runs\/7$/, { status: 200, data: { status: 'completed', conclusion: 'success' } }],
      [/\/git\/ref\/heads\//, { status: 200, data: { object: { sha: SHA } } }],
      [/GET .*\/pulls\?/, { status: 200, data: [{ number: 41, html_url: 'p41', created_at: new Date(T0 + 30_000).toISOString() }] }],
    ]);
    await advance(mine.gh, { state: 'running', runId: 7 }, ctx('backend'));
    expect(mine.calls.some((c) => c.startsWith('PATCH'))).toBe(false);
  });

  it('says where a failed run stopped', async () => {
    const { gh } = fake([
      [/\/actions\/runs\/7$/, { status: 200, data: { status: 'completed', conclusion: 'failure' } }],
      [/\/actions\/runs\/7\/jobs/, { status: 200, data: { jobs: [{ steps: [{ name: 'The agent writes the change', conclusion: 'success' }, { name: 'Check the code (tests)', conclusion: 'failure' }] }] } }],
    ]);
    expect(await advance(gh, { state: 'running', runId: 7 }, ctx('web'))).toMatchObject({ state: 'failed', error: 'The build stopped at "Check the code (tests)".' });
    const cancelled = fake([[/\/actions\/runs\/7$/, { status: 200, data: { status: 'completed', conclusion: 'cancelled' } }]]);
    expect(await advance(cancelled.gh, { state: 'running', runId: 7 }, ctx('web'))).toMatchObject({ state: 'failed', error: 'The build was cancelled.' });
  });

  it('picks up the website preview once it is deployed, never a production one', async () => {
    const ready: GameBuild = { state: 'ready', headSha: SHA, prNumber: 900, prUrl: 'p' };
    const { gh } = fake([
      [/\/deployments\?sha=/, { status: 200, data: [{ id: 1, environment: 'Production' }, { id: 2, environment: 'Preview' }] }],
      [/\/deployments\/2\/statuses/, { status: 200, data: [{ state: 'success', environment_url: 'https://web-git-hq-change-12.vercel.app' }] }],
      [/\/deployments\/1\/statuses/, { status: 200, data: [{ state: 'success', environment_url: 'https://quizball.io' }] }],
    ]);
    expect(await advance(gh, ready, ctx('web'))).toMatchObject({ previewUrl: 'https://web-git-hq-change-12.vercel.app' });
    const none = fake([[/\/deployments\?sha=/, { status: 200, data: [] }]]);
    expect(await advance(none.gh, ready, ctx('web'))).toBe(ready);
    // The server has no preview: nothing is asked.
    const server = fake([]);
    expect(await advance(server.gh, ready, ctx('backend'))).toBe(ready);
    expect(server.calls).toEqual([]);
  });

  it('judges the checks by the newest run of each workflow', () => {
    const runs = [
      { workflow_id: 1, run_number: 4, created_at: '2026-11-27T10:00:00Z', conclusion: 'cancelled' },
      { workflow_id: 1, run_number: 5, created_at: '2026-11-27T10:05:00Z', conclusion: 'success' },
      { workflow_id: 2, run_number: 9, created_at: '2026-11-27T10:01:00Z', conclusion: 'failure' },
    ];
    expect(latestRuns(runs).map((r) => [r.workflow_id, r.conclusion])).toEqual([[1, 'success'], [2, 'failure']]);
    expect(latestRuns([])).toEqual([]);
  });

  it('starts nothing more once the change was dropped or built again', () => {
    expect(stillBuilding({ build_id: 'abcdef012345', status: 'building' }, 'abcdef012345')).toBe(true);
    expect(stillBuilding({ build_id: 'abcdef012345', status: 'cancelled' }, 'abcdef012345')).toBe(false);
    expect(stillBuilding({ build_id: 'ffffffffffff', status: 'building' }, 'abcdef012345')).toBe(false);
    expect(stillBuilding(undefined, 'abcdef012345')).toBe(false);
  });

  it('stops a dropped change on GitHub, also a run and a pull request that appeared after the drop', async () => {
    // Dropped while the website was still "starting" and the server "running": HQ had saved no run and no pull request.
    const late = fake([
      [/GET .*Quizball-trivia\/web\/actions\/workflows\/hq-build-change\.yml\/runs/, { status: 200, data: { workflow_runs: [{ id: 8, display_title: 'HQ change 12 (abcdef012345)', status: 'queued' }] } }],
      [/GET .*quizball-backend\/actions\/workflows\/hq-build-change\.yml\/runs/, { status: 200, data: { workflow_runs: [{ id: 7, display_title: 'HQ change 12 (abcdef012345)', status: 'completed' }] } }],
      [/POST .*\/actions\/runs\/\d+\/cancel$/, { status: 202 }],
      [/GET .*quizball-backend\/pulls\?/, { status: 200, data: [{ number: 55 }] }],
      [/GET .*\/web\/pulls\?/, { status: 200, data: [] }],
      [/PATCH .*\/pulls\/55$/, { status: 200, data: {} }],
    ]);
    await tidy(late.gh, { number: 12, build_id: 'abcdef012345', build_started_at: new Date(T0).toISOString(), builds: { backend: { state: 'running', runId: 7 }, web: { state: 'starting' } } }, T0 + 60_000);
    expect(late.calls).toContain('POST /repos/Quizball-trivia/web/actions/runs/8/cancel');
    // The server run had already finished: nothing to stop, but the pull request it led to is closed.
    expect(late.calls.some((c) => c.endsWith('/runs/7/cancel'))).toBe(false);
    expect(late.calls).toContain('PATCH /repos/Quizball-trivia/quizball-backend/pulls/55');
    expect(late.calls.find((c) => c.includes('/quizball-backend/pulls?'))).toContain(encodeURIComponent('Quizball-trivia:hq/change-12'));

    // GitHub cannot list the pull requests: fall back to the one HQ knows. And a failing GitHub never throws.
    const down = fake([[/GET /, { status: 502 }], [/PATCH .*\/pulls\/41$/, { status: 200, data: {} }]]);
    await tidy(down.gh, { number: 12, build_id: 'abcdef012345', build_started_at: new Date(T0).toISOString(), builds: { backend: { state: 'ready', prNumber: 41 } } }, T0);
    expect(down.calls).toContain('PATCH /repos/Quizball-trivia/quizball-backend/pulls/41');
    const broken: Github = async () => { throw new Error('no network'); };
    await expect(tidy(broken, { number: 12, build_id: 'abcdef012345', build_started_at: null, builds: { web: { state: 'ready', prNumber: 4 } } }, T0)).resolves.toBeUndefined();
  });

  it('lets every website waiting for its preview have a turn', () => {
    const rows = Array.from({ length: 25 }, (_, i) => i);
    expect(takeTurn([1, 2, 3], 10, 7)).toEqual([1, 2, 3]);
    expect(takeTurn(rows, 10, 0)).toEqual(rows.slice(0, 10));
    expect(takeTurn(rows, 10, 1.9)).toEqual(rows.slice(10, 20));
    expect(takeTurn(rows, 10, 2)).toEqual([20, 21, 22, 23, 24, 0, 1, 2, 3, 4]);
    // The first ten never getting a preview does not keep the eleventh waiting: three rounds reach everyone.
    expect(new Set([0, 1, 2].flatMap((turn) => takeTurn(rows, 10, turn))).size).toBe(25);
  });

  it('counts a pull request as merged only when the approved code went into staging', () => {
    const good = { state: 'closed', merged: true, base: { ref: 'staging' }, head: { sha: SHA } };
    expect(pullProblem(good, SHA, 'server')).toBeNull();
    expect(pullProblem({ ...good, state: 'open', merged: false }, SHA, 'server')).toBeNull();
    expect(pullProblem({ ...good, base: { ref: 'main' } }, SHA, 'server')).toContain('merged on GitHub into "main", not into staging');
    expect(pullProblem({ ...good, head: { sha: 'b'.repeat(40) } }, SHA, 'server')).toContain('code other than what was built and approved');
    expect(pullProblem({ state: 'open', base: { ref: 'main' }, head: { sha: SHA } }, SHA, 'website')).toBe('The website pull request no longer goes into staging. Build it again.');
    expect(pullProblem({ state: 'open', base: { ref: 'staging' }, head: { sha: 'b'.repeat(40) } }, SHA, 'website')).toContain('code changed on GitHub');
    expect(pullProblem({ state: 'closed', merged: false, base: { ref: 'staging' }, head: { sha: SHA } }, SHA, 'website')).toBe('The website pull request was closed on GitHub.');
    expect(pullProblem(null, SHA, 'website')).toContain('closed');

    const unsure: GameBuild = { state: 'ready', headSha: SHA, prNumber: 4, mergeUnsure: true };
    // GitHub answered: the doubt is over either way.
    expect(mergeKnown(unsure, good, 'now')).toEqual({ state: 'ready', headSha: SHA, prNumber: 4, mergedAt: 'now' });
    expect(mergeKnown(unsure, { ...good, state: 'open', merged: false }, 'now')).toEqual({ state: 'ready', headSha: SHA, prNumber: 4 });
    expect(mergeKnown(unsure, { ...good, base: { ref: 'main' } }, 'now')).toEqual({ state: 'ready', headSha: SHA, prNumber: 4 });
  });

  describe('merging one part', () => {
    const ready: GameBuild = { state: 'ready', headSha: SHA, prNumber: 4, prUrl: 'p' };
    const open = { state: 'open', merged: false, base: { ref: 'staging' }, head: { sha: SHA } };
    const landed = { state: 'closed', merged: true, base: { ref: 'staging' }, head: { sha: SHA } };
    const green = { status: 200, data: { workflow_runs: [{ workflow_id: 1, run_number: 1, status: 'completed', conclusion: 'success' }] } };
    /** A fake GitHub whose pull request reads are answered in order (the last one repeats). */
    function github(pulls: Array<{ status: number; data?: unknown } | Error>, merge: { status: number; data?: unknown } | Error = { status: 200, data: { merged: true } }) {
      const calls: string[] = [];
      let read = 0;
      const gh: Github = async (method, path) => {
        calls.push(`${method} ${path}`);
        const answer = method === 'PUT' ? merge : path.includes('/actions/runs?') ? green : pulls[Math.min(read++, pulls.length - 1)]!;
        if (answer instanceof Error) throw answer;
        return { status: answer.status, data: answer.data ?? null };
      };
      return { gh, calls };
    }
    const at = () => 'now';

    it('looks again right before merging, and checks afterwards that it landed in staging', async () => {
      const g = github([{ status: 200, data: open }, { status: 200, data: open }, { status: 200, data: landed }]);
      expect(await mergePart(g.gh, ready, 'backend', at)).toEqual({ build: { ...ready, mergedAt: 'now' }, failure: null });
      expect(g.calls.map((c) => c.split(' ')[0])).toEqual(['GET', 'GET', 'GET', 'PUT', 'GET']);
    });

    it('does not merge a pull request that was pointed away from staging while the checks were read', async () => {
      const g = github([{ status: 200, data: open }, { status: 200, data: { ...open, base: { ref: 'main' } } }]);
      const res = await mergePart(g.gh, ready, 'backend', at);
      expect(res.failure).toBe('The server pull request no longer goes into staging. Build it again.');
      expect(res.build).toEqual(ready);
      expect(g.calls.some((c) => c.startsWith('PUT'))).toBe(false);
    });

    it('says so loudly, and does not count it as merged, when the merge landed outside staging', async () => {
      const g = github([{ status: 200, data: open }, { status: 200, data: open }, { status: 200, data: { ...landed, base: { ref: 'main' } } }]);
      const res = await mergePart(g.gh, ready, 'web', at);
      expect(res.misplaced).toBe(true);
      expect(res.failure).toContain('merged on GitHub into "main", not into staging');
      expect(res.build.mergedAt).toBeUndefined();
      expect(res.build.mergeUnsure).toBeUndefined();
    });

    it('accepts a pull request someone already merged only with the approved code, in staging', async () => {
      const fine = github([{ status: 200, data: landed }]);
      expect(await mergePart(fine.gh, ready, 'backend', at)).toMatchObject({ build: { mergedAt: 'now' }, failure: null });
      expect(fine.calls).toHaveLength(1);
      for (const pull of [{ ...landed, base: { ref: 'main' } }, { ...landed, head: { sha: 'b'.repeat(40) } }]) {
        const elsewhere = github([{ status: 200, data: pull }]);
        const res = await mergePart(elsewhere.gh, ready, 'backend', at);
        expect(res.failure).toMatch(/someone has to look at it on GitHub/i);
        expect(res.misplaced).toBe(true);
        expect(res.build.mergedAt).toBeUndefined();
      }
    });

    it('remembers a merge it got no answer about, and settles it the next time by asking GitHub', async () => {
      // The merge call got no answer, or GitHub could not show the pull request afterwards: the outcome is unknown.
      const silent = github([{ status: 200, data: open }], new Error('timeout'));
      const first = await mergePart(silent.gh, ready, 'backend', at);
      expect(first.build).toEqual({ ...ready, mergeUnsure: true });
      expect(first.failure).toContain('could not find out whether it did');
      const blind = github([{ status: 200, data: open }, { status: 200, data: open }, { status: 502 }]);
      expect((await mergePart(blind.gh, ready, 'backend', at)).build.mergeUnsure).toBe(true);
      const crashed = github([{ status: 200, data: open }, { status: 200, data: open }, { status: 502 }], { status: 502 });
      expect((await mergePart(crashed.gh, ready, 'backend', at)).build.mergeUnsure).toBe(true);

      // Approving again: it had merged. Nothing is merged twice.
      const had = github([{ status: 200, data: landed }]);
      expect(await mergePart(had.gh, first.build, 'backend', at)).toMatchObject({ build: { ...ready, mergedAt: 'now' }, failure: null });
      expect((await mergePart(had.gh, first.build, 'backend', at)).build.mergeUnsure).toBeUndefined();
      expect(had.calls.some((c) => c.startsWith('PUT'))).toBe(false);
      // Approving again: it had not. The doubt is gone and the merge is done now.
      const hadNot = github([{ status: 200, data: open }, { status: 200, data: open }, { status: 200, data: landed }]);
      expect(await mergePart(hadNot.gh, first.build, 'backend', at)).toEqual({ build: { ...ready, mergedAt: 'now' }, failure: null });
      // GitHub still cannot be asked: the doubt stays.
      const still = github([{ status: 502 }]);
      expect((await mergePart(still.gh, first.build, 'backend', at)).build.mergeUnsure).toBe(true);
    });

    it('takes a plain refusal, or silence before the merge was asked for, as nothing merged', async () => {
      const refused = github([{ status: 200, data: open }], { status: 405, data: { message: 'Pull Request is not mergeable' } });
      const res = await mergePart(refused.gh, ready, 'backend', at);
      expect(res.failure).toBe('The server pull request could not be merged (GitHub answered 405: Pull Request is not mergeable).');
      expect(res.build).toEqual(ready);
      const early = github([new Error('timeout')]);
      expect(await mergePart(early.gh, ready, 'backend', at)).toEqual({ build: ready, failure: 'GitHub did not answer while merging the server part.' });
      // A server error on the merge, and GitHub then shows it still open: not merged, nothing in doubt.
      const failed = github([{ status: 200, data: open }], { status: 502 });
      expect(await mergePart(failed.gh, ready, 'backend', at)).toEqual({ build: ready, failure: 'The server pull request could not be merged (GitHub answered 502).' });
    });
  });

  it('shows the builds website first, and an approval names the commits it saw', () => {
    expect(buildsView({ backend: { state: 'ready', headSha: SHA, prNumber: 4, prUrl: 'b', mergedAt: '2026-11-27T10:00:00Z' }, web: { state: 'running', runUrl: 'r' }, other: { state: 'ready' } }).map((b) => [b.part, b.state, b.merged])).toEqual([
      ['website', 'running', false],
      ['server', 'ready', true],
    ]);
    expect(changeView({ ...row, builds: null }).builds).toEqual([]);
    expect(mergeGameChangeBodySchema.safeParse({ seen: { web: SHA } }).success).toBe(true);
    expect(mergeGameChangeBodySchema.safeParse({ seen: { web: 'main' } }).success).toBe(false);
    expect(mergeGameChangeBodySchema.safeParse({ seen: { other: SHA } }).success).toBe(false);
  });
});
