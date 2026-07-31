/**
 * Tournament content seeder — copies frozen question content into
 * wl_questions at content_pending, days before play.
 *
 * Sourcing rules:
 *  - Draws ONLY published questions with BOTH locales present on every
 *    display field. Competitive kinds prefer visibility='wl_private'
 *    (player APIs can never list those); the public bank is a fallback
 *    ONLY when the tournament config sets allow_public_bank (test
 *    tournaments and the launch edition).
 *  - Repeat-avoidance: source ids used by any tournament created in the
 *    last WL_REPEAT_AVOID_DAYS are excluded.
 *  - Higher/Lower: one source row's matchups become the round's 3 step
 *    slots (each slot = one matchup), so a chain always compares within
 *    one stat.
 *  - Reserves: +WL_RESERVES_PER_KIND rows per (game, kind) for crash
 *    replacement of voided attempts.
 *  - Insufficient stock ⇒ returns { ok: false } and seeds NOTHING (the
 *    tournament stays content_pending; the orchestrator retries and ops
 *    sees the log) — never a partially seeded event.
 */

import { sql } from '../../db/index.js';
import { logger } from '../../core/logger.js';
import { WL_QUESTIONS_PER_ROUND, WL_ROUND_ORDER, type WlRoundKind } from './wl-rules.js';

export const WL_RESERVES_PER_KIND = 2;
export const WL_REPEAT_AVOID_DAYS = 35;
export const WL_GAME_COUNT = 4; // 3 qualifier games + the Sunday final

const KIND_TO_SOURCE: Record<WlRoundKind, string> = {
  true_false: 'true_false',
  higher_lower: 'high_low',
  mcq: 'mcq_single',
  career_path: 'career_path',
  who_am_i: 'clue_chain',
};

interface SourceRow {
  id: string;
  prompt: Record<string, unknown>;
  payload: Record<string, unknown>;
}

function hasBothLocales(value: unknown): boolean {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record['en'] === 'string' && record['en'].trim() !== ''
    && typeof record['ka'] === 'string' && record['ka'].trim() !== '';
}

/** Every i18n-looking object in the payload must carry en + ka. */
function payloadFullyBilingual(prompt: unknown, payload: unknown): boolean {
  if (!hasBothLocales(prompt)) return false;
  const walk = (node: unknown): boolean => {
    if (node == null || typeof node !== 'object') return true;
    if (Array.isArray(node)) return node.every(walk);
    const record = node as Record<string, unknown>;
    // An object with EITHER locale key is an i18n field — require both.
    if ('en' in record || 'ka' in record) return hasBothLocales(record);
    return Object.values(record).every(walk);
  };
  return walk(payload);
}

/** How many SOURCE rows a full tournament needs per kind (slots + reserves). */
export function wlSourceNeedPerKind(kind: WlRoundKind): number {
  const perGame = kind === 'higher_lower'
    ? 1 // one source row covers the 3-step chain
    : WL_QUESTIONS_PER_ROUND[kind];
  return WL_GAME_COUNT * (perGame + WL_RESERVES_PER_KIND);
}

async function drawSources(
  kind: WlRoundKind,
  need: number,
  allowPublicBank: boolean,
  deterministic: boolean,
  pagingSeed: string
): Promise<SourceRow[]> {
  const sourceType = KIND_TO_SOURCE[kind];
  const minMatchups = kind === 'higher_lower' ? 3 : 0;
  // Stable within one seeding pass: RANDOM() would reshuffle every page,
  // repeating and skipping rows across OFFSETs. The per-tournament seed
  // keeps selection pseudo-random ACROSS tournaments yet deterministic
  // within this draw.
  const order = deterministic
    ? sql`md5(q.id::text)`
    : sql`md5(q.id::text || ${pagingSeed})`;
  const visibility = allowPublicBank
    ? sql`q.visibility IN ('wl_private', 'public')`
    : sql`q.visibility = 'wl_private'`;
  // Protected stock is ALWAYS preferred over public fallback (SQL-level
  // priority, before any randomization), and pages keep fetching until the
  // bilingual filter has enough rows or the pool is exhausted — a batch of
  // monolingual rows must not masquerade as a shortage.
  const picked: SourceRow[] = [];
  const pageSize = Math.max(need * 3, 50);
  for (let offset = 0; picked.length < need; offset += pageSize) {
    const rows = await sql<SourceRow[]>`
      SELECT q.id, q.prompt, qp.payload
      FROM questions q
      JOIN question_payloads qp ON qp.question_id = q.id
      WHERE q.status = 'published'
        AND q.type = ${sourceType}
        AND ${visibility}
        AND (${minMatchups} = 0 OR jsonb_array_length(qp.payload->'matchups') >= ${minMatchups})
        AND NOT EXISTS (
          SELECT 1 FROM wl_questions w
          JOIN wl_tournaments wt ON wt.id = w.tournament_id
          WHERE w.source_question_id = q.id
            AND wt.created_at > NOW() - make_interval(days => ${WL_REPEAT_AVOID_DAYS})
        )
      ORDER BY (q.visibility = 'wl_private') DESC, ${order}
      LIMIT ${pageSize} OFFSET ${offset}
    `;
    if (rows.length === 0) break;
    for (const r of rows) {
      if (picked.length >= need) break;
      if (payloadFullyBilingual(r.prompt, r.payload)) picked.push(r);
    }
    if (rows.length < pageSize) break;
  }
  return picked;
}

interface SlotInsert {
  gameIndex: number;
  roundIndex: number | null;
  questionIndex: number | null;
  reserveOrdinal: number;
  kind: WlRoundKind;
  payload: Record<string, unknown>;
  evaluation: Record<string, unknown>;
  sourceQuestionId: string;
}

