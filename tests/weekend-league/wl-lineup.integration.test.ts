/**
 * WL lineup upload against the local DB: preview → save places the exact
 * previewed slots of the chosen games and nothing else; any change to the
 * weekend or any failed row saves nothing. Translation is mocked (fills ka
 * from en, except rows marked NO_KA).
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
        if (!row || String(row.prompt['en']).includes('NO_KA')) continue;
        await sql`UPDATE questions SET prompt = ${sql.json(fill(row.prompt) as never)} WHERE id = ${id}`;
        await sql`UPDATE question_payloads SET payload = ${sql.json(fill(row.payload) as never)} WHERE question_id = ${id}`;
      }
      return { translated: ids.length, skipped: 0, failed: 0 };
    },
  },
}));

type Svc = typeof import('../../src/modules/weekend-league/wl-content.service.js');
type Lineup = typeof import('../../src/modules/weekend-league/wl-lineup.service.js');
let sql: typeof import('../../src/db/index.js').sql;
let svc: Svc;
let lineup: Lineup;
let dbAvailable = false;
let categoryId = '';
const stockIds: string[] = [];
const tournamentIds: string[] = [];
const WL_TEST_LOCK = 774431002;
let lockConn: Awaited<ReturnType<typeof sql.reserve>> | null = null;
const TAG = Date.now().toString(36);

const bi = (node: unknown): unknown => {
  if (Array.isArray(node)) return node.map(bi);
  if (node && typeof node === 'object') {
    const rec = Object.fromEntries(Object.entries(node).map(([k, v]) => [k, bi(v)]));
    return typeof rec['en'] === 'string' ? { ...rec, ka: `${rec['en']} ka` } : rec;
  }
  return node;
};

type Q = { type: string; difficulty: 'easy' | 'medium' | 'hard'; status: 'draft'; explanation: null; prompt: { en: string }; payload: Record<string, unknown> };
const tf = (t: string): Q => ({ type: 'true_false', difficulty: 'medium', status: 'draft', explanation: null, prompt: { en: t },
  payload: { type: 'true_false', options: [{ id: 'true', text: { en: 'True' }, is_correct: true }, { id: 'false', text: { en: 'False' }, is_correct: false }] } });
const pio = (t: string): Q => ({ type: 'put_in_order', difficulty: 'easy', status: 'draft', explanation: null, prompt: { en: t },
  payload: { type: 'put_in_order', prompt: { en: t }, direction: 'asc', items: ['a', 'b', 'c', 'd'].map((x, i) => ({ id: `i${i}`, label: { en: `${t} ${x}` }, details: null, emoji: null, sort_value: i + 1 })) } });
const mcq = (t: string, image = false): Q => ({ type: 'mcq_single', difficulty: 'medium', status: 'draft', explanation: null, prompt: { en: t },
  payload: { type: 'mcq_single', ...(image ? { image: { url: 'https://example.com/stock.png', width: 1440, height: 1080 } } : {}),
    options: ['w', 'x', 'y', 'z'].map((o, k) => ({ id: `${o}`, text: { en: `${t} ${o}` }, is_correct: k === 0 })) } });
const career = (t: string): Q => ({ type: 'career_path', difficulty: 'hard', status: 'draft', explanation: null, prompt: { en: 'Whose career path is this?' },
  payload: { type: 'career_path', clubs: [{ en: `${t} A` }, { en: `${t} B` }], display_answer: { en: `Player ${t}` }, accepted_answers: [`Player ${t}`] } });
const clue = (t: string): Q => ({ type: 'clue_chain', difficulty: 'hard', status: 'draft', explanation: null, prompt: { en: 'Who am I?' },
  payload: { type: 'clue_chain', display_answer: { en: `Mystery ${t}` }, accepted_answers: [`Mystery ${t}`], clues: [1, 2, 3, 4, 5].map((c) => ({ type: 'text', content: { en: `${t} clue ${c}` } })) } });

type Slot = { game_index: number; round_index: number | null; question_index: number | null; reserve_ordinal: number };
/** A full game: 21 main questions at their slots. */
function gameUpload(g: number, tag: string): { questions: Q[]; slots: Slot[] } {
  const questions: Q[] = []; const slots: Slot[] = [];
  const add = (q: Q, round: number, qi: number) => { questions.push(q); slots.push({ game_index: g, round_index: round, question_index: qi, reserve_ordinal: 0 }); };
  for (let i = 0; i < 5; i += 1) add(tf(`${tag} g${g} statement ${i}`), 0, i);
  for (let i = 0; i < 5; i += 1) add(pio(`${tag} g${g} ranking ${i}`), 1, i);
  for (let i = 0; i < 5; i += 1) add(mcq(`${tag} g${g} question ${i}`), 2, i);
  for (let i = 0; i < 5; i += 1) add(career(`${tag}g${g}c${i}`), 3, i);
  add(clue(`${tag}g${g}w`), 4, 0);
  return { questions, slots };
}
function merge(...parts: Array<{ questions: Q[]; slots: Slot[] }>) { return { questions: parts.flatMap((p) => p.questions), slots: parts.flatMap((p) => p.slots) }; }

