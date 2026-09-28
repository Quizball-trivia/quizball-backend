/**
 * Weekend League lineup upload (CMS): the editor picks an event and the games
 * to fill, uploads every question of those games in one file, previews the
 * exact placements, and saves them.
 *
 *   preview — validates structure + content, picks missing reserves from the
 *             pool, records the manifest + the event's lineup fingerprint.
 *   save    — takes only the preview id; the stored manifest is committed.
 *   job     — drafts (not drawable by anything) → photos → Georgian → aliases,
 *             then ONE transaction: allocation lock, event lock, fingerprint,
 *             pool reserves re-checked, drafts published, target games
 *             replaced, batch done. Any failure: drafts + photos deleted,
 *             nothing scheduled.
 */
import { sql } from '../../db/index.js';
import { logger } from '../../core/logger.js';
import { BadRequestError, ConflictError, NotFoundError } from '../../core/errors.js';
import type { I18nField, Json } from '../../db/types.js';
import { assertPublishableContent, normalizePayload } from '../questions/questions.service.js';
import { translationService } from '../questions/translation.service.js';
import { invalidateCategoryCache } from '../lobbies/lobbies.service.js';
import { contentKeysOf, contentKeysOfDealt, expandAcceptedAnswers, wlShapeIssues } from './wl-content-normalize.js';
import {
  assertBatchLive,
  BatchClosedError,
  clientImageUrl,
  deleteUnusedBatchPhotos,
  enqueueBatchJob,
  hasErrors,
  hostImage,
  invalidateContentIndex,
  questionSummary,
  RESEEDABLE_STATUSES,
  restoreInterruptedReseeds,
  runChecks,
  setRow,
  storedImageProblem,
  wlCategory,
  wlQuestionView,
  type WlNextEventQuestion,
} from './wl-content.service.js';
import type { WlContentCheckResponse, WlContentQuestion } from './wl-content.schemas.js';
import {
  drawSources,
  KIND_TO_SOURCE,
  payloadFullyBilingual,
  splitSource,
  WL_GAME_COUNT,
  WL_REPEAT_AVOID_DAYS,
  WL_RESERVES_PER_KIND,
  wlInsertTournamentSlots,
  wlLockContentAllocation,
  type SlotInsert,
  type SourceRow,
} from './wl-seeder.js';
import { WL_QUESTIONS_PER_ROUND, WL_ROUND_ORDER, type WlRoundKind } from './wl-rules.js';

export const WL_LINEUP_SCOPES: Record<string, number[]> = {
  game_0: [0], game_1: [1], game_2: [2], game_3: [3], saturday: [0, 1, 2], weekend: [0, 1, 2, 3],
};
const GAME_NAMES = ['Saturday Game 1', 'Saturday Game 2', 'Saturday Game 3', 'Sunday Final'];
const KIND_LABEL: Record<string, string> = { true_false: 'True or False', put_in_order: 'Put in order', mcq: 'Photo', career_path: 'Career path', who_am_i: 'Who am I' };
const TYPE_TO_KIND: Record<string, WlRoundKind> = { true_false: 'true_false', put_in_order: 'put_in_order', mcq_single: 'mcq', career_path: 'career_path', clue_chain: 'who_am_i' };
/** Rows a complete game holds: 21 main + 2 reserves per round type. */
const ROWS_PER_GAME = WL_ROUND_ORDER.reduce((n, k) => n + WL_QUESTIONS_PER_ROUND[k] + WL_RESERVES_PER_KIND, 0);
const PREVIEW_TTL_MINUTES = 30;

export interface LineupSlot { game_index: number; round_index: number | null; question_index: number | null; reserve_ordinal: number }
interface PoolPick { game_index: number; kind: WlRoundKind; reserve_ordinal: number; source_question_id: string; content_hash: string }
interface Manifest { questions: WlContentQuestion[]; slots: LineupSlot[]; lines: Array<number | null>; force_indexes: number[]; pool: PoolPick[]; note: string | null }

export interface LineupProblem { where: string; message: string; row_index: number | null }

class LineupAbort extends Error {}

const kindOfSlot = (slot: LineupSlot, type: string): WlRoundKind | undefined =>
  slot.reserve_ordinal > 0 ? TYPE_TO_KIND[type] : WL_ROUND_ORDER[slot.round_index ?? -1];

export function lineupSlotLabel(slot: { game_index: number; round_index: number | null; question_index: number | null; reserve_ordinal: number }, kind?: string): string {
  const game = GAME_NAMES[slot.game_index] ?? `Game ${slot.game_index + 1}`;
  if (slot.reserve_ordinal > 0) return `${game} · Reserve ${slot.reserve_ordinal}${kind ? ` (${KIND_LABEL[kind] ?? kind})` : ''}`;
  const k = WL_ROUND_ORDER[slot.round_index ?? 0]!;
  return `${game} · Round ${(slot.round_index ?? 0) + 1} (${KIND_LABEL[k]}) · Q${(slot.question_index ?? 0) + 1}`;
}

// ─── events ───────────────────────────────────────────────────────────────────

export interface WlLineupEvent {
  id: string; week_key: string; status: string; answers: number;
  editable: boolean; reason: string | null;
  games: Array<{ game_index: number; rows: number; complete: boolean }>;
}