/** Split a source row into WL payload (display) + evaluation (answers). */
function splitSource(kind: WlRoundKind, source: SourceRow, matchupIndex?: number): {
  payload: Record<string, unknown>;
  evaluation: Record<string, unknown>;
} {
  const p = source.payload;
  switch (kind) {
    case 'mcq': {
      const options = (p['options'] as Array<Record<string, unknown>> ?? []);
      return {
        payload: {
          prompt: source.prompt,
          options: options.map((o) => ({ id: o['id'], text: o['text'] })),
          image: p['image'] ?? null,
        },
        evaluation: { correct_id: options.find((o) => o['is_correct'] === true)?.['id'] ?? null },
      };
    }
    case 'true_false': {
      const options = (p['options'] as Array<Record<string, unknown>> ?? []);
      return {
        payload: { prompt: source.prompt },
        evaluation: { correct_id: options.find((o) => o['is_correct'] === true)?.['id'] ?? null },
      };
    }
    case 'higher_lower': {
      const matchups = (p['matchups'] as Array<Record<string, unknown>> ?? []);
      const m = matchups[matchupIndex ?? 0] ?? matchups[0]!;
      return {
        payload: {
          stat_label: p['stat_label'],
          left_name: m['left_name'],
          right_name: m['right_name'],
        },
        evaluation: {
          left_value: m['left_value'],
          right_value: m['right_value'],
        },
      };
    }
    case 'career_path':
      return {
        payload: { clubs: p['clubs'] },
        evaluation: {
          display_answer: p['display_answer'],
          accepted_answers: p['accepted_answers'],
        },
      };
    case 'who_am_i':
      return {
        payload: { clues: p['clues'] },
        evaluation: {
          display_answer: p['display_answer'],
          accepted_answers: p['accepted_answers'],
        },
      };
  }
}

export interface WlSeedResult {
  ok: boolean;
  inserted: number;
  shortages?: Partial<Record<WlRoundKind, { need: number; have: number }>>;
}

export async function wlSeedTournamentContent(input: {
  tournamentId: string;
  allowPublicBank: boolean;
  deterministic?: boolean;
}): Promise<WlSeedResult> {
  const already = await sql<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM wl_questions WHERE tournament_id = ${input.tournamentId}
  `;
  if ((already[0]?.n ?? 0) > 0) return { ok: true, inserted: 0 };

  // Draw everything first; only insert when EVERY kind is satisfiable.
  const drawn = new Map<WlRoundKind, SourceRow[]>();
  const shortages: WlSeedResult['shortages'] = {};
  for (const kind of WL_ROUND_ORDER) {
    const need = wlSourceNeedPerKind(kind);
    const rows = await drawSources(kind, need, input.allowPublicBank, input.deterministic ?? false, input.tournamentId);
    if (rows.length < need) {
      shortages[kind] = { need, have: rows.length };
    }
    drawn.set(kind, rows);
  }
  if (Object.keys(shortages).length > 0) {
    logger.error({ tournamentId: input.tournamentId, shortages }, 'WL content seeding short on stock');
    return { ok: false, inserted: 0, shortages };
  }

  const slots: SlotInsert[] = [];
  for (let game = 0; game < WL_GAME_COUNT; game += 1) {
    for (let round = 0; round < WL_ROUND_ORDER.length; round += 1) {
      const kind = WL_ROUND_ORDER[round]!;
      const pool = drawn.get(kind)!;
      if (kind === 'higher_lower') {
        const source = pool.shift()!;
        for (let step = 0; step < WL_QUESTIONS_PER_ROUND[kind]; step += 1) {
          const { payload, evaluation } = splitSource(kind, source, step);
          slots.push({
            gameIndex: game, roundIndex: round, questionIndex: step,
            reserveOrdinal: 0, kind, payload, evaluation, sourceQuestionId: source.id,
          });
        }
      } else {
        for (let qi = 0; qi < WL_QUESTIONS_PER_ROUND[kind]; qi += 1) {
          const source = pool.shift()!;
          const { payload, evaluation } = splitSource(kind, source);
          slots.push({
            gameIndex: game, roundIndex: round, questionIndex: qi,
            reserveOrdinal: 0, kind, payload, evaluation, sourceQuestionId: source.id,
          });
        }
      }
    }
    // Reserves per (game, kind).
    for (const kind of WL_ROUND_ORDER) {
      const pool = drawn.get(kind)!;
      for (let r = 1; r <= WL_RESERVES_PER_KIND; r += 1) {
        const source = pool.shift()!;
        const { payload, evaluation } = splitSource(kind, source, 0);
        slots.push({
          gameIndex: game, roundIndex: null, questionIndex: null,
          reserveOrdinal: r, kind, payload, evaluation, sourceQuestionId: source.id,
        });
      }
    }
  }

  await sql.begin(async (tx) => {
    const txSql = tx as unknown as typeof sql;
    for (const slot of slots) {
      await txSql`
        INSERT INTO wl_questions (
          tournament_id, game_index, round_index, question_index,
          reserve_ordinal, kind, payload, evaluation, source_question_id
        )
        VALUES (
          ${input.tournamentId}, ${slot.gameIndex}, ${slot.roundIndex},
          ${slot.questionIndex}, ${slot.reserveOrdinal}, ${slot.kind},
          ${sql.json(slot.payload as never)}, ${sql.json(slot.evaluation as never)},
          ${slot.sourceQuestionId}
        )
      `;
    }
  });
  logger.info({ tournamentId: input.tournamentId, inserted: slots.length }, 'WL content seeded');
  return { ok: true, inserted: slots.length };
}