async function seed(q: Q, image = false): Promise<void> {
  const payload = bi(image ? mcq(q.prompt.en, true).payload : q.payload);
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO questions (category_id, type, difficulty, status, ranked_eligible, visibility, prompt)
    VALUES (${categoryId}, ${q.type}, 'medium', 'published', false, 'wl_private', ${sql.json(bi(q.prompt) as never)}) RETURNING id`;
  await sql`INSERT INTO question_payloads (question_id, payload) VALUES (${row!.id}, ${sql.json(payload as never)})`;
  stockIds.push(row!.id);
}

async function newEvent(week: string): Promise<string> {
  const [t] = await sql<{ id: string }[]>`INSERT INTO wl_tournaments (is_test, status, week_key, config) VALUES (false, 'entry_open', ${week}, '{}'::jsonb) RETURNING id`;
  tournamentIds.push(t!.id);
  const drawn = await svc.wlContentReseed(t!.id, 'admin:test');
  if (!drawn.ok) throw new Error(`stock too thin: ${JSON.stringify(drawn.shortages)}`);
  return t!.id;
}

const rowsOf = (tid: string, games: number[]) => sql<Array<Record<string, unknown>>>`
  SELECT question_id, game_index, round_index, question_index, reserve_ordinal, kind, payload, evaluation, source_question_id
  FROM wl_questions WHERE tournament_id = ${tid} AND game_index = ANY(${sql.array(games)}::int[])
  ORDER BY game_index, reserve_ordinal, round_index, question_index, kind`;

async function waitBatch(id: string) {
  for (let i = 0; i < 300; i += 1) {
    const b = await svc.wlContentBatch(id);
    if (b.status !== 'processing') return b;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('batch did not finish');
}

async function previewAndSave(tid: string, scope: string, upload: { questions: Q[]; slots: Slot[] }) {
  const preview = await lineup.wlLineupPreview({ tournament_id: tid, scope, questions: upload.questions as never, slots: upload.slots, force_indexes: [] }, {});
  expect(preview.problems).toEqual([]);
  expect(preview.preview_id).toBeTruthy();
  const saved = await lineup.wlLineupSave(preview.preview_id!, { email: 'editor@test' });
  return { preview, saved, batch: await waitBatch(saved.batch_id) };
}

beforeAll(async () => {
  try {
    sql = (await import('../../src/db/index.js')).sql;
    await sql`SELECT 1`;
    await sql`SELECT 1 FROM wl_content_lineup_previews LIMIT 0`;
    svc = await import('../../src/modules/weekend-league/wl-content.service.js');
    lineup = await import('../../src/modules/weekend-league/wl-lineup.service.js');
    lockConn = await sql.reserve();
    await lockConn`SELECT pg_advisory_lock(${WL_TEST_LOCK})`;
    const [cat] = await sql<{ id: string }[]>`SELECT id FROM categories WHERE slug = ${svc.WL_CONTENT_CATEGORY_SLUG}`;
    if (!cat) throw new Error('WL category missing in the test DB');
    categoryId = cat.id;
    // Every test event is a real (non-test) weekend, so its draw blocks reuse for 35 days: stock for six events plus reserves.
    for (let i = 0; i < 230; i += 1) {
      await seed(tf(`stock ${TAG} statement ${i}`));
      await seed(pio(`stock ${TAG} ranking ${i}`));
      await seed(mcq(`stock ${TAG} question ${i}`), true);
      await seed(career(`stock${TAG}c${i}`));
      if (i < 90) await seed(clue(`stock${TAG}w${i}`));
    }
    dbAvailable = true;
  } catch (err) {
    console.warn('\n⚠️  Skipping WL lineup tests: DB unavailable.', err instanceof Error ? err.message : err, '\n');
    if (lockConn) { await lockConn`SELECT pg_advisory_unlock(${WL_TEST_LOCK})`.catch(() => {}); lockConn.release(); lockConn = null; }
  }
}, 180_000);

afterAll(async () => {
  if (!dbAvailable) return;
  const batchQuestions = await sql<{ id: string; batch_id: string }[]>`
    SELECT r.question_id AS id, r.batch_id FROM wl_content_batch_rows r JOIN wl_content_batches b ON b.id = r.batch_id
    WHERE b.kind = 'lineup' AND b.created_at > NOW() - interval '1 hour' AND r.question_id IS NOT NULL`;
  if (tournamentIds.length) await sql`DELETE FROM wl_tournaments WHERE id = ANY(${sql.array(tournamentIds)}::uuid[])`;
  const ids = [...stockIds, ...batchQuestions.map((r) => r.id)];
  if (ids.length) await sql`DELETE FROM questions WHERE id = ANY(${sql.array(ids)}::uuid[])`;
  await sql`DELETE FROM wl_content_batches WHERE kind = 'lineup' AND created_at > NOW() - interval '1 hour'`;
  if (lockConn) { await lockConn`SELECT pg_advisory_unlock(${WL_TEST_LOCK})`.catch(() => {}); lockConn.release(); }
  await sql.end({ timeout: 5 });
});

describe('wlLineupPreview', () => {
  it('reports structure problems, then previews one game with pool reserves and what it replaces', async ({ skip }) => {
    if (!dbAvailable) skip();
    const tid = await newEvent('2099-03-07');
    const short = gameUpload(1, `${TAG}p`);
    short.questions.splice(0, 1); short.slots.splice(0, 1);
    const bad = await lineup.wlLineupPreview({ tournament_id: tid, scope: 'game_1', questions: short.questions as never, slots: short.slots, force_indexes: [] }, {});
    expect(bad.preview_id).toBeNull();
    expect(bad.problems.map((p) => p.message).join('\n')).toMatch(/4 questions — this round needs exactly 5/);

    const wrongGame = gameUpload(2, `${TAG}p`);
    const outside = await lineup.wlLineupPreview({ tournament_id: tid, scope: 'game_1', questions: wrongGame.questions as never, slots: wrongGame.slots, force_indexes: [] }, {});
    expect(outside.problems.some((p) => /not part of the chosen upload/.test(p.message))).toBe(true);

    const good = gameUpload(1, `${TAG}p`);
    const ok = await lineup.wlLineupPreview({ tournament_id: tid, scope: 'game_1', questions: good.questions as never, slots: good.slots, force_indexes: [] }, {});
    expect(ok.problems).toEqual([]);
    expect(ok.preview_id).toBeTruthy();
    expect(ok.kept_games).toEqual([0, 2, 3]);
    expect(ok.replaced).toHaveLength(1);
    expect(ok.replaced[0]!.rows).toHaveLength(31);
    const pool = ok.slots.filter((s) => s.origin === 'pool');
    expect(pool).toHaveLength(10);
    expect(new Set(pool.map((s) => `${s.kind}:${s.reserve_ordinal}`)).size).toBe(10);
    // Never a question the kept or replaced games already use.
    const eventSources = new Set((await rowsOf(tid, [0, 1, 2, 3])).map((r) => r['source_question_id']));
    for (const s of pool) expect(eventSources.has((s.view as { source_question_id: string }).source_question_id)).toBe(false);
  });
});

describe('wlLineupSave', () => {
  it('saves one game at the exact previewed slots and leaves the other games byte-identical; undo keeps scheduled questions', async ({ skip }) => {
    if (!dbAvailable) skip();
    const tid = await newEvent('2099-03-14');
    const before = await rowsOf(tid, [0, 2, 3]);
    const upload = gameUpload(1, `${TAG}s`);
    const { preview, batch } = await previewAndSave(tid, 'game_1', upload);
    expect(batch.status).toBe('done');
    expect(await rowsOf(tid, [0, 2, 3])).toEqual(before);

    const game = await rowsOf(tid, [1]);
    expect(game).toHaveLength(31);
    const detail = await svc.wlContentBatch(batch.id);
    const idByRow = new Map(detail.rows.map((r) => [r.row_index, r.question_id]));
    upload.slots.forEach((s, i) => {
      const row = game.find((r) => r['round_index'] === s.round_index && r['question_index'] === s.question_index && r['reserve_ordinal'] === 0)!;
      expect(row['source_question_id']).toBe(idByRow.get(i));
    });
    for (const p of preview.slots.filter((s) => s.origin === 'pool')) {
      const row = game.find((r) => r['kind'] === p.kind && r['reserve_ordinal'] === p.reserve_ordinal)!;
      expect(row['source_question_id']).toBe((p.view as { source_question_id: string }).source_question_id);
    }
    expect(detail.lineup!.slots).toHaveLength(31);
    expect(detail.lineup!.slots.every((s) => s.current)).toBe(true);
    const next = await svc.wlContentNextEvent(tid);
    expect(next.games[1]!.rounds[0]!.played.map((q) => q.source_question_id)).toEqual(upload.slots.slice(0, 5).map((_, i) => idByRow.get(i)));

    const undo = await svc.wlContentUndoBatch(batch.id, 'admin:test');
    expect(undo).toMatchObject({ deleted: 0, kept: 21 });
    // "Use in next weekend" never re-draws around a lineup batch.
    await expect(svc.wlContentScheduleBatch(batch.id, 'admin:test', tid)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('places a whole weekend including uploaded reserves; Saturday alone keeps Sunday', async ({ skip }) => {
    if (!dbAvailable) skip();
    const tid = await newEvent('2099-03-21');
    const reserves = { questions: [career(`${TAG}r1`), career(`${TAG}r2`)], slots: [
      { game_index: 0, round_index: null, question_index: null, reserve_ordinal: 1 }, { game_index: 0, round_index: null, question_index: null, reserve_ordinal: 2 }] };
    const all = merge(gameUpload(0, `${TAG}w`), gameUpload(1, `${TAG}w`), gameUpload(2, `${TAG}w`), gameUpload(3, `${TAG}w`), reserves);
    const { preview, batch } = await previewAndSave(tid, 'weekend', all);
    expect(batch.status).toBe('done');
    expect(preview.slots.filter((s) => s.origin === 'pool')).toHaveLength(38);
    const rows = await rowsOf(tid, [0, 1, 2, 3]);
    expect(rows).toHaveLength(124);
    const ids = new Map((await svc.wlContentBatch(batch.id)).rows.map((r) => [r.row_index, r.question_id]));
    const res = rows.filter((r) => r['game_index'] === 0 && r['kind'] === 'career_path' && Number(r['reserve_ordinal']) > 0);
    expect(res.map((r) => r['source_question_id']).sort()).toEqual([ids.get(84), ids.get(85)].sort());

    const sunday = await rowsOf(tid, [3]);
    const sat = merge(gameUpload(0, `${TAG}x`), gameUpload(1, `${TAG}x`), gameUpload(2, `${TAG}x`));
    const second = await previewAndSave(tid, 'saturday', sat);
    expect(second.batch.status).toBe('done');
    expect(await rowsOf(tid, [3])).toEqual(sunday);
  });

  it('refuses to save when the weekend changed after the preview, and returns the same batch on a retry', async ({ skip }) => {
    if (!dbAvailable) skip();
    const tid = await newEvent('2099-03-28');
    const upload = gameUpload(3, `${TAG}c`);
    const p1 = await lineup.wlLineupPreview({ tournament_id: tid, scope: 'game_3', questions: upload.questions as never, slots: upload.slots, force_indexes: [] }, {});
    await svc.wlContentReseed(tid, 'admin:test');
    await expect(lineup.wlLineupSave(p1.preview_id!, {})).rejects.toMatchObject({ statusCode: 409 });

    const p2 = await lineup.wlLineupPreview({ tournament_id: tid, scope: 'game_3', questions: upload.questions as never, slots: upload.slots, force_indexes: [] }, {});
    const a = await lineup.wlLineupSave(p2.preview_id!, {});
    const b = await lineup.wlLineupSave(p2.preview_id!, {});
    expect(b).toMatchObject({ batch_id: a.batch_id, already_started: true });
    expect((await waitBatch(a.batch_id)).status).toBe('done');

    const p3 = await lineup.wlLineupPreview({ tournament_id: tid, scope: 'game_3', questions: gameUpload(3, `${TAG}e`).questions as never, slots: upload.slots, force_indexes: [] }, {});
    await sql`UPDATE wl_content_lineup_previews SET expires_at = NOW() - interval '1 minute' WHERE id = ${p3.preview_id!}`;
    await expect(lineup.wlLineupSave(p3.preview_id!, {})).rejects.toMatchObject({ statusCode: 409 });
    // Long-expired, never-saved previews are purged on the next preview; saved ones are kept.
    await sql`UPDATE wl_content_lineup_previews SET expires_at = NOW() - interval '2 hours' WHERE id = ${p3.preview_id!}`;
    await lineup.wlLineupPreview({ tournament_id: tid, scope: 'game_3', questions: gameUpload(3, `${TAG}e`).questions as never, slots: upload.slots, force_indexes: [] }, {});
    const left = await sql<{ id: string }[]>`SELECT id FROM wl_content_lineup_previews WHERE id = ANY(${sql.array([p3.preview_id!, p2.preview_id!])}::uuid[])`;
    expect(left.map((r) => r.id)).toEqual([p2.preview_id]);
  });

  it('saves nothing when the weekend changes while saving; drafts are removed', async ({ skip }) => {
    if (!dbAvailable) skip();
    const tid = await newEvent('2099-04-04');
    const upload = gameUpload(0, `${TAG}r`);
    const p = await lineup.wlLineupPreview({ tournament_id: tid, scope: 'game_0', questions: upload.questions as never, slots: upload.slots, force_indexes: [] }, {});
    let batchId = '';
    // Hold the event row: the save's final transaction waits for it; meanwhile we change a kept game.
    await sql.begin(async (tx) => {
      await tx`SELECT id FROM wl_tournaments WHERE id = ${tid} FOR UPDATE`;
      batchId = (await lineup.wlLineupSave(p.preview_id!, {})).batch_id;
      for (let i = 0; i < 200; i += 1) {
        const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM wl_content_batch_rows WHERE batch_id = ${batchId} AND state = 'translated'`;
        if (n === 21) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      await tx`UPDATE wl_questions SET payload = payload || '{"edited": true}'::jsonb
               WHERE question_id = (SELECT question_id FROM wl_questions WHERE tournament_id = ${tid} AND game_index = 2 LIMIT 1)`;
    });
    const batch = await waitBatch(batchId);
    expect(batch.status).toBe('failed');
    expect(batch.error).toMatch(/Nothing was scheduled.*changed/);
    const left = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM wl_content_batch_rows WHERE batch_id = ${batchId} AND question_id IS NOT NULL`;
    expect(left[0]!.n).toBe(0);
    const game0 = await rowsOf(tid, [0]);
    const uploaded = new Set((await sql<{ id: string }[]>`SELECT id FROM questions WHERE prompt->>'en' LIKE ${`${TAG}r g0 %`}`).map((r) => r.id));
    expect(game0.some((r) => uploaded.has(String(r['source_question_id'])))).toBe(false);
  });

  it('refuses a draft edited while saving, and a kept game holding a wrong-type question', async ({ skip }) => {
    if (!dbAvailable) skip();
    const tid = await newEvent('2099-04-18');
    const upload = gameUpload(1, `${TAG}d`);
    const p = await lineup.wlLineupPreview({ tournament_id: tid, scope: 'game_1', questions: upload.questions as never, slots: upload.slots, force_indexes: [] }, {});
    let batchId = '';
    await sql.begin(async (tx) => {
      await tx`SELECT id FROM wl_tournaments WHERE id = ${tid} FOR UPDATE`;
      batchId = (await lineup.wlLineupSave(p.preview_id!, {})).batch_id;
      for (let i = 0; i < 200; i += 1) {
        const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM wl_content_batch_rows WHERE batch_id = ${batchId} AND state = 'translated'`;
        if (n === 21) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      // Someone edits a prepared draft (drops an item from a put-in-order question) before the commit.
      const [row] = await sql<{ question_id: string }[]>`SELECT question_id FROM wl_content_batch_rows WHERE batch_id = ${batchId} AND row_index = 5`;
      await sql`UPDATE question_payloads SET payload = jsonb_set(payload, '{items}', (payload->'items') - 3) WHERE question_id = ${row!.question_id}`;
    });
    const batch = await waitBatch(batchId);
    expect(batch.status).toBe('failed');
    expect(batch.error).toMatch(/edited while saving/);

    // Swap a kept game's Round 2 row kind: a partial upload must refuse to keep that game.
    await sql`UPDATE wl_questions SET kind = 'mcq' WHERE tournament_id = ${tid} AND game_index = 0 AND round_index = 1 AND question_index = 0`;
    const bad = await lineup.wlLineupPreview({ tournament_id: tid, scope: 'game_1', questions: gameUpload(1, `${TAG}d2`).questions as never, slots: upload.slots, force_indexes: [] }, {});
    expect(bad.preview_id).toBeNull();
    expect(bad.problems.map((x) => x.message).join('\n')).toMatch(/Saturday Game 1 has a Photo question in Round 2/);
  });

  it('saves nothing when one question cannot be prepared, and is locked once check-in starts', async ({ skip }) => {
    if (!dbAvailable) skip();
    const tid = await newEvent('2099-04-11');
    const before = await rowsOf(tid, [0, 1, 2, 3]);
    const upload = gameUpload(2, `${TAG}k`);
    upload.questions[3] = tf(`${TAG}k NO_KA statement without Georgian`);
    const { batch } = await previewAndSave(tid, 'game_2', upload);
    expect(batch.status).toBe('failed');
    expect(batch.rows.find((r) => r.row_index === 3)?.error).toMatch(/Georgian/);
    expect(await rowsOf(tid, [0, 1, 2, 3])).toEqual(before);
    const drafts = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM questions WHERE prompt->>'en' LIKE ${`${TAG}k %`}`;
    expect(drafts[0]!.n).toBe(0);

    await sql`UPDATE wl_tournaments SET status = 'checkin' WHERE id = ${tid}`;
    const events = await lineup.wlLineupEvents();
    expect(events.find((e) => e.id === tid)).toMatchObject({ editable: false });
    const locked = await lineup.wlLineupPreview({ tournament_id: tid, scope: 'game_2', questions: gameUpload(2, `${TAG}l`).questions as never, slots: upload.slots, force_indexes: [] }, {});
    expect(locked.preview_id).toBeNull();
    expect(locked.problems[0]!.message).toMatch(/can't be changed now/);
  });
});