export async function wlLineupEvents(): Promise<WlLineupEvent[]> {
  const rows = await sql<Array<{ id: string; week_key: string; status: string; answers: number; per_game: Array<{ g: number; n: number }> | null }>>`
    SELECT t.id, t.week_key::text AS week_key, t.status,
           (SELECT count(*)::int FROM wl_answers a WHERE a.tournament_id = t.id) AS answers,
           (SELECT json_agg(json_build_object('g', g, 'n', n)) FROM (
              SELECT game_index AS g, count(*)::int AS n FROM wl_questions w WHERE w.tournament_id = t.id GROUP BY game_index) x) AS per_game
    FROM wl_tournaments t
    WHERE t.is_test = false AND t.week_key IS NOT NULL
      AND t.status NOT IN ('completed', 'cancelled', 'voided')
      AND t.week_key >= (NOW() AT TIME ZONE 'Asia/Tbilisi')::date - 1
    ORDER BY t.week_key ASC
  `;
  return rows.map((t) => {
    const counts = new Map((t.per_game ?? []).map((p) => [p.g, p.n]));
    const games = Array.from({ length: WL_GAME_COUNT }, (_, g) => ({ game_index: g, rows: counts.get(g) ?? 0, complete: (counts.get(g) ?? 0) === ROWS_PER_GAME }));
    let reason: string | null = null;
    if (t.answers > 0) reason = 'Play has started — the lineup is locked';
    else if (!RESEEDABLE_STATUSES.includes(t.status)) {
      reason = ['scheduled', 'content_pending'].includes(t.status)
        ? 'The lineup for this weekend is still being drawn — try again in a minute'
        : `Locked (${t.status.replace(/_/g, ' ')}) — lineups can change only before check-in`;
    }
    return { id: t.id, week_key: t.week_key, status: t.status, answers: t.answers, editable: reason === null, reason, games };
  });
}

// ─── fingerprint + structure ──────────────────────────────────────────────────

/** The event's whole lineup, canonically ordered: any re-draw, save or in-place edit changes it. */
async function lineupFingerprint(db: typeof sql, tournamentId: string): Promise<string> {
  const [r] = await db<Array<{ fp: string }>>`
    SELECT md5(coalesce(string_agg(concat_ws('|', question_id, game_index, coalesce(round_index, -1), coalesce(question_index, -1),
                                             reserve_ordinal, kind, coalesce(source_question_id::text, ''), md5(payload::text), md5(evaluation::text)),
                                   ';' ORDER BY game_index, reserve_ordinal, coalesce(round_index, -1), coalesce(question_index, -1), kind, question_id), '')) AS fp
    FROM wl_questions WHERE tournament_id = ${tournamentId}`;
  return r!.fp;
}

interface EventRow { question_id: string; game_index: number; round_index: number | null; question_index: number | null; reserve_ordinal: number; kind: string; payload: Record<string, unknown>; evaluation: Record<string, unknown>; source_question_id: string | null }

/** A game is complete when it holds exactly every legal slot once. */
function gameStructureProblem(rows: EventRow[]): string | null {
  const seen = new Set<string>();
  for (const r of rows) {
    if (r.reserve_ordinal === 0 && WL_ROUND_ORDER[r.round_index ?? -1] !== r.kind) return `has a ${KIND_LABEL[r.kind] ?? r.kind} question in Round ${(r.round_index ?? 0) + 1}`;
    if (r.reserve_ordinal > 0 && !WL_ROUND_ORDER.includes(r.kind as WlRoundKind)) return `has a reserve of an unknown round type (${r.kind})`;
    const key = r.reserve_ordinal > 0 ? `r:${r.kind}:${r.reserve_ordinal}` : `m:${r.round_index}:${r.question_index}`;
    if (seen.has(key)) return 'has a slot twice';
    seen.add(key);
  }
  for (const [ri, kind] of WL_ROUND_ORDER.entries()) {
    for (let qi = 0; qi < WL_QUESTIONS_PER_ROUND[kind]; qi += 1) if (!seen.has(`m:${ri}:${qi}`)) return `is missing Round ${ri + 1} Q${qi + 1}`;
    for (let o = 1; o <= WL_RESERVES_PER_KIND; o += 1) if (!seen.has(`r:${kind}:${o}`)) return `is missing reserve ${o} for ${KIND_LABEL[kind]}`;
  }
  return rows.length === ROWS_PER_GAME ? null : `has ${rows.length} slots instead of ${ROWS_PER_GAME}`;
}

/** Uploaded questions must fill every main slot of every chosen game exactly once; reserves 1–2 per round type at most. */
function uploadStructureProblems(questions: WlContentQuestion[], slots: LineupSlot[], games: number[]): LineupProblem[] {
  const problems: LineupProblem[] = [];
  if (slots.length !== questions.length) return [{ where: 'Upload', message: 'Every question needs exactly one slot', row_index: null }];
  const taken = new Map<string, number>();
  slots.forEach((slot, i) => {
    const q = questions[i]!;
    const where = lineupSlotLabel(slot, TYPE_TO_KIND[q.type]);
    if (!games.includes(slot.game_index)) { problems.push({ where, message: `${GAME_NAMES[slot.game_index] ?? 'This game'} is not part of the chosen upload`, row_index: i }); return; }
    const kind = kindOfSlot(slot, q.type);
    if (slot.reserve_ordinal > 0) {
      if (slot.round_index !== null || slot.question_index !== null || slot.reserve_ordinal > WL_RESERVES_PER_KIND || !kind) {
        problems.push({ where, message: `Reserves are numbered 1–${WL_RESERVES_PER_KIND} per round type`, row_index: i }); return;
      }
    } else {
      if (!kind || slot.question_index === null || slot.question_index < 0 || slot.question_index >= WL_QUESTIONS_PER_ROUND[kind]) {
        problems.push({ where, message: 'This slot does not exist in a game', row_index: i }); return;
      }
      if (KIND_TO_SOURCE[kind] !== q.type) { problems.push({ where, message: `Round ${(slot.round_index ?? 0) + 1} is ${KIND_LABEL[kind]}; this question is a different type`, row_index: i }); return; }
    }
    const key = slot.reserve_ordinal > 0 ? `${slot.game_index}:r:${kind}:${slot.reserve_ordinal}` : `${slot.game_index}:m:${slot.round_index}:${slot.question_index}`;
    if (taken.has(key)) problems.push({ where, message: `Two questions for the same slot (also row ${taken.get(key)! + 1})`, row_index: i });
    taken.set(key, i);
  });
  for (const g of games) {
    for (const [ri, kind] of WL_ROUND_ORDER.entries()) {
      const need = WL_QUESTIONS_PER_ROUND[kind];
      const have = slots.filter((s) => s.game_index === g && s.reserve_ordinal === 0 && s.round_index === ri).length;
      if (have !== need) problems.push({ where: `${GAME_NAMES[g]} · Round ${ri + 1} (${KIND_LABEL[kind]})`, message: `${have} question${have === 1 ? '' : 's'} — this round needs exactly ${need}`, row_index: null });
    }
  }
  return problems;
}

