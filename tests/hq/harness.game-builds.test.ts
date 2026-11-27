import { describe, expect, it } from 'vitest';
import '../setup.js';

const { advance, branchOf, dispatchInputs, prBody, reposForPlan, settle } = await import('../../src/modules/harness/harness.game-builds.js');
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
