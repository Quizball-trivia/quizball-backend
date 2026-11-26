import { config } from '../../core/config.js';
import { ConflictError, NotFoundError, ValidationError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import { sql } from '../../db/index.js';
import { orshabatobaEpisode, orshabatobaNextDate } from '../weekend-league/orshabatoba-history.js';
import { lockShowNight } from '../weekend-league/show-packs/index.js';
import { redactedIssues, showPackHash, showPackSchema, SHOW_PACK_SLUGS, type ShowPack } from '../weekend-league/show-packs/show-pack.js';
import { KIND_TO_SOURCE, payloadFullyBilingual, splitSource, type SourceRow } from '../weekend-league/wl-seeder.js';
import { wlHostRunShowAt } from '../weekend-league/wl-week.js';

// The weekly ორშაბათობა show pack, prepared by the hub ahead of each show
// Monday (table harness.show_packs):
//   1. this module builds a pack from the public question bank, never
//      repeating a question an earlier show used;
//   2. the Show Checker agent (harness worker, job kind show_check) verifies
//      every question; flagged ones are swapped here and checked again;
//   3. a person reads the pack in the CMS, swaps what they don't like and
//      approves it; approving loads it into wl_show_packs, which is what the
//      show plays. The hosts read these questions out live, so this is the
//      one place in the hub where a person approves.

type Db = typeof sql;

const SLUG = SHOW_PACK_SLUGS[0];
export type ShowQuestionKind = 'true_false' | 'mcq' | 'put_in_order' | 'career_path' | 'who_am_i';
type Text = { ka: string; en?: string };

/** One show night: two games (top 50% go through, then the top 10) and a final. Same layout as scripts/wl-show-pack-from-bank.ts. */
export const SHOW_LAYOUT: ReadonlyArray<{ kind: ShowQuestionKind; count: number; title: Text; cut?: { keep_percent: number } | { keep_count: number } }> = [
  ...game(1, { keep_percent: 50 }),
  ...game(2, { keep_count: 10 }),
  { kind: 'mcq', count: 5, title: { ka: 'ფინალი' } },
];
function game(n: number, cut: { keep_percent: number } | { keep_count: number }) {
  const title = (s: string): Text => ({ ka: `თამაში ${n} · ${s}` });
  return [
    { kind: 'true_false' as const, count: 3, title: title('მართალია თუ მცდარი') },
    { kind: 'mcq' as const, count: 2, title: title('ვიქტორინა') },
    { kind: 'put_in_order' as const, count: 1, title: title('დაალაგე') },
    { kind: 'career_path' as const, count: 1, title: title('კარიერა') },
    { kind: 'who_am_i' as const, count: 1, title: title('ვინ ვარ მე?'), cut },
  ];
}

/** A question as a person (and the checker) reads it. */
export interface ShowQuestionView {
  prompt: Text | null;
  image: string | null;
  /** Multiple choice only. */
  options: Array<{ text: Text; correct: boolean }>;
  /** What the hosts announce; null for put in order (the lines are the answer). */
  answer: Text | null;
  /** Put in order: the items in the right order. Career path: the clubs. Who am I: the clues. */
  lines: Text[];
  /** Put in order: the extra line players see under the question (e.g. which way to order), when there is one. */
  instruction?: Text;
}
export type ShowCheck = 'unchecked' | 'ok' | 'flagged' | 'skipped';
export interface ShowQuestionMeta {
  round: number;
  question: number;
  kind: ShowQuestionKind;
  source_id: string;
  check: ShowCheck;
  note: string;
  view: ShowQuestionView;
}
type PackQuestion = ShowPack['rounds'][number]['questions'][number];
export interface ShowPick {
  sourceId: string;
  question: PackQuestion;
  view: ShowQuestionView;
}

const record = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
/** Georgian (required) and English of an i18n field; null when there is no Georgian. */
function text(v: unknown): Text | null {
  const o = record(v);
  const ka = typeof o['ka'] === 'string' ? o['ka'].trim() : '';
  const en = typeof o['en'] === 'string' ? o['en'].trim() : '';
  if (!ka) return null;
  return en ? { ka, en } : { ka };
}
const IMAGE = /^(https:\/\/|\/)\S+$/;
const TRUE: Text = { ka: 'მართალია', en: 'True' };
const FALSE: Text = { ka: 'მცდარია', en: 'False' };

/** Pure: a bank question as a show question plus its readable view; null when it can't be played as that kind. */
export function toShowQuestion(kind: ShowQuestionKind, source: SourceRow): ShowPick | null {
  if (!payloadFullyBilingual(source.prompt, source.payload)) return null;
  const { payload, evaluation } = splitSource(kind, source);
  const prompt = text(source.prompt);
  const base = { sourceId: source.id };
  if (kind === 'true_false') {
    const correct = String(evaluation['correct_id']);
    if (!prompt || (correct !== 'true' && correct !== 'false')) return null;
    return { ...base, question: { prompt, correct }, view: { prompt, image: null, options: [], answer: correct === 'true' ? TRUE : FALSE, lines: [] } };
  }
  if (kind === 'mcq') {
    const options = list(payload['options']).map((o) => ({ id: String(record(o)['id']), text: text(record(o)['text']) }));
    const correctAt = options.findIndex((o) => o.id === String(evaluation['correct_id']));
    if (!prompt || options.length < 2 || options.length > 6 || options.some((o) => !o.text) || correctAt < 0) return null;
    const url = record(payload['image'])['url'];
    const image = typeof url === 'string' && IMAGE.test(url) ? url : null;
    const ids = 'abcdef';
    return {
      ...base,
      question: { prompt, options: options.map((o, i) => ({ id: ids[i]!, text: o.text! })), correct: ids[correctAt]!, ...(image ? { image } : {}) },
      view: { prompt, image, options: options.map((o, i) => ({ text: o.text!, correct: i === correctAt })), answer: options[correctAt]!.text!, lines: [] },
    };
  }
  const wl = { payload, evaluation, source_question_id: source.id };
  if (kind === 'put_in_order') {
    const labels = new Map(list(payload['items']).map((it) => [String(record(it)['id'] ?? ''), text(record(it)['label'])]));
    const order = list(evaluation['order']).map(String);
    const instruction = text(payload['instruction']);
    if (!prompt || labels.size < 3 || labels.has('') || order.length !== labels.size || order.some((id) => !labels.get(id))) return null;
    return { ...base, question: { prompt, wl }, view: { prompt, image: null, options: [], answer: null, lines: order.map((id) => labels.get(id)!), ...(instruction ? { instruction } : {}) } };
  }
  const answer = text(evaluation['display_answer']);
  const accepted = list(evaluation['accepted_answers']).filter((a) => typeof a === 'string' && a.trim() !== '');
  const lines = kind === 'career_path' ? list(payload['clubs']).map(text) : list(payload['clues']).map((c) => text(record(c)['content']));
  if (!answer || accepted.length === 0 || lines.length < (kind === 'who_am_i' ? 5 : 2) || lines.some((l) => !l)) return null;
  return { ...base, question: { prompt: { ka: '—' }, wl }, view: { prompt: null, image: null, options: [], answer, lines: lines as Text[] } };
}

/** Pure: every source question and Georgian prompt a stored pack uses (older packs kept no source for one-tap questions). */
export function packUsage(pack: unknown, into: { ids: Set<string>; prompts: Set<string> }): void {
  for (const r of list(record(pack)['rounds'])) {
    for (const q of list(record(r)['questions'])) {
      const wl = record(record(q)['wl']);
      if (typeof wl['source_question_id'] === 'string') into.ids.add(wl['source_question_id']);
      const player = text(record(wl['evaluation'])['display_answer'])?.ka;
      if (player) into.prompts.add(PLAYER + player);
      const ka = text(record(q)['prompt'])?.ka;
      if (ka && ka !== '—' && !player) into.prompts.add(ka);
    }
  }
}

/** `prompts` holds sameQuestionKey values: wordings of prompt questions, players of career path / who am I. */
type Used = { ids: Set<string>; prompts: Set<string> };
const PLAYER = 'player:';

/**
 * What makes two bank rows the same question on air. Career path and who am I all share a prompt ("Who am I?"), so
 * there it is the player; everywhere else the Georgian wording.
 */
export function sameQuestionKey(kind: ShowQuestionKind, view: ShowQuestionView): string | null {
  if (kind === 'career_path' || kind === 'who_am_i') return view.answer ? PLAYER + view.answer.ka : null;
  return view.prompt?.ka ?? null;
}

/**
 * Everything earlier shows used or turned down: stored packs, the hub's own packs (with the questions swapped out of
 * them), and the questions of show nights that ran without a pack (seeded from the bank). `rebuilding` is a pack
 * being built again from scratch: its current questions go back to the bank, its swapped-out ones do not.
 */
async function usedBefore(db: Db, rebuilding?: string): Promise<Used> {
  const used: Used = { ids: new Set<string>(), prompts: new Set<string>() };
  const [stored, drafted, played] = await Promise.all([
    db<Array<{ pack: unknown }>>`SELECT pack FROM wl_show_packs WHERE slug = ${SLUG}`,
    db<Array<{ id: string; pack: unknown; questions: unknown; dropped: unknown }>>`SELECT id, pack, questions, dropped FROM harness.show_packs WHERE slug = ${SLUG}`,
    db<Array<{ source_question_id: string | null; prompt: unknown; player: unknown }>>`
      SELECT w.source_question_id, w.evaluation->'display_answer' AS player,
             CASE WHEN w.kind IN ('true_false', 'mcq', 'put_in_order') THEN w.payload->'prompt' END AS prompt
      FROM wl_questions w
      JOIN wl_tournaments t ON t.id = w.tournament_id
      WHERE t.is_test = true AND t.config->>'event_slug' = ${SLUG}`,
  ]);
  for (const r of stored) packUsage(r.pack, used);
  for (const r of drafted) {
    for (const d of list(r.dropped)) {
      if (typeof record(d)['id'] === 'string') used.ids.add(record(d)['id'] as string);
      if (typeof record(d)['key'] === 'string') used.prompts.add(record(d)['key'] as string);
    }
    if (r.id === rebuilding) continue;
    packUsage(r.pack, used);
    for (const m of list(r.questions)) if (typeof record(m)['source_id'] === 'string') used.ids.add(record(m)['source_id'] as string);
  }
  for (const r of played) {
    if (r.source_question_id) used.ids.add(r.source_question_id);
    const ka = text(r.prompt)?.ka;
    if (ka) used.prompts.add(ka);
    const player = text(r.player)?.ka;
    if (player) used.prompts.add(PLAYER + player);
  }
  return used;
}

/**
 * Fresh questions of one kind from the public bank (never protected Weekend League stock: the answers are revealed
 * live). Hard ones first, medium once the hard ones run out; the multiple-choice rounds prefer photo questions.
 */
async function draw(db: Db, kind: ShowQuestionKind, need: number, used: Used): Promise<ShowPick[]> {
  const picks: ShowPick[] = [];
  const pageSize = need * 4 + 8;
  // Rows already looked at are excluded from the next page, so unusable ones at the top never hide the rest.
  const seen = new Set(used.ids);
  for (let page = 0; picks.length < need && page < MAX_DRAW_PAGES; page++) {
    const rows = await drawPage(db, kind, pageSize, seen);
    for (const row of rows) {
      seen.add(row.id);
      if (picks.length >= need) continue;
      const pick = toShowQuestion(kind, row);
      if (!pick) continue;
      // The same question under another id (in an earlier show, or already in this pack) is not asked twice.
      const key = sameQuestionKey(kind, pick.view);
      if (key && used.prompts.has(key)) continue;
      if (key) used.prompts.add(key);
      used.ids.add(pick.sourceId);
      picks.push(pick);
    }
    if (rows.length < pageSize) break;
  }
  return picks;
}
const MAX_DRAW_PAGES = 50;

function drawPage(db: Db, kind: ShowQuestionKind, limit: number, exclude: ReadonlySet<string>): Promise<SourceRow[]> {
  return db<SourceRow[]>`
    SELECT q.id, q.prompt, qp.payload
    FROM questions q
    JOIN question_payloads qp ON qp.question_id = q.id
    WHERE q.status = 'published' AND q.visibility = 'public'
      AND q.type = ${KIND_TO_SOURCE[kind]}
      AND q.difficulty IN ('hard', 'medium')
      AND NOT (q.id = ANY(${sql.array([...exclude])}::uuid[]))
    ORDER BY (${kind === 'mcq'} AND qp.payload->'image' IS NOT NULL AND qp.payload->>'image' <> 'null') DESC,
             (q.difficulty = 'hard') DESC,
             random()
    LIMIT ${limit}`;
}

const droppedEntry = (m: ShowQuestionMeta) => ({ id: m.source_id, key: sameQuestionKey(m.kind, m.view) });
const meta = (round: number, question: number, kind: ShowQuestionKind, pick: ShowPick): ShowQuestionMeta => ({
  round, question, kind, source_id: pick.sourceId, check: 'unchecked', note: '', view: pick.view,
});

async function buildShowPack(db: Db, eventDate: string, rebuilding?: string): Promise<{ pack: ShowPack; questions: ShowQuestionMeta[] }> {
  const used = await usedBefore(db, rebuilding);
  const rounds: unknown[] = [];
  const questions: ShowQuestionMeta[] = [];
  for (const [ri, spec] of SHOW_LAYOUT.entries()) {
    const picks = await draw(db, spec.kind, spec.count, used);
    if (picks.length < spec.count) throw new Error(`show pack: only ${picks.length}/${spec.count} usable ${spec.kind} questions left in the public bank`);
    picks.forEach((p, qi) => questions.push(meta(ri, qi, spec.kind, p)));
    rounds.push({ kind: spec.kind, title: spec.title, questions: picks.map((p) => p.question), ...(spec.cut ? { cut: spec.cut } : {}) });
  }
  return { pack: showPackSchema.parse({ slug: SLUG, eventDate, rounds }), questions };
}

/** The checker reads a handful of questions per run, so one slow search never costs the whole pack. */
const CHECK_CHUNK = 5;
/** Flagged questions are swapped and checked again this many times; after that a person decides. */
const MAX_SWAP_ROUNDS = 2;

/** Each job names its questions by position and source, so a job outlived by a swap or rebuild touches nothing. */
async function enqueueChecks(tx: Db, packId: string, questions: ShowQuestionMeta[], indexes: number[]): Promise<void> {
  for (let i = 0; i < indexes.length; i += CHECK_CHUNK) {
    const chunk = indexes.slice(i, i + CHECK_CHUNK);
    await tx`
      INSERT INTO harness.jobs (kind, agent_slug, show_pack_id, priority, input)
      VALUES ('show_check', 'show-checker', ${packId}, 1, ${sql.json({ indexes: chunk, sources: chunk.map((n) => questions[n]!.source_id) })})`;
  }
}

async function note(tx: Db, message: string, data: Record<string, unknown> = {}): Promise<void> {
  await tx`INSERT INTO harness.events (type, level, message, data) VALUES ('show_pack', 'info', ${message.slice(0, 1000)}, ${sql.json(data as never)})`;
}

interface PackRow {
  id: string;
  event_date: string;
  status: 'checking' | 'flagged' | 'ready' | 'approved';
  pack: ShowPack;
  questions: ShowQuestionMeta[];
  swap_rounds: number;
  dropped: Array<{ id: string; key: string | null }>;
  approved_by: string | null;
  loaded_hash: string | null;
  updated_at: Date | string;
}
const PACK_COLUMNS = sql`id, event_date::text AS event_date, status, pack, questions, swap_rounds, dropped, approved_by, loaded_hash, updated_at`;

async function lockPack(tx: Db, id: string): Promise<PackRow> {
  const [row] = await tx<PackRow[]>`SELECT ${PACK_COLUMNS} FROM harness.show_packs WHERE id = ${id} FOR UPDATE`;
  if (!row) throw new NotFoundError('That show pack no longer exists.');
  return row;
}

/** Puts new picks in place of the questions at `indexes`; returns the indexes actually replaced. */
async function replaceQuestions(tx: Db, row: PackRow, indexes: number[]): Promise<number[]> {
  const used = await usedBefore(tx);
  const replaced: number[] = [];
  for (const i of indexes) {
    const m = row.questions[i];
    if (!m) continue;
    const [pick] = await draw(tx, m.kind, 1, used);
    if (!pick) continue;
    // The question taken out is remembered, so a later swap never brings it back.
    row.dropped = [...row.dropped, droppedEntry(m)];
    row.pack.rounds[m.round]!.questions[m.question] = pick.question;
    row.questions[i] = meta(m.round, m.question, m.kind, pick);
    replaced.push(i);
  }
  return replaced;
}

/** The Monday of the next show that can still happen (the orchestrator's own rule; Mondays cancelled ahead are skipped). */
export async function nextShowDate(now: number = Date.now()): Promise<string> {
  const finished = await sql<Array<{ d: string | null }>>`
    SELECT config->>'event_date' AS d FROM wl_tournaments
    WHERE is_test = true AND config->>'event_slug' = ${SLUG} AND status IN ('completed', 'cancelled', 'voided')`;
  return orshabatobaNextDate(now, new Set(finished.map((r) => r.d).filter((d): d is string => !!d)));
}

export const showPacks = {
  /** Builds the pack for the next show when nobody has yet (neither the hub nor a hand-loaded one). */
  async ensure(): Promise<'exists' | 'loaded' | 'built' | 'busy'> {
    const eventDate = await nextShowDate();
    return sql.begin(async (t) => {
      const tx = t as unknown as Db;
      const [lock] = await tx<Array<{ ok: boolean }>>`SELECT pg_try_advisory_xact_lock(hashtext('harness_show_pack_build')) AS ok`;
      if (!lock?.ok) return 'busy';
      const [mine] = await tx`SELECT 1 FROM harness.show_packs WHERE slug = ${SLUG} AND event_date = ${eventDate}::date`;
      if (mine) return 'exists';
      const [loaded] = await tx`SELECT 1 FROM wl_show_packs WHERE slug = ${SLUG} AND event_date = ${eventDate}::date`;
      if (loaded) return 'loaded';
      const built = await buildShowPack(tx, eventDate);
      const [row] = await tx<Array<{ id: string }>>`
        INSERT INTO harness.show_packs (slug, event_date, pack, questions)
        VALUES (${SLUG}, ${eventDate}::date, ${sql.json(built.pack as never)}, ${sql.json(built.questions as never)})
        RETURNING id`;
      await enqueueChecks(tx, row!.id, built.questions, built.questions.map((_, i) => i));
      await note(tx, `Show pack for ${eventDate} built: ${built.questions.length} questions, now being checked`, { eventDate });
      return 'built';
    });
  },

  /** Swaps the questions the checker flagged and sends the new ones to be checked; after the last round a person decides. */
  async settleFlagged(): Promise<number> {
    const rows = await sql<Array<{ id: string }>>`SELECT id FROM harness.show_packs WHERE status = 'flagged'`;
    let settled = 0;
    for (const { id } of rows) {
      await sql.begin(async (t) => {
        const tx = t as unknown as Db;
        const row = await lockPack(tx, id);
        if (row.status !== 'flagged') return;
        const flagged = row.questions.flatMap((m, i) => (m.check === 'flagged' ? [i] : []));
        const replaced = row.swap_rounds < MAX_SWAP_ROUNDS ? await replaceQuestions(tx, row, flagged) : [];
        await tx`
          UPDATE harness.show_packs
             SET pack = ${sql.json(row.pack as never)}, questions = ${sql.json(row.questions as never)},
                 dropped = ${sql.json(row.dropped as never)},
                 status = ${replaced.length ? 'checking' : 'ready'}, swap_rounds = swap_rounds + ${replaced.length ? 1 : 0}, updated_at = now()
           WHERE id = ${id}`;
        if (replaced.length) {
          await enqueueChecks(tx, id, row.questions, replaced);
          await note(tx, `Show pack for ${row.event_date}: ${replaced.length} flagged question${replaced.length === 1 ? '' : 's'} swapped`, { eventDate: row.event_date });
        }
        settled++;
      });
    }
    return settled;
  },

  /** A person swaps one question for a fresh one; the new one is checked before the pack is ready again. */
  async swap(id: string, index: number, by: string): Promise<void> {
    await sql.begin(async (t) => {
      const tx = t as unknown as Db;
      const row = await lockPack(tx, id);
      if (row.status !== 'ready') throw new ConflictError(row.status === 'approved' ? 'This pack is already approved.' : 'The pack is still being checked. Try again in a few minutes.');
      if (!row.questions[index]) throw new ValidationError('That question is not in the pack.');
      const replaced = await replaceQuestions(tx, row, [index]);
      if (!replaced.length) throw new ConflictError('No other question of that kind is left in the bank.');
      await tx`
        UPDATE harness.show_packs
           SET pack = ${sql.json(row.pack as never)}, questions = ${sql.json(row.questions as never)},
               dropped = ${sql.json(row.dropped as never)}, status = 'checking', updated_at = now()
         WHERE id = ${id}`;
      await enqueueChecks(tx, id, row.questions, replaced);
      await note(tx, `Show pack for ${row.event_date}: ${by} swapped question ${index + 1}`, { eventDate: row.event_date });
    });
  },

  /** Builds the pack again from scratch, in place. Questions the checker flagged in the old one stay out. */
  async rebuild(id: string, by: string): Promise<void> {
    await sql.begin(async (t) => {
      const tx = t as unknown as Db;
      // Jobs first, then the pack: the order a finishing check job takes them in (job, then harness.show_pack_checked).
      await tx`SELECT id FROM harness.jobs WHERE show_pack_id = ${id} ORDER BY id FOR UPDATE`;
      const row = await lockPack(tx, id);
      if (row.status === 'approved') throw new ConflictError('This pack is already approved and loaded for the show.');
      const dropped = [...row.dropped, ...row.questions.filter((m) => m.check === 'flagged').map(droppedEntry)];
      await tx`UPDATE harness.show_packs SET dropped = ${sql.json(dropped as never)} WHERE id = ${id}`;
      const built = await buildShowPack(tx, row.event_date, id);
      // Checks still waiting belong to the old questions; one already running lands on nothing (its questions are gone).
      await tx`
        UPDATE harness.jobs SET status = 'cancelled', finished_at = now(), error = 'pack rebuilt', lease_owner = NULL, lease_token = NULL, lease_until = NULL
        WHERE show_pack_id = ${id} AND status = 'queued'`;
      await tx`
        UPDATE harness.show_packs
           SET pack = ${sql.json(built.pack as never)}, questions = ${sql.json(built.questions as never)}, status = 'checking', swap_rounds = 0, updated_at = now()
         WHERE id = ${id}`;
      await enqueueChecks(tx, id, built.questions, built.questions.map((_, i) => i));
      await note(tx, `Show pack for ${row.event_date}: ${by} asked for a new pack`, { eventDate: row.event_date });
    });
  },

  /**
   * Approves the pack and loads it for the show, exactly as scripts/wl-show-pack-load.ts does: validated first, under
   * the show-night lock the host's Start also takes, and never once the show has started.
   */
  async approve(id: string, seen: string, by: string): Promise<{ hash: string }> {
    return sql.begin(async (t) => {
      const tx = t as unknown as Db;
      const row = await lockPack(tx, id);
      // `seen` is the pack as the person read it: a pack that changed since is never approved unread.
      if (new Date(row.updated_at).getTime() !== Date.parse(seen)) throw new ConflictError('The pack changed since you opened it. Read it again before approving.');
      if (row.status !== 'ready') throw new ConflictError(row.status === 'approved' ? 'This pack is already approved.' : 'The pack is still being checked. Try again in a few minutes.');
      const parsed = showPackSchema.safeParse(row.pack);
      if (!parsed.success || parsed.data.eventDate !== row.event_date) {
        throw new ValidationError('This pack no longer passes the show checks. Ask for a new pack.', parsed.success ? null : redactedIssues(parsed.error.issues));
      }
      const pack = parsed.data;
      await lockShowNight(tx, pack.slug, pack.eventDate);
      const [event] = await tx<Array<{ status: string; started: boolean }>>`
        SELECT status, qualifier_starts_at IS NOT NULL AS started FROM wl_tournaments
        WHERE is_test = true AND config->>'event_slug' = ${pack.slug} AND config->>'event_date' = ${pack.eventDate}
        FOR UPDATE`;
      if (event?.started) throw new ConflictError('That show has already started; its questions can no longer change.');
      if (event && ['completed', 'cancelled', 'voided'].includes(event.status)) throw new ConflictError(`That show is ${event.status}; a pack can no longer be loaded for it.`);
      const hash = showPackHash(pack);
      await tx`
        INSERT INTO wl_show_packs (slug, event_date, pack)
        VALUES (${pack.slug}, ${pack.eventDate}::date, ${sql.json(pack as never)})
        ON CONFLICT (slug, event_date) DO UPDATE SET pack = EXCLUDED.pack, updated_at = NOW()`;
      await tx`UPDATE harness.show_packs SET status = 'approved', approved_by = ${by}, loaded_hash = ${hash}, updated_at = now() WHERE id = ${id}`;
      await note(tx, `Show pack for ${pack.eventDate} approved by ${by} and loaded for the show`, { eventDate: pack.eventDate, hash });
      return { hash };
    });
  },

  /** What the Content tab shows: the next show and its pack, question by question. */
  async state() {
    const eventDate = await nextShowDate();
    const [[row], [loaded]] = await Promise.all([
      sql<PackRow[]>`SELECT ${PACK_COLUMNS} FROM harness.show_packs WHERE slug = ${SLUG} AND event_date = ${eventDate}::date`,
      sql<Array<{ pack: unknown }>>`SELECT pack FROM wl_show_packs WHERE slug = ${SLUG} AND event_date = ${eventDate}::date`,
    ]);
    return showState(eventDate, row ?? null, loaded?.pack ?? null);
  },
};

/** Pure: the next show as the CMS shows it. */
export function showState(eventDate: string, row: PackRow | null, loadedPack: unknown) {
  const loadedParsed = loadedPack == null ? null : showPackSchema.safeParse(loadedPack);
  const loadedHash = loadedParsed?.success ? showPackHash(loadedParsed.data) : null;
  const count = (c: ShowCheck) => (row ? row.questions.filter((m) => m.check === c).length : 0);
  return {
    eventDate,
    episode: orshabatobaEpisode(eventDate),
    showAt: wlHostRunShowAt(eventDate),
    /** A pack is stored for the show (from the hub or loaded by hand). */
    loaded: loadedPack != null,
    /** The stored pack is the one approved here (false when someone loaded another by hand afterwards). */
    loadedIsThisPack: !!row?.loaded_hash && row.loaded_hash === loadedHash,
    pack: row && {
      id: row.id,
      status: row.status,
      approvedBy: row.approved_by,
      updatedAt: new Date(row.updated_at).toISOString(),
      counts: { total: row.questions.length, ok: count('ok'), flagged: count('flagged'), notChecked: count('skipped'), checking: count('unchecked') },
      rounds: row.pack.rounds.map((r, ri) => ({
        kind: r.kind,
        title: r.title?.ka ?? '',
        cut: r.cut ?? null,
        questions: row.questions.flatMap((m, index) => (m.round === ri ? [{ index, kind: m.kind, check: m.check, note: m.note, ...m.view }] : [])),
      })),
    },
  };
}

// ── background loop ────────────────────────────────────────────────────────

const TICK_MS = 120_000;
let timer: ReturnType<typeof setInterval> | undefined;
let running = false;

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    // Paused means the agents do nothing: no new pack either.
    const [settings] = await sql<Array<{ paused: boolean }>>`SELECT paused FROM harness.settings WHERE id`;
    if (!settings || settings.paused) return;
    await showPacks.ensure();
    await showPacks.settleFlagged();
  } catch (err) {
    logger.warn({ err }, 'Show pack tick skipped');
  } finally {
    running = false;
  }
}

/** Keeps the next show's pack prepared. Production only: staging shows are tests with hand-loaded packs. */
export function startShowPackLoop(): void {
  if (timer || config.NODE_ENV !== 'prod') return;
  timer = setInterval(() => void tick(), TICK_MS);
  timer.unref();
  void tick();
}

export function stopShowPackLoop(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