// ─── pool reserves ────────────────────────────────────────────────────────────

interface PoolRow { id: string; type: string; status: string; visibility: string; prompt: I18nField; payload: Record<string, unknown>; content_hash: string; used_elsewhere: boolean }

/** One rule for a pool reserve, at preview and again at save. */
function poolReserveProblem(kind: WlRoundKind, r: PoolRow): string | null {
  if (r.status !== 'published' || r.visibility !== 'wl_private') return 'is no longer a published Weekend League question';
  if (r.type !== KIND_TO_SOURCE[kind]) return 'has the wrong type';
  if (!payloadFullyBilingual(r.prompt, r.payload)) return 'is missing Georgian';
  if (wlShapeIssues(r.type, r.payload).some((i) => i.severity === 'error')) return 'does not have a valid Weekend League shape';
  if (kind === 'mcq' && !(r.payload['image'] as { url?: string } | null | undefined)?.url) return 'has no photo';
  if (r.used_elsewhere) return `was used in another weekend in the last ${WL_REPEAT_AVOID_DAYS} days`;
  return null;
}

async function loadPoolRows(db: typeof sql, ids: string[], tournamentId: string, lock: boolean): Promise<Map<string, PoolRow>> {
  if (!ids.length) return new Map();
  const q = lock
    ? db<PoolRow[]>`
      SELECT q.id, q.type, q.status, q.visibility, q.prompt, qp.payload, md5(q.prompt::text || qp.payload::text) AS content_hash,
             EXISTS (SELECT 1 FROM wl_questions w JOIN wl_tournaments t ON t.id = w.tournament_id
                     WHERE w.source_question_id = q.id AND t.id <> ${tournamentId} AND t.is_test = false
                       AND t.created_at > NOW() - make_interval(days => ${WL_REPEAT_AVOID_DAYS})) AS used_elsewhere
      FROM questions q JOIN question_payloads qp ON qp.question_id = q.id
      WHERE q.id = ANY(${db.array(ids)}::uuid[]) ORDER BY q.id FOR SHARE OF q, qp`
    : db<PoolRow[]>`
      SELECT q.id, q.type, q.status, q.visibility, q.prompt, qp.payload, md5(q.prompt::text || qp.payload::text) AS content_hash,
             EXISTS (SELECT 1 FROM wl_questions w JOIN wl_tournaments t ON t.id = w.tournament_id
                     WHERE w.source_question_id = q.id AND t.id <> ${tournamentId} AND t.is_test = false
                       AND t.created_at > NOW() - make_interval(days => ${WL_REPEAT_AVOID_DAYS})) AS used_elsewhere
      FROM questions q JOIN question_payloads qp ON qp.question_id = q.id
      WHERE q.id = ANY(${db.array(ids)}::uuid[])`;
  return new Map((await q).map((r) => [r.id, r]));
}

/**
 * Fill every reserve the file leaves out, per (game, round type), from the
 * pool with the normal draw ranking (editor content first). Never a question
 * of a kept or replaced game, never one repeating uploaded or kept content.
 */
async function pickPoolReserves(
  tournamentId: string, games: number[], questions: WlContentQuestion[], slots: LineupSlot[], eventRows: EventRow[],
): Promise<{ picks: PoolPick[]; problems: LineupProblem[] }> {
  const exclude = new Set(eventRows.map((r) => r.source_question_id).filter((id): id is string => Boolean(id)));
  const takenKeys = new Set<string>();
  questions.forEach((q) => { const k = contentKeysOf(q.type, q.prompt as I18nField, q.payload as unknown as Record<string, unknown>).exact; if (k) takenKeys.add(k); });
  eventRows.filter((r) => !games.includes(r.game_index)).forEach((r) => { const k = contentKeysOfDealt(r.kind, r.payload, r.evaluation).exact; if (k) takenKeys.add(k); });

  const picks: PoolPick[] = [];
  const problems: LineupProblem[] = [];
  for (const kind of WL_ROUND_ORDER) {
    const missing: Array<{ game_index: number; reserve_ordinal: number }> = [];
    for (const g of games) {
      for (let o = 1; o <= WL_RESERVES_PER_KIND; o += 1) {
        const uploaded = slots.some((s, i) => s.game_index === g && s.reserve_ordinal === o && TYPE_TO_KIND[questions[i]!.type] === kind);
        if (!uploaded) missing.push({ game_index: g, reserve_ordinal: o });
      }
    }
    if (!missing.length) continue;
    // Same ranking as the draw; widen the window until enough pass the stricter reserve rule or the pool runs out.
    const chosen: PoolRow[] = [];
    const seen = new Set<string>();
    for (let want = missing.length * 4 + 10; chosen.length < missing.length; want *= 4) {
      const candidates = await drawSources(kind, want, false, false, tournamentId, exclude, tournamentId);
      const fresh = candidates.filter((c) => !seen.has(c.id));
      fresh.forEach((c) => seen.add(c.id));
      const rows = await loadPoolRows(sql, fresh.map((c) => c.id), tournamentId, false);
      for (const c of fresh) {
        if (chosen.length >= missing.length) break;
        const r = rows.get(c.id);
        if (!r || poolReserveProblem(kind, r)) continue;
        const key = contentKeysOf(r.type, r.prompt, r.payload).exact;
        if (key && takenKeys.has(key)) continue;
        if (key) takenKeys.add(key);
        exclude.add(r.id);
        chosen.push(r);
      }
      if (candidates.length < want) break; // pool exhausted
    }
    chosen.forEach((r, i) => picks.push({ ...missing[i]!, kind, source_question_id: r.id, content_hash: r.content_hash }));
    if (chosen.length < missing.length) {
      problems.push({
        where: `Reserves · ${KIND_LABEL[kind]}`,
        message: `The pool has only ${chosen.length} fresh ${KIND_LABEL[kind]} question${chosen.length === 1 ? '' : 's'} for ${missing.length} missing reserve${missing.length === 1 ? '' : 's'} — add reserves to the file (--- Reserves: ${KIND_LABEL[kind]} ---)`,
        row_index: null,
      });
    }
  }
  return { picks, problems };
}

