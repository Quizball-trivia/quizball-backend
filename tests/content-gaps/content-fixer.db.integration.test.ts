import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * Opt-in, real PostgreSQL: the content-fixer RPCs (claim → propose → verify) on a throwaway database holding stand-ins
 * of the few tables they read, plus the real content-gaps, answer-gaps and content-fixer migrations, e.g.
 *   CONTENT_FIXER_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/quizball_content_fixer_test
 * Invented footballers only: the repository is public.
 */
const url = process.env.CONTENT_FIXER_TEST_DATABASE_URL;
if (url && !/^postgresql:\/\/[^@]+@127\.0\.0\.1:(5432|5436)\/quizball_content_fixer_test[a-z0-9_]*$/.test(url)) throw new Error('Isolated local test database required');

const MIGRATIONS = ['20261110160000_content_gaps.sql', '20261110165000_hq_answer_gaps.sql', '20261110180000_content_fixer.sql'];
const STANDINS = `
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
  CREATE SCHEMA IF NOT EXISTS hq;
  CREATE TABLE IF NOT EXISTS hq.members (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slug text UNIQUE NOT NULL, kind text, name text, title text,
    avatar text, color text, description text, tools text[] NOT NULL DEFAULT '{}', instructions text, department text, status text DEFAULT 'active', updated_at timestamptz);
  CREATE TABLE IF NOT EXISTS hq.schedules (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), member_id uuid, name text, cron text, timezone text, task_title text, task_body text, task_kind text DEFAULT 'task', enabled boolean DEFAULT true);
  CREATE TABLE IF NOT EXISTS public.wordgame_players (release_id text, pid text, name text, game_name text, fame int, aliases text[]);
  CREATE TABLE IF NOT EXISTS public.darts501_days (day date PRIMARY KEY, category jsonb NOT NULL);
  CREATE TABLE IF NOT EXISTS public.darts501_coverage (coverage_id text, pid text, PRIMARY KEY (coverage_id, pid));
  CREATE TABLE IF NOT EXISTS public.room_pool (game text, item_id text, payload jsonb, enabled boolean DEFAULT true);
  CREATE TABLE IF NOT EXISTS public.tenable_days (day date PRIMARY KEY, list jsonb NOT NULL);
  -- As on Supabase: the service role reaches both schemas and reads the content tables.
  GRANT USAGE ON SCHEMA hq, public TO service_role, anon, authenticated;
  GRANT SELECT ON public.wordgame_players, public.darts501_days, public.darts501_coverage, public.room_pool, public.tenable_days TO service_role;
`;

const CATEGORY = {
  id: 'cat-x', release: 'rel-1', coverage: 'cov-1', unit: 'apps', asOf: '2026-11-09', title: { en: 'Invented League apps for Club X' },
  entries: [{ eid: 'p1', value: 120 }],
};

