/**
 * Builds a ორშაბათობა show pack from Weekend League questions already in the database (hard ones only), so a show
 * night can run without hand-written questions. Writes the pack JSON to --out (keep it OUT of this public repo:
 * it holds answer keys), then load it with scripts/wl-show-pack-load.ts.
 *
 *   npx tsx scripts/wl-show-pack-from-bank.ts --date 2026-11-23 --out /private/path/pack.json
 *
 * Layout: two games of 3 true/false, 2 multiple choice, 1 put in order, 1 career path, 1 who am I (top 50% go
 * through after game 1, top 10 after game 2), then a final of the 5 hardest multiple-choice questions: hard ones
 * players got wrong most often in past Weekend League games. No question repeats. Answer text is never printed.
 */
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import postgres from 'postgres';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const date = arg('date');
const out = arg('out');
if (!date || !out) {
  console.error('usage: --date YYYY-MM-DD --out <file outside the repo>');
  process.exit(1);
}

const sql = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });

type Row = { source_question_id: string; payload: Record<string, unknown>; evaluation: Record<string, unknown>; wrong_rate: number | null };

const used = new Set<string>();

/** Hard questions of one kind, one copy per source question, hardest (most often missed) first when asked. */
async function pick(kind: string, n: number, hardestFirst: boolean): Promise<Row[]> {
  const rows = await sql<Row[]>`
    WITH latest AS (
      SELECT DISTINCT ON (w.source_question_id) w.question_id, w.source_question_id, w.payload, w.evaluation
      FROM wl_questions w
      JOIN questions q ON q.id = w.source_question_id
      WHERE w.kind = ${kind} AND q.difficulty = 'hard' AND w.source_question_id IS NOT NULL
        -- Never protected stock that hasn't been played yet (it may be seeded for an upcoming prize event): public
        -- questions, or ones already asked in a finished Weekend League game.
        AND (q.visibility = 'public' OR EXISTS (
          SELECT 1 FROM wl_questions pw
          JOIN wl_question_runs pr ON pr.question_id = pw.question_id AND pr.status IN ('revealed', 'frozen')
          JOIN wl_tournaments pt ON pt.id = pw.tournament_id AND pt.status = 'completed'
          WHERE pw.source_question_id = q.id
        ))
      ORDER BY w.source_question_id, w.created_at DESC
    ),
    stats AS (
      SELECT w.source_question_id, AVG(CASE WHEN a.correct THEN 0 ELSE 1 END)::float AS wrong_rate, COUNT(*)::int AS answers
      FROM wl_answers a
      JOIN wl_question_runs r ON r.attempt_id = a.attempt_id
      JOIN wl_questions w ON w.question_id = r.question_id
      WHERE w.kind = ${kind}
      GROUP BY w.source_question_id
    )
    SELECT l.source_question_id, l.payload, l.evaluation,
           CASE WHEN s.answers >= 10 THEN s.wrong_rate END AS wrong_rate
    FROM latest l LEFT JOIN stats s ON s.source_question_id = l.source_question_id
    ORDER BY ${hardestFirst ? sql`(CASE WHEN s.answers >= 10 THEN s.wrong_rate END) DESC NULLS LAST,` : sql``} random()
    LIMIT ${n * 6}
  `;
  const picked: Row[] = [];
  for (const r of rows) {
    if (picked.length >= n) break;
    if (used.has(r.source_question_id)) continue;
    if (!usable(kind, r)) continue;
    used.add(r.source_question_id);
    picked.push(r);
  }
  if (picked.length < n) throw new Error(`only ${picked.length}/${n} usable hard ${kind} questions`);
  return picked;
}

const ka = (v: unknown): string => (v && typeof v === 'object' ? String((v as Record<string, unknown>)['ka'] ?? '') : '');
const text = (v: unknown) => {
  const o = (v ?? {}) as Record<string, unknown>;
  const k = String(o['ka'] ?? '').trim();
  const e = String(o['en'] ?? '').trim();
  return e ? { ka: k, en: e } : { ka: k };
};