// ─── preview ──────────────────────────────────────────────────────────────────

export interface LineupPreviewSlot {
  game_index: number; round_index: number | null; question_index: number | null; reserve_ordinal: number; kind: string;
  origin: 'upload' | 'pool'; row_index: number | null; view: WlNextEventQuestion | null;
}

export interface LineupPreview {
  preview_id: string | null;
  expires_at: string | null;
  event: { id: string; week_key: string; status: string };
  scope: string;
  games: number[];
  kept_games: number[];
  slots: LineupPreviewSlot[];
  replaced: Array<{ game_index: number; rows: WlNextEventQuestion[] }>;
  checks: WlContentCheckResponse;
  problems: LineupProblem[];
  /** Rows flagged duplicate/played that are not ticked "use anyway". */
  undecided: number[];
}

async function loadEventRows(db: typeof sql, tournamentId: string): Promise<EventRow[]> {
  return db<EventRow[]>`
    SELECT question_id, game_index, round_index, question_index, reserve_ordinal, kind, payload, evaluation, source_question_id
    FROM wl_questions WHERE tournament_id = ${tournamentId}
    ORDER BY game_index, reserve_ordinal, round_index, question_index`;
}

const viewOf = (r: EventRow, extra: { difficulty?: string | null; editor?: boolean } = {}) =>
  wlQuestionView({ ...r, difficulty: extra.difficulty ?? null, editor: extra.editor ?? false });

export async function wlLineupPreview(input: {
  tournament_id: string; scope: string; questions: WlContentQuestion[]; slots: LineupSlot[]; lines?: Array<number | null>; force_indexes: number[]; note?: string | null;
}, actor: { id?: string }): Promise<LineupPreview> {
  const games = WL_LINEUP_SCOPES[input.scope];
  if (!games) throw new BadRequestError('Unknown upload scope');
  // Expired previews that were never saved only hold a copy of the uploaded questions: drop them.
  // Saved ones stay — their batch points at them.
  await sql`DELETE FROM wl_content_lineup_previews WHERE batch_id IS NULL AND expires_at < NOW() - interval '1 hour'`;
  const [t] = await sql<Array<{ id: string; week_key: string | null; status: string; is_test: boolean; answers: number }>>`
    SELECT t.id, t.week_key::text AS week_key, t.status, t.is_test, (SELECT count(*)::int FROM wl_answers a WHERE a.tournament_id = t.id) AS answers
    FROM wl_tournaments t WHERE t.id = ${input.tournament_id}`;
  if (!t || t.is_test || !t.week_key) throw new NotFoundError('Weekend not found');
  await restoreInterruptedReseeds(t.id);

  const problems: LineupProblem[] = [];
  if (t.answers > 0) problems.push({ where: 'Weekend', message: 'Play has started — the lineup is locked', row_index: null });
  else if (!RESEEDABLE_STATUSES.includes(t.status)) problems.push({ where: 'Weekend', message: `This weekend can't be changed now (${t.status.replace(/_/g, ' ')})`, row_index: null });
  problems.push(...uploadStructureProblems(input.questions, input.slots, games));

  const fingerprint = await lineupFingerprint(sql, t.id);
  const eventRows = await loadEventRows(sql, t.id);
  const kept = [0, 1, 2, 3].filter((g) => !games.includes(g));
  for (const g of kept) {
    const problem = gameStructureProblem(eventRows.filter((r) => r.game_index === g));
    if (problem) problems.push({ where: GAME_NAMES[g]!, message: `${GAME_NAMES[g]} ${problem}, so this weekend would be incomplete — include it in the upload (choose a wider scope)`, row_index: null });
  }

  const { report: checks } = await runChecks(input.questions, { probeImages: true, fresh: true });
  const forced = new Set(input.force_indexes);
  const undecided: number[] = [];
  checks.rows.forEach((row, i) => {
    if (hasErrors(row.issues)) problems.push({ where: input.slots[i] ? lineupSlotLabel(input.slots[i]!, TYPE_TO_KIND[input.questions[i]!.type]) : `Row ${i + 1}`, message: row.issues.filter((x) => x.severity === 'error').map((x) => x.message).join('; '), row_index: i });
    else if ((row.status === 'duplicate' || row.status === 'played') && !forced.has(i)) undecided.push(i);
  });

  const structural = problems.length > 0;
  const pool = structural ? { picks: [] as PoolPick[], problems: [] as LineupProblem[] } : await pickPoolReserves(t.id, games, input.questions, input.slots, eventRows);
  problems.push(...pool.problems);

  const poolRows = await sql<Array<{ id: string; prompt: Record<string, unknown>; payload: Record<string, unknown>; difficulty: string }>>`
    SELECT q.id, q.prompt, qp.payload, q.difficulty FROM questions q JOIN question_payloads qp ON qp.question_id = q.id
    WHERE q.id = ANY(${sql.array(pool.picks.map((p) => p.source_question_id))}::uuid[])`;
  const poolById = new Map(poolRows.map((r) => [r.id, r]));
  const slots: LineupPreviewSlot[] = [
    ...input.slots.map((s, i) => ({ ...s, kind: kindOfSlot(s, input.questions[i]!.type) ?? 'unknown', origin: 'upload' as const, row_index: i, view: null })),
    ...pool.picks.map((p) => {
      const src = poolById.get(p.source_question_id)!;
      const { payload, evaluation } = splitSource(p.kind, src as SourceRow);
      return {
        game_index: p.game_index, round_index: null, question_index: null, reserve_ordinal: p.reserve_ordinal, kind: p.kind,
        origin: 'pool' as const, row_index: null,
        view: wlQuestionView({ kind: p.kind, reserve_ordinal: p.reserve_ordinal, question_index: null, payload, evaluation, source_question_id: p.source_question_id, difficulty: src.difficulty, editor: true }),
      };
    }),
  ];
  const replaced = games.map((g) => ({ game_index: g, rows: eventRows.filter((r) => r.game_index === g).map((r) => viewOf(r)) }));

  let preview_id: string | null = null;
  let expires_at: string | null = null;
  if (!problems.length && !undecided.length) {
    const manifest: Manifest = {
      questions: input.questions, slots: input.slots, lines: input.lines ?? input.questions.map(() => null),
      force_indexes: [...forced].sort((a, b) => a - b), pool: pool.picks, note: input.note ?? null,
    };
    const [p] = await sql<Array<{ id: string; expires_at: string }>>`
      INSERT INTO wl_content_lineup_previews (created_by, tournament_id, scope, games, fingerprint, manifest, expires_at)
      VALUES (${actor.id ?? null}, ${t.id}, ${input.scope}, ${sql.array(games)}::int[], ${fingerprint}, ${sql.json(manifest as never)},
              NOW() + make_interval(mins => ${PREVIEW_TTL_MINUTES}))
      RETURNING id, expires_at::text`;
    preview_id = p!.id; expires_at = p!.expires_at;
  }
  return {
    preview_id, expires_at, event: { id: t.id, week_key: t.week_key, status: t.status }, scope: input.scope, games, kept_games: kept,
    slots, replaced, checks, problems, undecided,
  };
}

