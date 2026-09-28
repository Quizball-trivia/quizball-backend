/**
 * WL content import against the local DB: check() must catch twins that
 * exist only in a past event's wl_questions, import() must publish only
 * bilingual rows with expanded aliases inside a batch, undo must spare rows
 * a tournament has dealt. Translation is mocked (fills ka from en).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../../src/modules/questions/translation.service.js', () => ({
  translationService: {
    isConfigured: () => true,
    async translateQuestions(ids: string[]) {
      const { sql } = await import('../../src/db/index.js');
      const fill = (node: unknown): unknown => {
        if (Array.isArray(node)) return node.map(fill);
        if (node && typeof node === 'object') {
          const rec = node as Record<string, unknown>;
          if (typeof rec['en'] === 'string' && !rec['ka']) return { ...rec, ka: `${rec['en']} ka` };
          return Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, fill(v)]));
        }
        return node;
      };
      for (const id of ids) {
        const [row] = await sql<Array<{ prompt: Record<string, unknown>; payload: Record<string, unknown> }>>`
          SELECT q.prompt, qp.payload FROM questions q JOIN question_payloads qp ON qp.question_id = q.id WHERE q.id = ${id}`;
        if (!row) continue;
        // One row is deliberately left monolingual to prove it stays draft.
        if ((row.prompt['en'] as string).includes('UNTRANSLATABLE')) continue;
        await sql`UPDATE questions SET prompt = ${sql.json(fill(row.prompt) as never)} WHERE id = ${id}`;
        await sql`UPDATE question_payloads SET payload = ${sql.json(fill(row.payload) as never)} WHERE question_id = ${id}`;
      }
      return { translated: ids.length, skipped: 0, failed: 0 };
    },
  },
}));

let sql: typeof import('../../src/db/index.js').sql;
let svc: typeof import('../../src/modules/weekend-league/wl-content.service.js');
let dbAvailable = false;
let categoryId = '';
let createdCategory = false;
const questionIds: string[] = [];
const tournamentIds: string[] = [];
const batchIds: string[] = [];
const WL_TEST_LOCK = 774431002;
let lockConn: Awaited<ReturnType<typeof sql.reserve>> | null = null;

const i18n = (s: string) => ({ en: s, ka: `${s} ka` });

async function seedPool(type: string, prompt: string, payload: Record<string, unknown>): Promise<string> {
  const [q] = await sql<{ id: string }[]>`
    INSERT INTO questions (category_id, type, difficulty, status, ranked_eligible, visibility, prompt)
    VALUES (${categoryId}, ${type}, 'medium', 'published', false, 'wl_private', ${sql.json(i18n(prompt) as never)}) RETURNING id`;
  await sql`INSERT INTO question_payloads (question_id, payload) VALUES (${q.id}, ${sql.json(payload as never)})`;
  questionIds.push(q.id);
  return q.id;
}

async function waitForBatch(id: string): Promise<Awaited<ReturnType<typeof svc.wlContentBatch>>> {
  for (let i = 0; i < 200; i += 1) {
    const b = await svc.wlContentBatch(id);
    if (b.status !== 'processing') return b;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('batch did not finish');
}

const tf = (text: string, answer = true) => ({
  type: 'true_false' as const, difficulty: 'medium' as const, status: 'draft' as const, explanation: null,
  prompt: { en: text },
  payload: { type: 'true_false' as const, options: [
    { id: 'true', text: { en: 'True' }, is_correct: answer }, { id: 'false', text: { en: 'False' }, is_correct: !answer },
  ] },
});
const career = (clubs: string[], answer: string) => ({
  type: 'career_path' as const, difficulty: 'hard' as const, status: 'draft' as const, explanation: null,
  prompt: { en: 'Whose career path is this?' },
  payload: { type: 'career_path' as const, clubs: clubs.map((c) => ({ en: c })), display_answer: { en: answer }, accepted_answers: [answer.split(' ').pop()!] },
});
const pio = (prompt: string, ordered: string[]) => ({
  type: 'put_in_order' as const, difficulty: 'easy' as const, status: 'draft' as const, explanation: null,
  prompt: { en: prompt },
  payload: { type: 'put_in_order' as const, prompt: { en: prompt }, direction: 'asc' as const,
    items: ordered.map((label, i) => ({ id: `i${i}`, label: { en: label }, details: null, emoji: null, sort_value: i + 1 })) },
});
const clue = (answer: string, clues: string[]) => ({
  type: 'clue_chain' as const, difficulty: 'hard' as const, status: 'draft' as const, explanation: null,
  prompt: { en: 'Who am I?' },
  payload: { type: 'clue_chain' as const, display_answer: { en: answer }, accepted_answers: [answer],
    clues: clues.map((c) => ({ type: 'text' as const, content: { en: c } })) },
});

beforeAll(async () => {
  try {
    sql = (await import('../../src/db/index.js')).sql;
    await sql`SELECT 1`;
    svc = await import('../../src/modules/weekend-league/wl-content.service.js');
    lockConn = await sql.reserve();
    await lockConn`SELECT pg_advisory_lock(${WL_TEST_LOCK})`;
    const [cat] = await sql<{ id: string }[]>`SELECT id FROM categories WHERE slug = ${svc.WL_CONTENT_CATEGORY_SLUG}`;
    if (cat) categoryId = cat.id;
    else {
      const [made] = await sql<{ id: string }[]>`
        INSERT INTO categories (slug, name, is_active) VALUES (${svc.WL_CONTENT_CATEGORY_SLUG}, ${sql.json({ en: 'World Cup', ka: 'მსოფლიო' } as never)}, true) RETURNING id`;
      categoryId = made!.id; createdCategory = true;
    }
    dbAvailable = true;
  } catch (err) {
    console.warn('\n⚠️  Skipping WL content tests: DB unavailable.', err instanceof Error ? err.message : err, '\n');
    if (lockConn) { await lockConn`SELECT pg_advisory_unlock(${WL_TEST_LOCK})`.catch(() => {}); lockConn.release(); lockConn = null; }
  }
}, 120_000);

afterAll(async () => {
  if (!dbAvailable) return;
  if (tournamentIds.length) await sql`DELETE FROM wl_tournaments WHERE id = ANY(${sql.array(tournamentIds)}::uuid[])`;
  if (batchIds.length) {
    const extra = await sql<{ question_id: string | null }[]>`SELECT question_id FROM wl_content_batch_rows WHERE batch_id = ANY(${sql.array(batchIds)}::uuid[])`;
    questionIds.push(...extra.map((r) => r.question_id).filter((id): id is string => Boolean(id)));
    await sql`DELETE FROM wl_content_batches WHERE id = ANY(${sql.array(batchIds)}::uuid[])`;
  }
  if (questionIds.length) {
    await sql`DELETE FROM question_payloads WHERE question_id = ANY(${sql.array(questionIds)}::uuid[])`;
    await sql`DELETE FROM questions WHERE id = ANY(${sql.array(questionIds)}::uuid[])`;
  }
  if (createdCategory) await sql`DELETE FROM categories WHERE id = ${categoryId}`;
  if (lockConn) { await lockConn`SELECT pg_advisory_unlock(${WL_TEST_LOCK})`.catch(() => {}); lockConn.release(); }
  await sql.end({ timeout: 5 });
});

describe('wlContentCheck', () => {
  it('flags pool twins, played history twins, similar rankings, missing crests and bad shapes', async ({ skip }) => {
    if (!dbAvailable) skip();
    await seedPool('true_false', 'Zidane scored twice in the 1998 final.', tf('x').payload);
    // A twin that lives ONLY in a past event's frozen rows (source deleted / re-ingested).
    const [t] = await sql<{ id: string }[]>`
      INSERT INTO wl_tournaments (is_test, status, week_key, config) VALUES (false, 'completed', '2026-01-03', '{}'::jsonb) RETURNING id`;
    tournamentIds.push(t.id);
    const [wq] = await sql<{ question_id: string }[]>`
      INSERT INTO wl_questions (tournament_id, game_index, round_index, question_index, reserve_ordinal, kind, payload, evaluation, source_question_id)
      VALUES (${t.id}, 0, 0, 0, 0, 'mcq', ${sql.json({ prompt: { en: 'Which stadium opened in 2011?', ka: 'x' }, options: [{ id: 'a', text: { en: 'Allianz Stadium', ka: 'ა' } }, { id: 'b', text: { en: 'San Siro', ka: 'ბ' } }] } as never)}, ${sql.json({ correct_id: 'a' } as never)}, NULL)
      RETURNING question_id`;
    await sql`INSERT INTO wl_question_runs (attempt_id, tournament_id, game_index, round_index, question_index, question_id, status)
              VALUES (gen_random_uuid(), ${t.id}, 0, 0, 0, ${wq!.question_id}, 'revealed')`;
    await seedPool('put_in_order', 'Order these clubs by Serie A titles (High to Low)', pio('Order these clubs by Serie A titles (High to Low)', ['Juventus', 'Inter', 'Milan', 'Genoa']).payload);

    const report = await svc.wlContentCheck([
      tf('Zidane scored twice in the 1998 final.', true),
      { ...tf('Which stadium opened in 2011?'), type: 'mcq_single', payload: { type: 'mcq_single', image: { url: 'https://example.com/x.jpg', width: 1, height: 1 }, options: [
        { id: 'a', text: { en: 'Allianz Stadium' }, is_correct: true }, { id: 'b', text: { en: 'San Siro' }, is_correct: false },
        { id: 'c', text: { en: 'Olimpico' }, is_correct: false }, { id: 'd', text: { en: 'Franchi' }, is_correct: false } ] } } as never,
      pio('Order these clubs by founding year', ['Genoa', 'Juventus', 'Milan', 'Inter']),
      career(['Cobh Ramblers', 'Nottingham Forest', 'Manchester United'], 'Roy Keane'),
      clue('Guti', ['a', 'b', 'c', 'd']),
      tf('Fresh statement nobody asked before.'),
    ], { probeImages: false });

    const byIdx = Object.fromEntries(report.rows.map((r) => [r.index, r]));
    expect(byIdx[0]!.status).toBe('duplicate');
    expect(byIdx[0]!.duplicate_of?.where).toBe('pool');
    expect(byIdx[1]!.status).toBe('played');
    expect(byIdx[1]!.duplicate_of?.week_key).toBe('2026-01-03');
    expect(byIdx[2]!.status).toBe('warning');
    expect(byIdx[2]!.issues.map((i) => i.code)).toContain('similar');
    expect(byIdx[3]!.status).toBe('warning');
    expect(byIdx[3]!.crests.find((c) => c.club === 'Cobh Ramblers')?.club_id).toBeNull();
    expect(byIdx[3]!.crests.find((c) => c.club === 'Manchester United')?.club_id).toBe('manchester-united');
    expect(byIdx[4]!.status).toBe('error');
    expect(byIdx[5]!.status).toBe('ready');
    expect(report.summary).toEqual({ ready: 1, warning: 2, duplicate: 1, played: 1, error: 1 });
  });
});

describe('wlContentImport', () => {
  it('refuses unforced duplicates and any error row', async ({ skip }) => {
    if (!dbAvailable) skip();
    await expect(svc.wlContentImport({ kind: 'true_false', sync_to_staging: false, force_indexes: [], questions: [tf('Zidane scored twice in the 1998 final.')] }, { id: undefined }))
      .rejects.toMatchObject({ statusCode: 400 });
    await expect(svc.wlContentImport({ kind: 'clue_chain', sync_to_staging: false, force_indexes: [0], questions: [clue('X', ['a'])] }, { id: undefined }))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it('publishes bilingual rows with expanded aliases inside a batch; monolingual rows stay draft', async ({ skip }) => {
    if (!dbAvailable) skip();
    const { batch_id } = await svc.wlContentImport({
      kind: 'career_path', note: 'test', sync_to_staging: false, force_indexes: [],
      questions: [
        career(['Ajax', 'Inter Milan', 'Arsenal'], 'Dennis Bergkamp'),
        pio('Order these players by PL goals (High to Low)', ['Shearer', 'Rooney', 'Agüero', 'Henry']),
        clue('Edwin van der Sar', ['one', 'two', 'three', 'four', 'five']),
        tf('UNTRANSLATABLE statement that will keep no Georgian.'),
      ],
    }, { id: undefined, email: 'editor@test' });
    batchIds.push(batch_id);
    const batch = await waitForBatch(batch_id);
    expect(batch.status).toBe('done');
    expect(batch.counts.published).toBe(3);
    expect(batch.counts.failed).toBe(1);
    const failed = batch.rows.find((r) => r.state === 'failed');
    expect(failed?.error).toMatch(/Georgian/);

    const ids = batch.rows.filter((r) => r.state === 'published').map((r) => r.question_id);
    const rows = await sql<Array<{ type: string; status: string; visibility: string; ranked_eligible: boolean; prompt: Record<string, string>; payload: Record<string, unknown> }>>`
      SELECT q.type, q.status, q.visibility, q.ranked_eligible, q.prompt, qp.payload FROM questions q JOIN question_payloads qp ON qp.question_id = q.id WHERE q.id = ANY(${sql.array(ids)}::uuid[])`;
    for (const r of rows) {
      expect(r.status).toBe('published');
      expect(r.visibility).toBe('wl_private');
      expect(r.ranked_eligible).toBe(false);
      expect(r.prompt['ka']).toBeTruthy();
    }
    const bergkamp = rows.find((r) => r.type === 'career_path')!;
    expect(bergkamp.payload['accepted_answers']).toEqual(expect.arrayContaining(['Bergkamp', 'Dennis Bergkamp', 'Dennis', 'Dennis Bergkamp ka']));
    const vds = rows.find((r) => r.type === 'clue_chain')!;
    expect(vds.payload['accepted_answers']).toEqual(expect.arrayContaining(['van der Sar', 'Sar', 'Edwin']));

    // The same content is now a pool duplicate for the next upload.
    const again = await svc.wlContentCheck([career(['Ajax', 'Arsenal'], 'Dennis Bergkamp')], { probeImages: false });
    expect(again.rows[0]!.status).toBe('duplicate');
  });

  it('undo deletes never-dealt rows and keeps dealt ones', async ({ skip }) => {
    if (!dbAvailable) skip();
    const { batch_id } = await svc.wlContentImport({
      kind: 'true_false', sync_to_staging: false, force_indexes: [],
      questions: [tf('Undo me one.'), tf('Undo me two, but I was dealt.')],
    }, { id: undefined });
    batchIds.push(batch_id);
    const batch = await waitForBatch(batch_id);
    const dealt = batch.rows.find((r) => r.summary.includes('dealt'))!;
    const [t] = await sql<{ id: string }[]>`INSERT INTO wl_tournaments (is_test, status, config) VALUES (true, 'content_pending', '{}'::jsonb) RETURNING id`;
    tournamentIds.push(t.id);
    await sql`INSERT INTO wl_questions (tournament_id, game_index, round_index, question_index, reserve_ordinal, kind, payload, evaluation, source_question_id)
              VALUES (${t.id}, 0, 0, 0, 0, 'true_false', '{}'::jsonb, '{}'::jsonb, ${dealt.question_id})`;
    const outcome = await svc.wlContentUndoBatch(batch_id, 'admin:test');
    expect(outcome).toMatchObject({ deleted: 1, kept: 1, kept_ids: [dealt.question_id] });
    const left = await sql<{ id: string }[]>`SELECT id FROM questions WHERE id = ANY(${sql.array(batch.rows.map((r) => r.question_id))}::uuid[])`;
    expect(left.map((r) => r.id)).toEqual([dealt.question_id]);
    const after = await svc.wlContentBatch(batch_id);
    expect(after.status).toBe('undone');
    expect(after.counts.deleted).toBe(1);
  });
});

describe('wlContentReseed', () => {
  it('restores the previous rows when the pool cannot fill the event, and refuses once play started', async ({ skip }) => {
    if (!dbAvailable) skip();
    const [t] = await sql<{ id: string }[]>`INSERT INTO wl_tournaments (is_test, status, config) VALUES (false, 'ready', '{}'::jsonb) RETURNING id`;
    tournamentIds.push(t.id);
    await sql`INSERT INTO wl_questions (tournament_id, game_index, round_index, question_index, reserve_ordinal, kind, payload, evaluation, source_question_id)
              VALUES (${t.id}, 0, 0, 0, 0, 'true_false', ${sql.json({ prompt: i18n('keep me') } as never)}, '{"correct_id":"true"}'::jsonb, NULL)`;
    // No wl_private stock for a full 4-game draw exists in this test DB → the seed comes back short.
    const out = await svc.wlContentReseed(t.id, 'admin:test');
    expect(out.ok).toBe(false);
    expect(out.previous_rows).toBe(1);
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM wl_questions WHERE tournament_id = ${t.id}`;
    expect(n).toBe(1);
    const [rs] = await sql<{ result: { ok: boolean; kept: number } }[]>`SELECT result FROM wl_content_reseeds WHERE id = ${out.reseed_id!}`;
    expect(rs.result).toMatchObject({ ok: false, kept: 1 });

    await sql`UPDATE wl_tournaments SET status = 'game_live' WHERE id = ${t.id}`;
    await expect(svc.wlContentReseed(t.id, 'admin:test')).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('wlContentScheduleBatch', () => {
  it('re-draws the event with the batch first and reports where each question landed', async ({ skip }) => {
    if (!dbAvailable) skip();
    // A full weekend of other stock, so the draw can complete (28/28/28/28/12).
    const bi = (node: unknown): unknown => {
      if (Array.isArray(node)) return node.map(bi);
      if (node && typeof node === 'object') {
        const rec = Object.fromEntries(Object.entries(node).map(([k, v]) => [k, bi(v)]));
        return 'en' in rec ? { ...rec, ka: `${rec['en']} ka` } : rec;
      }
      return node;
    };
    const stock = async (n: number, make: (i: number) => { type: string; prompt: { en: string }; payload: Record<string, unknown> }) => {
      for (let i = 0; i < n; i += 1) { const q = make(i); await seedPool(q.type, q.prompt.en, bi(q.payload) as Record<string, unknown>); }
    };
    await stock(28, (i) => tf(`Stock statement number ${i} for the schedule test.`));
    await stock(28, (i) => pio(`Stock ranking ${i}`, [`A${i}`, `B${i}`, `C${i}`, `D${i}`]));
    await stock(28, (i) => ({ type: 'mcq_single', prompt: { en: `Stock mcq ${i}?` }, payload: { type: 'mcq_single', options: ['w', 'x', 'y', 'z'].map((o, k) => ({ id: `${o}${i}`, text: { en: `${o}${i}` }, is_correct: k === 0 })) } }));
    await stock(28, (i) => career([`Club${i}a`, `Club${i}b`], `Player Stock${i}`));
    await stock(12, (i) => clue(`Mystery Stock${i}`, ['one', 'two', 'three', 'four', 'five']));

    const { batch_id } = await svc.wlContentImport({
      kind: 'true_false', sync_to_staging: false, force_indexes: [],
      questions: ['first', 'second', 'third', 'fourth', 'fifth', 'sixth'].map((n) => tf(`Schedule me ${n}, please.`)),
    }, { id: undefined });
    batchIds.push(batch_id);
    expect((await waitForBatch(batch_id)).counts.published).toBe(6);

    const [t] = await sql<{ id: string }[]>`INSERT INTO wl_tournaments (is_test, status, week_key, config) VALUES (false, 'entry_open', '2099-01-03', '{}'::jsonb) RETURNING id`;
    tournamentIds.push(t.id);
    const out = await svc.wlContentScheduleBatch(batch_id, 'admin:test', t.id);
    // Six: all main slots — Game 1's five, then Game 2's first — never a reserve while a main slot is free.
    expect(out).toMatchObject({ ok: true, week_key: '2099-01-03', placed_main: 6, placed_reserve: 0, not_placed: 0 });

    const detail = await svc.wlContentBatch(batch_id);
    const spots = detail.rows.map((r) => r.placements[0]!).map((p) => [p.game_index, p.round_index, p.question_index, p.reserve_ordinal]).sort();
    expect(spots).toEqual([[0, 0, 0, 0], [0, 0, 1, 0], [0, 0, 2, 0], [0, 0, 3, 0], [0, 0, 4, 0], [1, 0, 0, 0]]);

    // While a schedule holds its claim, undo waits its turn (409); an expired claim does not block.
    await sql`UPDATE wl_content_batches SET result = result || ${sql.json({ scheduling: { token: 't', at: new Date().toISOString() } } as never)} WHERE id = ${batch_id}`;
    await expect(svc.wlContentUndoBatch(batch_id, 'admin:test')).rejects.toMatchObject({ statusCode: 409 });
    await expect(svc.wlContentScheduleBatch(batch_id, 'admin:test', t.id)).rejects.toMatchObject({ statusCode: 409 });
    await sql`UPDATE wl_content_batches SET result = result || ${sql.json({ scheduling: { token: 't', at: '2000-01-01T00:00:00Z' } } as never)} WHERE id = ${batch_id}`;

    // A re-draw whose claim was lost (expired and taken over, or the batch undone) commits nothing.
    const before = await sql<{ source_question_id: string }[]>`SELECT source_question_id FROM wl_questions WHERE tournament_id = ${t.id} ORDER BY source_question_id`;
    await expect(svc.wlContentReseed(t.id, 'admin:test', [], { batchId: batch_id, token: 'not-the-owner' })).rejects.toMatchObject({ statusCode: 409 });
    const after = await sql<{ source_question_id: string }[]>`SELECT source_question_id FROM wl_questions WHERE tournament_id = ${t.id} ORDER BY source_question_id`;
    expect(after).toEqual(before);

    // A dealt batch is kept by undo (and the re-draw backup protects it too).
    const undo = await svc.wlContentUndoBatch(batch_id, 'admin:test');
    expect(undo).toMatchObject({ deleted: 0, kept: 6 });
    await sql`DELETE FROM wl_content_reseeds WHERE tournament_id = ${t.id}`;
  });
});

describe('wlContentRunway', () => {
  it('reports per-kind need and counts', async ({ skip }) => {
    if (!dbAvailable) skip();
    const runway = await svc.wlContentRunway();
    expect(runway.need_per_event['true_false']).toBe(28);
    expect(runway.need_per_event['who_am_i']).toBe(12);
    expect(runway.drawable.find((d) => d.kind === 'true_false')?.need).toBe(28);
  });
});