function usable(kind: string, r: Row): boolean {
  const p = r.payload;
  if (kind === 'true_false') return ka(p['prompt']).trim() !== '' && ['true', 'false'].includes(String(r.evaluation['correct_id']));
  if (kind === 'mcq') {
    const opts = Array.isArray(p['options']) ? (p['options'] as Array<Record<string, unknown>>) : [];
    return ka(p['prompt']).trim() !== '' && opts.length >= 2 && opts.length <= 6
      && opts.every((o) => ka(o['text']).trim() !== '')
      && opts.some((o) => String(o['id']) === String(r.evaluation['correct_id']));
  }
  // Weekend League kinds are played exactly as stored; just make sure the Georgian text is there.
  if (kind === 'put_in_order') return Array.isArray(p['items']) && (p['items'] as unknown[]).length >= 3;
  const accepted = Array.isArray(r.evaluation['accepted_answers']) && (r.evaluation['accepted_answers'] as unknown[]).length > 0;
  if (kind === 'career_path') return accepted && Array.isArray(p['clubs']) && (p['clubs'] as unknown[]).length >= 2;
  if (kind === 'who_am_i') return accepted && Array.isArray(p['clues']) && (p['clues'] as unknown[]).length >= 5;
  return false;
}

function tf(r: Row) {
  return { prompt: text(r.payload['prompt']), correct: String(r.evaluation['correct_id']) };
}
function mcq(r: Row) {
  const image = r.payload['image'] as { url?: string } | null | undefined;
  // Option ids become a, b, c… (the pack format's short ids); the correct one is mapped the same way.
  const opts = r.payload['options'] as Array<Record<string, unknown>>;
  const ids = 'abcdef';
  const correctAt = opts.findIndex((o) => String(o['id']) === String(r.evaluation['correct_id']));
  return {
    prompt: text(r.payload['prompt']),
    options: opts.map((o, i) => ({ id: ids[i]!, text: text(o['text']) })),
    correct: ids[correctAt]!,
    ...(image?.url && /^(https:\/\/|\/)\S+$/.test(image.url) ? { image: image.url } : {}),
  };
}
function wl(r: Row) {
  const prompt = ka(r.payload['prompt']).trim();
  return {
    prompt: prompt ? text(r.payload['prompt']) : { ka: '—' },
    wl: { payload: r.payload, evaluation: r.evaluation, source_question_id: r.source_question_id },
  };
}

async function game(n: number, cut: { keep_percent: number } | { keep_count: number }) {
  const label = (s: string) => ({ ka: `თამაში ${n} · ${s}` });
  return [
    { kind: 'true_false', title: label('მართალია თუ მცდარი'), questions: (await pick('true_false', 3, false)).map(tf) },
    { kind: 'mcq', title: label('ვიქტორინა'), questions: (await pick('mcq', 2, false)).map(mcq) },
    { kind: 'put_in_order', title: label('დაალაგე'), questions: (await pick('put_in_order', 1, false)).map(wl) },
    { kind: 'career_path', title: label('კარიერა'), questions: (await pick('career_path', 1, false)).map(wl) },
    { kind: 'who_am_i', title: label('ვინ ვარ მე?'), questions: (await pick('who_am_i', 1, false)).map(wl), cut },
  ];
}

// The final first: it takes the very hardest multiple choice before the games draw theirs.
const final = { kind: 'mcq', title: { ka: 'ფინალი' }, questions: (await pick('mcq', 5, true)).map(mcq) };
const pack = {
  slug: 'orshabatoba',
  eventDate: date,
  rounds: [...(await game(1, { keep_percent: 50 })), ...(await game(2, { keep_count: 10 })), final],
};
writeFileSync(out, JSON.stringify(pack, null, 1));
console.log(`[show-pack-from-bank] ${pack.rounds.length} rounds, ${pack.rounds.reduce((n, r) => n + r.questions.length, 0)} questions -> ${out}`);
await sql.end();