// ─── save ─────────────────────────────────────────────────────────────────────

const CHANGED = 'The weekend changed since this preview (a re-draw or another upload) — preview again';

export async function wlLineupSave(previewId: string, actor: { id?: string; email?: string }): Promise<{ batch_id: string; accepted: number; already_started: boolean }> {
  const category = await wlCategory();
  const out = await sql.begin(async (tx) => {
    const x = tx as unknown as typeof sql;
    const [p] = await x<Array<{ tournament_id: string; scope: string; fingerprint: string; manifest: Manifest; expired: boolean; batch_id: string | null }>>`
      SELECT tournament_id, scope, fingerprint, manifest, expires_at < NOW() AS expired, batch_id
      FROM wl_content_lineup_previews WHERE id = ${previewId} FOR UPDATE`;
    if (!p) throw new NotFoundError('Preview not found');
    if (p.batch_id) return { batch_id: p.batch_id, accepted: p.manifest.questions.length, already_started: true };
    if (p.expired) throw new ConflictError('This preview expired — preview again');
    const [t] = await x<Array<{ status: string; answers: number }>>`
      SELECT t.status, (SELECT count(*)::int FROM wl_answers a WHERE a.tournament_id = t.id) AS answers FROM wl_tournaments t WHERE t.id = ${p.tournament_id}`;
    if (!t || t.answers > 0 || !RESEEDABLE_STATUSES.includes(t.status)) throw new ConflictError('This weekend can no longer be changed');
    if (await lineupFingerprint(x, p.tournament_id) !== p.fingerprint) throw new ConflictError(CHANGED);
    const [batch] = await x<Array<{ id: string }>>`
      INSERT INTO wl_content_batches (created_by, kind, note, status, row_count, sync_to_staging)
      VALUES (${actor.id ?? null}, 'lineup', ${p.manifest.note}, 'processing', ${p.manifest.questions.length}, false) RETURNING id`;
    for (const [i, q] of p.manifest.questions.entries()) {
      const where = lineupSlotLabel(p.manifest.slots[i]!, TYPE_TO_KIND[q.type]);
      await x`INSERT INTO wl_content_batch_rows (batch_id, row_index, summary, state)
              VALUES (${batch!.id}, ${i}, ${`${where}: ${questionSummary(q.type, q.prompt, q.payload as unknown as Record<string, unknown>)}`.slice(0, 300)}, 'pending')`;
    }
    await x`UPDATE wl_content_lineup_previews SET batch_id = ${batch!.id} WHERE id = ${previewId}`;
    return { batch_id: batch!.id, accepted: p.manifest.questions.length, already_started: false };
  });
  if (!out.already_started) {
    enqueueBatchJob(out.batch_id, () => runLineup(out.batch_id, previewId, category, actor), async (err) => {
      await failLineup(out.batch_id, `Saving stopped unexpectedly: ${err instanceof Error ? err.message : String(err)}`, []);
    });
  }
  return out;
}