describe.skipIf(!url)('content fixer RPCs (real PostgreSQL)', () => {
  let sql: ReturnType<typeof postgres>;
  beforeAll(async () => {
    sql = postgres(url!, { max: 2, prepare: false, onnotice: () => undefined });
    // Fresh every run, so the tests never exercise an older migration's functions.
    await sql.unsafe('DROP SCHEMA IF EXISTS hq CASCADE; DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    await sql.unsafe(STANDINS);
    for (const file of MIGRATIONS) {
      const body = readFileSync(new URL(`../../supabase/migrations/${file}`, import.meta.url), 'utf8');
      await sql.begin((tx) => tx.unsafe(body));
    }
  });
  afterAll(async () => { await sql.end(); });
  beforeEach(async () => {
    await sql`TRUNCATE content_gaps, content_gap_samples, content_gap_fixes, darts501_days, darts501_coverage, wordgame_players RESTART IDENTITY CASCADE`;
    await sql`INSERT INTO darts501_days (day, category) VALUES ('2026-11-11', ${sql.json(CATEGORY)})`;
    await sql`INSERT INTO wordgame_players (release_id, pid, name, fame) VALUES ('rel-1', 'p1', 'Aro Bandel', 60), ('rel-1', 'p2', 'Wim Xell', 30)`;
    await sql`INSERT INTO darts501_coverage (coverage_id, pid) VALUES ('cov-1', 'p1')`;
    await sql`
      INSERT INTO content_gaps (game, mode, board_key, context_fp, verdict, norm, resolved_id, count) VALUES
        ('darts501', 'daily', 'cat-x', 'c', 'uncovered', 'wim xell', 'p2', 9),
        ('darts501', 'daily', 'cat-x', 'c', 'unknown', 'zzz', NULL, 2),
        ('tenable', 'daily', 'list-1', 'c', 'miss', 'aro', 'p1', 1)
    `;
  });

  const claim = async (owner = 'fixer:run-1', limit = 10) => (await sql<[{ c: { token: string; gaps: Claimed[] } }]>`SELECT hq.content_gaps_claim(${owner}, ${limit}, 60, 'darts501') AS c`)[0].c;
  const hashOf = async (ctx: unknown) => (await sql<[{ h: string }]>`SELECT md5(${sql.json(ctx as never)}::jsonb::text) AS h`)[0].h;
  type Claimed = { id: number; context: Record<string, unknown>; contextHash: string };
  const stats = { pid: 'p2', asOf: '2026-11-09', leagues: [{ league: 'Premier League', club: 'Club X', apps: 40, goals: 3 }, { league: 'LaLiga', club: 'Club Y', apps: 12, goals: 0 }] };
  const evidence = [{ url: 'https://en.wikipedia.org/wiki/Invented', quote: 'Club X 40 (3)' }];

  async function proposeStats(owner = 'fixer:run-1') {
    const c = await claim(owner);
    const gap = c.gaps.find((g) => g.id === 1)!;
    expect(gap.contextHash).toBe(await hashOf(gap.context));
    const r = (await sql<[{ r: { fixId: number } }]>`SELECT hq.content_gap_propose(${owner}, ${c.token}::uuid, ${[1]}::bigint[], 'stats', ${sql.json(stats)}, ${sql.json(evidence)}, ${sql.json({ 1: gap.contextHash })}) AS r`)[0].r;
    return { c, fixId: r.fixId };
  }

  it('claim leases the most typed open gaps with the server-resolved board context', async () => {
    const c = await claim();
    expect(c.gaps.map((g) => g.id)).toEqual([1, 2]);
    expect(c.gaps[0].context).toMatchObject({ found: true, unit: 'apps', asOf: '2026-11-09', people: [{ id: 'p2', name: 'Wim Xell', covered: false, value: null }] });
    expect((await claim('fixer:run-2')).gaps).toEqual([]);
  });

  it('propose needs the unexpired claim, the same board, the right context hash and a valid stats table', async () => {
    const c = await claim();
    const ctx = c.gaps.find((g) => g.id === 1)!.context;
    const call = (owner: string, token: string, payload: unknown, hash: string) =>
      sql`SELECT hq.content_gap_propose(${owner}, ${token}::uuid, ${[1]}::bigint[], 'stats', ${sql.json(payload as never)}, ${sql.json(evidence)}, ${sql.json({ 1: hash })})`;
    const good = await hashOf(ctx);
    await expect(call('someone-else', c.token, stats, good)).rejects.toThrow(/unexpired claim/);
    await expect(call('fixer:run-1', c.token, stats, 'stale')).rejects.toThrow(/board changed/);
    await expect(call('fixer:run-1', c.token, { ...stats, asOf: '2024-25' }, good)).rejects.toThrow(/asOf/);
    await expect(call('fixer:run-1', c.token, { ...stats, pid: 'nobody' }, good)).rejects.toThrow(/someone else|pid/);
    await expect(call('fixer:run-1', c.token, { ...stats, leagues: [{ league: 'Ligue 9', club: 'X', apps: 1, goals: 0 }] }, good)).rejects.toThrow(/unknown league/);
    // Missing fields are problems, never "unknown".
    await expect(call('fixer:run-1', c.token, { pid: 'p2', asOf: '2026-11-09' }, good)).rejects.toThrow(/leagues/);
    await expect(call('fixer:run-1', c.token, { ...stats, leagues: [{ league: 'LaLiga', club: 'X' }] }, good)).rejects.toThrow(/whole numbers/);
    await expect(call('fixer:run-1', c.token, { ...stats, leagues: [{ club: 'X', apps: 1, goals: 0 }] }, good)).rejects.toThrow(/unknown league/);
    // A gap about someone else is not this footballer's stats fix.
    await expect(call('fixer:run-1', c.token, { ...stats, pid: 'p1' }, good)).rejects.toThrow(/someone else/);
    await sql`UPDATE content_gaps SET lease_until = now() - interval '1 second' WHERE id = 1`;
    await expect(call('fixer:run-1', c.token, stats, good)).rejects.toThrow(/unexpired claim/);
  });

  it('a proposed gap is bound to its fix and never reclaimed; a second propose is refused', async () => {
    const { c, fixId } = await proposeStats();
    const [gap] = await sql`SELECT status, fix_id FROM content_gaps WHERE id = 1`;
    expect(gap).toEqual({ status: 'proposed', fix_id: String(fixId) === String(gap.fix_id) ? gap.fix_id : fixId });
    await sql`UPDATE content_gaps SET lease_until = now() - interval '1 hour'`;
    expect((await claim('fixer:run-2')).gaps.map((g) => g.id)).not.toContain(1);
    await expect(sql`SELECT hq.content_gap_propose('fixer:run-1', ${c.token}::uuid, ${[1]}::bigint[], 'stats', ${sql.json(stats)}, ${sql.json(evidence)}, ${sql.json({ 1: 'x' })})`).rejects.toThrow();
  });

  it('verified only when the verifier agrees, matches exactly and cites two publishers; else held', async () => {
    const { fixId } = await proposeStats();
    const vclaim = async () => (await sql<[{ c: { token: string; fixes: Array<{ id: number; claim: unknown }> } }]>`SELECT hq.content_fixes_claim('verifier:run-9', 5, 60) AS c`)[0].c;
    const v = await vclaim();
    expect(v.fixes.map((f) => f.id)).toEqual([fixId]);
    expect(JSON.stringify(v.fixes[0])).not.toContain('wikipedia');
    const two = [{ url: 'https://de.wikipedia.org/wiki/Erfunden', quote: 'Club X 40 3' }, { url: 'https://www.espn.com/soccer/player/_/id/1', quote: '40 apps 3 goals' }];
    const verify = (sources: unknown, extracted: unknown, verdict = 'agree') =>
      sql<[{ r: { status: string } }]>`SELECT hq.content_fix_verify('verifier:run-9', ${v.token}::uuid, ${fixId}, ${verdict}, ${sql.json(extracted as never)}, ${sql.json(sources as never)}) AS r`;
    // Reordered rows are the same table.
    const [{ r }] = await verify(two, { pid: 'p2', asOf: '2026-11-09', leagues: [...stats.leagues].reverse().map((x) => ({ ...x, club: `FC ${x.club}` })) });
    expect(r.status).toBe('verified');
    const [gap] = await sql`SELECT status FROM content_gaps WHERE id = 1`;
    expect(gap.status).toBe('verified');
  });

  it('one publisher (wikipedia editions and mirrors count once), or different numbers, is held', async () => {
    const { fixId } = await proposeStats();
    const v = (await sql<[{ c: { token: string } }]>`SELECT hq.content_fixes_claim('verifier:run-9', 5, 60) AS c`)[0].c;
    const wikiOnly = [{ url: 'https://en.wikipedia.org/wiki/A', quote: 'x' }, { url: 'https://www.wikiwand.com/en/A', quote: 'y' }];
    const [{ r }] = await sql<[{ r: { status: string; checks: { publishers: number } } }]>`SELECT hq.content_fix_verify('verifier:run-9', ${v.token}::uuid, ${fixId}, 'agree', ${sql.json({ pid: 'p2', asOf: '2026-11-09', leagues: stats.leagues })}, ${sql.json(wikiOnly)}) AS r`;
    expect(r).toMatchObject({ status: 'held', checks: { publishers: 1 } });
    expect((await sql`SELECT status FROM content_gaps WHERE id = 1`)[0].status).toBe('held');
  });

  it('a proposer never verifies its own fix (in any run), and an expired verification lease is reclaimable', async () => {
    const { fixId } = await proposeStats('fixer:run-1');
    expect((await sql<[{ c: { fixes: unknown[] } }]>`SELECT hq.content_fixes_claim('fixer:run-1', 5, 60) AS c`)[0].c.fixes).toEqual([]);
    expect((await sql<[{ c: { fixes: unknown[] } }]>`SELECT hq.content_fixes_claim('fixer:run-77', 5, 60) AS c`)[0].c.fixes).toEqual([]);
    const first = (await sql<[{ c: { fixes: Array<{ id: number }> } }]>`SELECT hq.content_fixes_claim('verifier:run-a', 5, 60) AS c`)[0].c;
    expect(first.fixes.map((f) => f.id)).toEqual([fixId]);
    expect((await sql<[{ c: { fixes: unknown[] } }]>`SELECT hq.content_fixes_claim('verifier:run-b', 5, 60) AS c`)[0].c.fixes).toEqual([]);
    await sql`UPDATE content_gap_fixes SET lease_until = now() - interval '1 second'`;
    expect((await sql<[{ c: { fixes: Array<{ id: number }> } }]>`SELECT hq.content_fixes_claim('verifier:run-b', 5, 60) AS c`)[0].c.fixes.map((f) => f.id)).toEqual([fixId]);
  });

  it('an unclaimed fix cannot be verified with a NULL owner and token', async () => {
    const { fixId } = await proposeStats();
    const two = [{ url: 'https://de.wikipedia.org/wiki/Erfunden', quote: 'x' }, { url: 'https://www.espn.com/a', quote: 'y' }];
    await expect(sql`SELECT hq.content_fix_verify(NULL, NULL, ${fixId}, 'agree', ${sql.json(stats)}, ${sql.json(two)})`).rejects.toThrow(/unexpired claim/);
    expect((await sql`SELECT status FROM content_gap_fixes WHERE id = ${fixId}`)[0].status).toBe('proposed');
  });

  it('stats written as 40.0 compare as 40; goals over 2000 are refused', async () => {
    const { fixId } = await proposeStats();
    const v = (await sql<[{ c: { token: string } }]>`SELECT hq.content_fixes_claim('verifier:run-9', 5, 60) AS c`)[0].c;
    const two = [{ url: 'https://de.wikipedia.org/wiki/Erfunden', quote: 'x' }, { url: 'https://www.espn.com/a', quote: 'y' }];
    const decimals = { ...stats, leagues: stats.leagues.map((x) => ({ ...x, apps: Number(x.apps).toFixed(1) })) };
    const body = JSON.stringify(decimals).replace(/"apps":"(\d+\.0)"/g, '"apps":$1');
    const [{ r }] = await sql<[{ r: { status: string } }]>`SELECT hq.content_fix_verify('verifier:run-9', ${v.token}::uuid, ${fixId}, 'agree', ${body}::text::jsonb, ${sql.json(two)}) AS r`;
    expect(r.status).toBe('verified');
    const [{ p }] = await sql`SELECT hq.content_stats_problem(${sql.json([{ league: 'LaLiga', club: 'Club Y', apps: 10, goals: 3000000000 }])}) AS p`;
    expect(p).toMatch(/0 to 2000/);
  });

  it('contact text split by control characters is still redacted', async () => {
    const rows = await sql<Array<{ t: string }>>`SELECT hq.answer_gaps_text(u) AS t FROM unnest(${['555\t123\t4567', '555\u00a0123\u00a04567', '５５５１２３４５６７', 'Wim Xell']}::text[]) u`;
    expect(rows.map((r) => r.t)).toEqual(['[redacted]', '[redacted]', '[redacted]', 'Wim Xell']);
  });

  it('closures close gaps directly; human-only kinds are held; release frees unproposed gaps', async () => {
    const c = await claim();
    await sql`SELECT hq.content_gap_propose('fixer:run-1', ${c.token}::uuid, ${[2]}::bigint[], 'junk', ${sql.json({ reason: 'not a name' })}, '[]'::jsonb, NULL)`;
    expect((await sql`SELECT status FROM content_gaps WHERE id = 2`)[0].status).toBe('junk');
    expect(await sql`SELECT hq.content_gaps_release('fixer:run-1', ${c.token}::uuid) AS n`).toEqual([{ n: 1 }]);
    expect((await sql`SELECT status FROM content_gaps WHERE id = 1`)[0].status).toBe('open');
    const c2 = await claim('fixer:run-2');
    const ctx = c2.gaps.find((g) => g.id === 1)!.context;
    const [{ r }] = await sql<[{ r: { status: string } }]>`SELECT hq.content_gap_propose('fixer:run-2', ${c2.token}::uuid, ${[1]}::bigint[], 'needs_entity', ${sql.json({ name: 'Wim Xell' })}, ${sql.json(evidence)}, ${sql.json({ 1: await hashOf(ctx) })}) AS r`;
    expect(r.status).toBe('held');
    expect((await sql`SELECT status FROM content_gaps WHERE id = 1`)[0].status).toBe('held');
  });

  it('publisher folding', async () => {
    const rows = await sql<Array<{ p: string | null }>>`SELECT hq.content_publisher(u) AS p FROM unnest(${[
      'https://en.wikipedia.org/wiki/X', 'https://www.transfermarkt.co.uk/x', 'https://www.bbc.co.uk/sport', 'http://insecure.example.com/', 'https://www.espn.com/a',
      'https://www.espn.com./b', 'https://www..espn.com/c', 'https://espn.com:443@en.wikipedia.org/wiki/B', 'https://www.espn.com:443/d',
    ]}::text[]) u`;
    expect(rows.map((r) => r.p)).toEqual(['wikipedia', 'transfermarkt', 'bbc', null, 'espn', null, null, null, 'espn']);
  });

  it('the service role can run the RPCs; anon and authenticated cannot, nor read the tables', async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe('SET LOCAL ROLE service_role');
      const [{ c }] = await tx`SELECT hq.content_gaps_claim('fixer:svc', 5, 60, NULL) AS c`;
      expect((c as { gaps: unknown[] }).gaps.length).toBeGreaterThan(0);
    });
    for (const role of ['anon', 'authenticated']) {
      await expect(sql.begin(async (tx) => { await tx.unsafe(`SET LOCAL ROLE ${role}`); await tx`SELECT hq.content_gaps_claim('x', 1, 60, NULL)`; })).rejects.toThrow(/permission denied/);
      await expect(sql.begin(async (tx) => { await tx.unsafe(`SET LOCAL ROLE ${role}`); await tx`SELECT count(*) FROM public.content_gap_fixes`; })).rejects.toThrow(/permission denied/);
    }
  });

  it('a different club, cut-off or a same-publisher pair (espn.com + espn.co.uk) is held', async () => {
    const cases: Array<[unknown, unknown, string]> = [
      [{ pid: 'p2', asOf: '2026-11-09', leagues: [{ ...stats.leagues[0], club: 'Club Z' }, stats.leagues[1]] }, [{ url: 'https://en.wikipedia.org/wiki/A', quote: 'x' }, { url: 'https://www.espn.com/a', quote: 'y' }], 'club'],
      [{ pid: 'p2', asOf: '2025-26', leagues: stats.leagues }, [{ url: 'https://en.wikipedia.org/wiki/A', quote: 'x' }, { url: 'https://www.espn.com/a', quote: 'y' }], 'asOf'],
      [{ pid: 'p2', asOf: '2026-11-09', leagues: stats.leagues }, [{ url: 'https://www.espn.com/a', quote: 'x' }, { url: 'https://www.espn.co.uk/b', quote: 'y' }], 'publisher'],
    ];
    for (const [extracted, sources, why] of cases) {
      await sql`TRUNCATE content_gap_fixes RESTART IDENTITY CASCADE`;
      await sql`UPDATE content_gaps SET status = 'open', fix_id = NULL, lease_owner = NULL, lease_token = NULL, lease_until = NULL`;
      const { fixId } = await proposeStats();
      const v = (await sql<[{ c: { token: string } }]>`SELECT hq.content_fixes_claim('verifier:run-9', 5, 60) AS c`)[0].c;
      const [{ r }] = await sql<[{ r: { status: string } }]>`SELECT hq.content_fix_verify('verifier:run-9', ${v.token}::uuid, ${fixId}, 'agree', ${sql.json(extracted as never)}, ${sql.json(sources as never)}) AS r`;
      expect(r.status, why).toBe('held');
    }
  });

  it('a fix whose gaps a person took back cannot verify (held, gapsBound false)', async () => {
    const { fixId } = await proposeStats();
    // A person reopens the gap (its binding goes), then the old fix is sent back to the verifier.
    await sql`UPDATE content_gaps SET status = 'open', fix_id = NULL WHERE id = 1`;
    const v = (await sql<[{ c: { token: string } }]>`SELECT hq.content_fixes_claim('verifier:run-9', 5, 60) AS c`)[0].c;
    const two = [{ url: 'https://de.wikipedia.org/wiki/E', quote: 'x' }, { url: 'https://www.espn.com/a', quote: 'y' }];
    const [{ r }] = await sql<[{ r: { status: string; checks: { gapsBound: boolean } } }]>`SELECT hq.content_fix_verify('verifier:run-9', ${v.token}::uuid, ${fixId}, 'agree', ${sql.json({ pid: 'p2', asOf: '2026-11-09', leagues: stats.leagues })}, ${sql.json(two)}) AS r`;
    expect(r).toMatchObject({ status: 'held', checks: { gapsBound: false } });
    expect((await sql`SELECT status FROM content_gaps WHERE id = 1`)[0].status).toBe('open');
  });

  it('a changed board (any entry) changes the hash, so a stale proposal is refused', async () => {
    const c = await claim();
    const gap = c.gaps.find((g) => g.id === 1)!;
    await sql`UPDATE darts501_days SET category = jsonb_set(category, '{entries}', category->'entries' || '[{"eid":"p9","value":3}]'::jsonb)`;
    await expect(sql`SELECT hq.content_gap_propose('fixer:run-1', ${c.token}::uuid, ${[1]}::bigint[], 'stats', ${sql.json(stats)}, ${sql.json(evidence)}, ${sql.json({ 1: gap.contextHash })})`).rejects.toThrow(/board changed/);
  });

  it('an ambiguous gap (no resolved id) only takes stats for one of its candidates', async () => {
    await sql`UPDATE content_gaps SET resolved_id = NULL, candidate_ids = ARRAY['p1'] WHERE id = 1`;
    const c = await claim();
    const gap = c.gaps.find((g) => g.id === 1)!;
    await expect(sql`SELECT hq.content_gap_propose('fixer:run-1', ${c.token}::uuid, ${[1]}::bigint[], 'stats', ${sql.json(stats)}, ${sql.json(evidence)}, ${sql.json({ 1: gap.contextHash })})`).rejects.toThrow(/someone else/);
  });

  it('an alias must name someone in this board\'s own directory', async () => {
    const c = await claim();
    const gap = c.gaps.find((g) => g.id === 1)!;
    const alias = (entityId: string) => sql`SELECT hq.content_gap_propose('fixer:run-1', ${c.token}::uuid, ${[1]}::bigint[], 'alias', ${sql.json({ entityId, locale: 'ka', text: 'ვიმ ქსელი' })}, ${sql.json(evidence)}, ${sql.json({ 1: gap.contextHash })})`;
    await expect(alias('club-77')).rejects.toThrow(/release/);
    const [row] = await alias('p2');
    expect((row.content_gap_propose as { status: string }).status).toBe('proposed');
  });

  it('flags a gap typed against an earlier board revision as stale', async () => {
    await sql`UPDATE content_gaps SET context_fp = 'rel-1|cov-OLD|m1|ru-|abc' WHERE id = 1`;
    await sql`UPDATE content_gaps SET context_fp = 'rel-1|cov-1|m1|ru-|abc' WHERE id = 2`;
    const c = await claim();
    expect(c.gaps.find((g) => g.id === 1)!.context).toMatchObject({ stale: true, recorded: 'rel-1|cov-OLD|m1|ru-|abc' });
    expect(c.gaps.find((g) => g.id === 2)!.context).toMatchObject({ stale: false });
  });
});
