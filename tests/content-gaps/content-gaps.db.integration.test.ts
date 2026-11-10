import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';

/**
 * Opt-in, real PostgreSQL with the content-gaps migration applied, e.g.
 *   CONTENT_GAPS_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/quizball_content_gaps_test
 * Invented text only: the repository is public.
 */
const db = vi.hoisted(() => ({ sql: null as unknown as ReturnType<typeof postgres> }));
vi.mock('../../src/db/index.js', () => ({ get sql() { return db.sql; } }));

const url = process.env.CONTENT_GAPS_TEST_DATABASE_URL;
if (url && !/^postgresql:\/\/[^@]+@127\.0\.0\.1:(5432|5436)\/quizball_content_gaps_test[a-z0-9_]*$/.test(url)) throw new Error('Isolated local test database required');

const { contentGaps, __test, OPEN_PER_BOARD, stopContentGapsRecorder } = await import('../../src/modules/content-gaps/content-gaps.recorder.js');
const { GapBuffer } = await import('../../src/modules/content-gaps/content-gaps.buffer.js');
const { sweepContentGaps } = await import('../../src/modules/content-gaps/content-gaps.sweeper.js');

describe.skipIf(!url)('content gaps recorder (real PostgreSQL)', () => {
  beforeAll(() => { db.sql = postgres(url!, { max: 2, prepare: false, onnotice: () => undefined }); });
  afterAll(async () => { await db.sql.end(); });
  beforeEach(async () => {
    __test.reset();
    await db.sql`TRUNCATE content_gaps, content_gap_samples RESTART IDENTITY CASCADE`;
  });

  const obs = (text: string, over: Record<string, unknown> = {}) => ({
    game: 'darts501', mode: 'daily' as const, boardKey: 'cat-1', context: 'rel|cov|m1|aaa', verdict: 'unknown' as const, text, ...over,
  });

  it('flushes aggregated counts and samples; later flushes add to the same row', async () => {
    contentGaps.record(obs('Aro Bandel', { locale: 'en' }));
    contentGaps.record(obs('aro bandel', { locale: 'es' }));
    contentGaps.record(obs('Udo Varn', { verdict: 'miss', resolvedId: 'p10' }));
    await __test.flush();
    contentGaps.record(obs('ARO BANDEL', { locale: 'en' }));
    await __test.flush();
    const rows = await db.sql`SELECT verdict, norm, count, resolved_id FROM content_gaps ORDER BY norm`;
    expect(rows).toEqual([
      { verdict: 'unknown', norm: 'aro bandel', count: 3, resolved_id: null },
      { verdict: 'miss', norm: 'udo varn', count: 1, resolved_id: 'p10' },
    ]);
    const samples = await db.sql`SELECT locale, typed FROM content_gap_samples`;
    expect(samples.map((s) => `${s.locale}:${s.typed}`).sort()).toEqual(['en:ARO BANDEL', 'en:Aro Bandel', 'es:aro bandel', 'xx:Udo Varn']);
  });

  it('keeps at most 5 samples per gap and locale across flushes', async () => {
    for (let round = 0; round < 3; round += 1) {
      for (let i = 0; i < 3; i += 1) contentGaps.record(obs(`Aro Bandel${'.'.repeat(round * 3 + i)}`, { locale: 'en' }));
      await __test.flush();
    }
    const [{ n }] = await db.sql`SELECT count(*)::int AS n FROM content_gap_samples`;
    expect(n).toBe(5);
  });

  it('stores candidates for ambiguous text', async () => {
    contentGaps.record(obs('Zorr', { verdict: 'ambiguous', candidateIds: ['p12', 'p13'] }));
    await __test.flush();
    const [row] = await db.sql`SELECT candidate_ids FROM content_gaps`;
    expect(row.candidate_ids).toEqual(['p12', 'p13']);
  });

  it('a board at its quota takes no new texts but existing ones keep counting', async () => {
    await db.sql`
      INSERT INTO content_gaps (game, mode, board_key, context_fp, verdict, norm, count)
      SELECT 'darts501', 'daily', 'cat-1', 'rel|cov|m1|aaa', 'unknown', 'filler ' || g, 1 FROM generate_series(1, ${OPEN_PER_BOARD}) g
    `;
    contentGaps.record(obs('Brand New'));
    contentGaps.record(obs('filler 7'));
    contentGaps.record(obs('Brand New', { boardKey: 'cat-2' }));
    await __test.flush();
    const rows = await db.sql`SELECT board_key, norm, count FROM content_gaps WHERE norm IN ('brand new', 'filler 7') ORDER BY board_key, norm`;
    expect(rows).toEqual([{ board_key: 'cat-1', norm: 'filler 7', count: 2 }, { board_key: 'cat-2', norm: 'brand new', count: 1 }]);
  });

  it('a failed chunk is dropped, not retried (never double counted)', async () => {
    contentGaps.record(obs('Aro Bandel', { game: 'x'.repeat(40), boardKey: 'b'.repeat(160) }));
    await db.sql.unsafe(`ALTER TABLE content_gaps ADD CONSTRAINT tmp_block CHECK (game <> '${'x'.repeat(40)}')`);
    try {
      await __test.flush();
      await __test.flush();
    } finally {
      await db.sql`ALTER TABLE content_gaps DROP CONSTRAINT tmp_block`;
    }
    const [{ n }] = await db.sql`SELECT count(*)::int AS n FROM content_gaps`;
    expect(n).toBe(0);
  });

  it('the sweeper removes idle open gaps and old closed ones only', async () => {
    await db.sql`
      INSERT INTO content_gaps (game, mode, board_key, context_fp, verdict, norm, count, status, last_seen, updated_at) VALUES
        ('g', 'daily', 'b', 'c', 'unknown', 'idle open', 1, 'open', now() - interval '61 days', now()),
        ('g', 'daily', 'b', 'c', 'unknown', 'fresh open', 1, 'open', now() - interval '5 days', now()),
        ('g', 'daily', 'b', 'c', 'unknown', 'old fixed', 1, 'fixed', now() - interval '200 days', now() - interval '181 days'),
        ('g', 'daily', 'b', 'c', 'unknown', 'recent fixed', 1, 'fixed', now() - interval '200 days', now() - interval '10 days')
    `;
    expect(await sweepContentGaps()).toBe(2);
    const left = await db.sql`SELECT norm FROM content_gaps ORDER BY norm`;
    expect(left.map((r) => r.norm)).toEqual(['fresh open', 'recent fixed']);
  });

  it('concurrent flushes never push a board past its quota', async () => {
    await db.sql`
      INSERT INTO content_gaps (game, mode, board_key, context_fp, verdict, norm, count)
      SELECT 'darts501', 'daily', 'cat-q', 'c', 'unknown', 'filler ' || g, 1 FROM generate_series(1, ${OPEN_PER_BOARD - 1}) g
    `;
    const rowsOf = (texts: string[]) => {
      const b = new GapBuffer();
      for (const t of texts) b.add(obs(t, { boardKey: 'cat-q', context: 'c' }));
      return b.drain();
    };
    const refused = await Promise.all([__test.writeChunk(rowsOf(['New One', 'New Two'])), __test.writeChunk(rowsOf(['New Three', 'New Four']))]);
    const [{ n }] = await db.sql`SELECT count(*)::int AS n FROM content_gaps WHERE board_key = 'cat-q'`;
    expect(n).toBe(OPEN_PER_BOARD);
    expect(refused[0] + refused[1]).toBe(3);
  });

  it('shutdown drains what is buffered and then takes nothing more', async () => {
    contentGaps.record(obs('Late Arrival'));
    await stopContentGapsRecorder();
    contentGaps.record(obs('After Stop'));
    await __test.flush();
    const rows = await db.sql`SELECT norm FROM content_gaps`;
    expect(rows.map((r) => r.norm)).toEqual(['late arrival']);
  });
});