/** Nothing is scheduled: every draft this batch created is deleted, its photos swept. */
async function failLineup(batchId: string, message: string, rowErrors: Array<{ index: number; error: string }>): Promise<void> {
  for (const r of rowErrors) await setRow(batchId, r.index, { state: 'failed', error: r.error }).catch(() => {});
  await sql`
    DELETE FROM questions q USING wl_content_batch_rows r
    WHERE r.batch_id = ${batchId} AND r.question_id = q.id AND q.status = 'draft'`;
  await sql`UPDATE wl_content_batch_rows SET state = CASE WHEN state = 'failed' THEN 'failed' ELSE 'deleted' END WHERE batch_id = ${batchId}`;
  const photos = await deleteUnusedBatchPhotos(batchId);
  await sql`
    UPDATE wl_content_batches
    SET status = 'failed', updated_at = NOW(), error = ${`Nothing was scheduled. ${message}`},
        result = coalesce(result, '{}'::jsonb) || ${sql.json({ photos: { ...photos, at: new Date().toISOString() }, photos_pending: Boolean(photos.error) } as never)}
    WHERE id = ${batchId} AND status = 'processing'`;
  logger.warn({ batchId, message, rows: rowErrors.length }, 'WL lineup save failed — nothing scheduled');
}

async function runLineup(batchId: string, previewId: string, category: { id: string; slug: string }, actor: { id?: string; email?: string }): Promise<void> {
  const [live] = await sql<Array<{ id: string }>>`UPDATE wl_content_batches SET updated_at = NOW() WHERE id = ${batchId} AND status = 'processing' RETURNING id`;
  if (!live) return;
  const [p] = await sql<Array<{ tournament_id: string; games: number[]; fingerprint: string; manifest: Manifest }>>`
    SELECT tournament_id, games, fingerprint, manifest FROM wl_content_lineup_previews WHERE id = ${previewId}`;
  const m = p!.manifest;
  const forced = new Set(m.force_indexes);
  const rowErrors: Array<{ index: number; error: string }> = [];
  const created: Array<{ index: number; id: string }> = [];
  /** Content as prepared (after Georgian + aliases); the commit refuses drafts that changed since. */
  const preparedHash = new Map<string, string>();
  /** The photo this job stored for each row; the commit requires exactly that one. */
  const hostedPhoto = new Map<number, string>();
  try {
    // 1. Authoritative re-check (another upload may have landed since the preview).
    const { report } = await runChecks(m.questions, { probeImages: true, fresh: true });
    report.rows.forEach((row, i) => {
      if (hasErrors(row.issues)) rowErrors.push({ index: i, error: row.issues.filter((x) => x.severity === 'error').map((x) => x.message).join('; ') });
      else if ((row.status === 'duplicate' || row.status === 'played') && !forced.has(i)) rowErrors.push({ index: i, error: 'became a duplicate since the preview' });
    });
    if (rowErrors.length) throw new LineupAbort(`${rowErrors.length} question(s) failed the check — fix them and preview again`);

    // 2. Drafts: never drawable by any re-draw or seeding until the final commit publishes them.
    for (const [index, q] of m.questions.entries()) {
      try {
        let payload = q.payload as unknown as Record<string, unknown>;
        if (q.type === 'mcq_single' && clientImageUrl(q)) {
          const image = await hostImage(q, category.slug, `${batchId}/${index}`);
          hostedPhoto.set(index, String(image['url']));
          payload = { ...payload, image };
        }
        const normalized = normalizePayload(payload as Json, `wl lineup row ${index}`);
        const id = await sql.begin(async (tx) => {
          const x = tx as unknown as typeof sql;
          await assertBatchLive(x, batchId);
          const [row] = await x<Array<{ id: string }>>`
            INSERT INTO questions (category_id, type, difficulty, status, ranked_eligible, visibility, prompt, explanation, created_by)
            VALUES (${category.id}, ${q.type}, ${q.difficulty}, 'draft', false, 'wl_private', ${sql.json(q.prompt as never)},
                    ${q.explanation ? sql.json(q.explanation as never) : null}, ${actor.id ?? null})
            RETURNING id`;
          await x`UPDATE wl_content_batch_rows SET question_id = ${row!.id}, state = 'created' WHERE batch_id = ${batchId} AND row_index = ${index}`;
          await x`INSERT INTO question_payloads (question_id, payload) VALUES (${row!.id}, ${sql.json(normalized as never)})`;
          await x`UPDATE wl_content_batches SET updated_at = NOW() WHERE id = ${batchId}`;
          return row!.id;
        });
        created.push({ index, id });
      } catch (err) {
        if (err instanceof BatchClosedError) throw err;
        rowErrors.push({ index, error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (rowErrors.length) throw new LineupAbort(`${rowErrors.length} question(s) could not be saved`);

    // 3. Georgian, then per-row preparation (still drafts).
    try { await translationService.translateQuestions(created.map((c) => c.id)); } catch (err) { logger.error({ err, batchId }, 'WL lineup translation failed'); }
    for (const { index, id } of created) {
      try {
        await sql.begin(async (tx) => {
          const x = tx as unknown as typeof sql;
          const [row] = await x<Array<{ type: string; prompt: I18nField; payload: Record<string, unknown> }>>`
            SELECT q.type, q.prompt, qp.payload FROM questions q JOIN question_payloads qp ON qp.question_id = q.id WHERE q.id = ${id} FOR UPDATE OF q, qp`;
          if (!row) throw new Error('row vanished');
          await prepareRow(x, id, index, m.questions[index]!, row);
          const [h] = await x<Array<{ hash: string }>>`
            SELECT md5(q.type || q.prompt::text || coalesce(q.explanation::text, '') || qp.payload::text) AS hash
            FROM questions q JOIN question_payloads qp ON qp.question_id = q.id WHERE q.id = ${id}`;
          preparedHash.set(id, h!.hash);
        });
        await setRow(batchId, index, { state: 'translated' });
      } catch (err) {
        rowErrors.push({ index, error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (rowErrors.length) throw new LineupAbort(`${rowErrors.length} question(s) could not be prepared (Georgian or photo)`);

    // 4. One transaction: publish + place, or nothing.
    const placed = await sql.begin(async (tx) => {
      const x = tx as unknown as typeof sql;
      await assertBatchLive(x, batchId);
      // Lock order everywhere: tournament row, then the allocation lock.
      const [t] = await x<Array<{ status: string; week_key: string; answers: number }>>`
        SELECT t.status, t.week_key::text AS week_key, (SELECT count(*)::int FROM wl_answers a WHERE a.tournament_id = t.id) AS answers
        FROM wl_tournaments t WHERE t.id = ${p!.tournament_id} FOR UPDATE`;
      await wlLockContentAllocation(x);
      if (!t || t.answers > 0 || !RESEEDABLE_STATUSES.includes(t.status)) throw new LineupAbort('This weekend can no longer be changed (play started or check-in began)');
      if (await lineupFingerprint(x, p!.tournament_id) !== p!.fingerprint) throw new LineupAbort(CHANGED);

      // Publication is serialized by the allocation lock, so this duplicate check sees every question
      // published before us (our own drafts are not in the index).
      const { report: final } = await runChecks(m.questions, { probeImages: false, fresh: true, excludeIds: created.map((c) => c.id), db: x });
      final.rows.forEach((row, i) => {
        if ((row.status === 'duplicate' || row.status === 'played') && !forced.has(i)) rowErrors.push({ index: i, error: 'was published elsewhere while saving (now a duplicate)' });
      });
      if (rowErrors.length) throw new LineupAbort(`${rowErrors.length} question(s) became duplicates while saving — preview again`);

      const poolRows = await loadPoolRows(x, m.pool.map((r) => r.source_question_id), p!.tournament_id, true);
      for (const pick of m.pool) {
        const r = poolRows.get(pick.source_question_id);
        const problem = !r ? 'no longer exists' : r.content_hash !== pick.content_hash ? 'was edited since the preview' : poolReserveProblem(pick.kind, r);
        if (problem) throw new LineupAbort(`The pool reserve for ${lineupSlotLabel({ ...pick, round_index: null, question_index: null }, pick.kind)} ${problem} — preview again`);
      }

      const uploads = await x<Array<{ id: string; type: string; status: string; prompt: I18nField; explanation: unknown; payload: Record<string, unknown> }>>`
        SELECT q.id, q.type, q.status, q.prompt, q.explanation, qp.payload FROM questions q JOIN question_payloads qp ON qp.question_id = q.id
        WHERE q.id = ANY(${x.array(created.map((c) => c.id))}::uuid[]) ORDER BY q.id FOR UPDATE OF q, qp`;
      const byId = new Map(uploads.map((u) => [u.id, u]));
      const hashes = new Map((await x<Array<{ id: string; hash: string }>>`
        SELECT q.id, md5(q.type || q.prompt::text || coalesce(q.explanation::text, '') || qp.payload::text) AS hash
        FROM questions q JOIN question_payloads qp ON qp.question_id = q.id WHERE q.id = ANY(${x.array(created.map((c) => c.id))}::uuid[])`).map((r) => [r.id, r.hash]));
      for (const { index, id } of created) {
        const u = byId.get(id);
        const where = lineupSlotLabel(m.slots[index]!, TYPE_TO_KIND[m.questions[index]!.type]);
        if (!u || u.status !== 'draft' || hashes.get(id) !== preparedHash.get(id)) throw new LineupAbort(`${where} was edited while saving — preview again`);
        if (!sameAsPreviewed(m.questions[index]!, u)) throw new LineupAbort(`${where} no longer matches what was previewed — preview again`);
        if (u.type !== m.questions[index]!.type) throw new LineupAbort(`${where} changed type while saving`);
        if (wlShapeIssues(u.type, u.payload).some((i) => i.severity === 'error')) throw new LineupAbort(`${where} no longer has a valid Weekend League shape`);
        const photoNow = (u.payload['image'] as { url?: string } | null | undefined)?.url ?? null;
        if ((hostedPhoto.get(index) ?? null) !== photoNow) throw new LineupAbort(`${where}: its photo changed while saving — preview again`);
        if (!payloadFullyBilingual(u.prompt, u.payload)) throw new LineupAbort('Georgian went missing while saving — preview again');
        assertPublishableContent({ id, type: u.type, prompt: u.prompt, explanation: u.explanation, payload: u.payload });
      }
      await x`UPDATE questions SET status = 'published', visibility = 'wl_private', ranked_eligible = false, updated_at = NOW()
              WHERE id = ANY(${x.array(created.map((c) => c.id))}::uuid[])`;

      const previous = await x<Array<Record<string, unknown>>>`SELECT * FROM wl_questions WHERE tournament_id = ${p!.tournament_id} AND game_index = ANY(${x.array(p!.games)}::int[])`;
      await x`INSERT INTO wl_content_reseeds (tournament_id, actor, previous_rows, result)
              VALUES (${p!.tournament_id}, ${`admin:${actor.email ?? actor.id ?? 'unknown'}`}, ${sql.json(previous as never)},
                      ${sql.json({ ok: true, lineup: true, batch_id: batchId, games: p!.games } as never)})`;
      await x`DELETE FROM wl_questions WHERE tournament_id = ${p!.tournament_id} AND game_index = ANY(${x.array(p!.games)}::int[])`;

      const slots: SlotInsert[] = [];
      for (const { index, id } of created) {
        const s = m.slots[index]!;
        const kind = kindOfSlot(s, m.questions[index]!.type)!;
        const u = byId.get(id)!;
        const { payload, evaluation } = splitSource(kind, { id, prompt: u.prompt as unknown as Record<string, unknown>, payload: u.payload });
        slots.push({ gameIndex: s.game_index, roundIndex: s.round_index, questionIndex: s.question_index, reserveOrdinal: s.reserve_ordinal, kind, payload, evaluation, sourceQuestionId: id });
      }
      for (const pick of m.pool) {
        const r = poolRows.get(pick.source_question_id)!;
        const { payload, evaluation } = splitSource(pick.kind, { id: r.id, prompt: r.prompt as unknown as Record<string, unknown>, payload: r.payload });
        slots.push({ gameIndex: pick.game_index, roundIndex: null, questionIndex: null, reserveOrdinal: pick.reserve_ordinal, kind: pick.kind, payload, evaluation, sourceQuestionId: r.id });
      }
      await wlInsertTournamentSlots(x, p!.tournament_id, slots);
      const after = await loadEventRows(x, p!.tournament_id);
      for (const g of p!.games) {
        const problem = gameStructureProblem(after.filter((r) => r.game_index === g));
        if (problem) throw new LineupAbort(`${GAME_NAMES[g]} ${problem} after placing — nothing was saved`);
      }

      const placement = {
        tournament_id: p!.tournament_id, week_key: t.week_key, games: p!.games, preview_id: previewId, at: new Date().toISOString(),
        slots: slots.map((s) => ({
          game_index: s.gameIndex, round_index: s.roundIndex, question_index: s.questionIndex, reserve_ordinal: s.reserveOrdinal, kind: s.kind,
          source_question_id: s.sourceQuestionId, origin: m.pool.some((pk) => pk.source_question_id === s.sourceQuestionId) ? 'pool' : 'upload',
        })),
      };
      await x`UPDATE wl_content_batch_rows SET state = 'published', error = NULL WHERE batch_id = ${batchId}`;
      await x`UPDATE wl_content_batches SET status = 'done', updated_at = NOW(), error = NULL,
              result = coalesce(result, '{}'::jsonb) || ${sql.json({ published: created.length, placement } as never)}
              WHERE id = ${batchId}`;
      return slots.length;
    });
    invalidateCategoryCache();
    invalidateContentIndex();
    logger.info({ batchId, tournamentId: p!.tournament_id, games: p!.games, placed, actor: actor.email ?? actor.id }, 'WL lineup saved');
  } catch (err) {
    if (err instanceof BatchClosedError) { logger.warn({ batchId }, 'WL lineup job stopped: batch closed elsewhere'); return; }
    const message = err instanceof LineupAbort || err instanceof ConflictError ? err.message : `Saving failed: ${err instanceof Error ? err.message : String(err)}`;
    await failLineup(batchId, message, rowErrors);
  }
}

/** Same invariants as the pool importer's publish step, minus the status flip. */
async function prepareRow(x: typeof sql, id: string, index: number, submitted: WlContentQuestion, row: { type: string; prompt: I18nField; payload: Record<string, unknown> }): Promise<void> {
  let payload = row.payload;
  const shape = wlShapeIssues(row.type, payload).filter((i) => i.severity === 'error');
  if (shape.length) throw new Error(shape.map((i) => i.message).join('; '));
  if (row.type === 'mcq_single') {
    const image = payload['image'] as { url?: string } | null | undefined;
    if (clientImageUrl(submitted) && !image?.url) throw new Error(`row ${index + 1}: photo missing after upload`);
    if (image?.url) { const problem = await storedImageProblem(image.url); if (problem) throw new Error(problem); }
  }
  if (!payloadFullyBilingual(row.prompt, payload)) throw new Error('Georgian translation incomplete');
  if (row.type === 'career_path' || row.type === 'clue_chain') {
    const accepted = expandAcceptedAnswers(payload['display_answer'] as I18nField, (payload['accepted_answers'] as string[] | undefined) ?? []);
    payload = { ...payload, accepted_answers: accepted };
    await x`UPDATE question_payloads SET payload = ${sql.json(payload as never)}, updated_at = NOW() WHERE question_id = ${id}`;
  }
}

/** English content only (Georgian and other locales are generated after the preview). */
function englishOnly(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(englishOnly);
  if (node && typeof node === 'object') {
    const rec = node as Record<string, unknown>;
    if (typeof rec['en'] === 'string') return rec['en'];
    return Object.fromEntries(Object.keys(rec).sort().map((k) => [k, englishOnly(rec[k])]));
  }
  return node;
}

/**
 * The saved draft says exactly what the editor previewed: same English prompt,
 * options, key, items, clubs, clues and answer. Allowed differences are the
 * generated ones only — Georgian, the hosted copy of the photo, and the
 * automatic answer variants.
 */
function sameAsPreviewed(submitted: WlContentQuestion, draft: { type: string; prompt: I18nField; explanation: unknown; payload: Record<string, unknown> }): boolean {
  if (submitted.type !== draft.type) return false;
  const strip = (p: Record<string, unknown>) => { const { image: _i, accepted_answers: _a, ...rest } = p; return englishOnly(rest); };
  const previewed = normalizePayload(submitted.payload as unknown as Json, 'lineup compare') as unknown as Record<string, unknown>;
  if (JSON.stringify(englishOnly(submitted.prompt)) !== JSON.stringify(englishOnly(draft.prompt))) return false;
  if (JSON.stringify(englishOnly(submitted.explanation ?? null)) !== JSON.stringify(englishOnly(draft.explanation ?? null))) return false;
  if (JSON.stringify(strip(previewed)) !== JSON.stringify(strip(draft.payload))) return false;
  if (draft.type === 'career_path' || draft.type === 'clue_chain') {
    const expected = expandAcceptedAnswers(draft.payload['display_answer'] as I18nField, (previewed['accepted_answers'] as string[] | undefined) ?? []);
    const actual = (draft.payload['accepted_answers'] as string[] | undefined) ?? [];
    if ([...new Set(expected)].sort().join('|') !== [...new Set(actual)].sort().join('|')) return false;
  }
  return true;
}
