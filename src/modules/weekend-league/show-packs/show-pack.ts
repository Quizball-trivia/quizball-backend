/**
 * Show packs: the hand-written question set for one host-run show night
 * (ორშაბათობა, every Monday). A pack is an ordered list of rounds; every
 * question is answered with ONE tap, so the live engine scores it as a
 * multiple-choice (or true/false) question: answer === correct option id.
 * The `show` block only tells the client how to present it (zoom-out,
 * crest/kit evolution, odd one out, fake fact).
 *
 * Packs live in the wl_show_packs table (see ./index.ts), never in this
 * public repo; this schema validates them on load and in the loader script.
 */

import { createHash } from 'node:crypto';
import { z, type ZodIssue } from 'zod';
import type { SlotInsert } from '../wl-seeder.js';

export const SHOW_KINDS = ['true_false', 'mcq', 'zoom_out', 'evolution', 'odd_one_out', 'fake_fact', 'put_in_order', 'career_path', 'who_am_i'] as const;
/** Weekend League kinds a show can play: the question is a Weekend League question copied as the engine plays it
 *  (payload + evaluation), not a hand-written one-tap question. */
export const SHOW_WL_KINDS = new Set<string>(['put_in_order', 'career_path', 'who_am_i']);
/** The weekly host-run shows the orchestrator loads packs for. */
export const SHOW_PACK_SLUGS = ['orshabatoba'] as const;
export type ShowKind = (typeof SHOW_KINDS)[number];

/** A show-night elimination: keep the top keep_percent % (rounded up) or the top keep_count players. */
export const WL_SHOW_CUT = z.object({
  keep_percent: z.number().int().min(1).max(99).optional(),
  keep_count: z.number().int().min(1).max(10_000).optional(),
}).refine((c) => (c.keep_percent == null) !== (c.keep_count == null), 'cut needs exactly one of keep_percent / keep_count');


/** Georgian is required; English falls back to Georgian. */
const text = z.object({ ka: z.string().trim().min(1), en: z.string().trim().min(1).optional() });
/** An image URL: absolute https, or a web-relative /assets/... path. */
const image = z.string().trim().regex(/^(https:\/\/|\/)\S+$/);

const option = z.object({
  id: z.string().regex(/^[a-z0-9_-]{1,24}$/),
  text,
  image: image.optional(),
});

const question = z.object({
  prompt: text,
  /** Omitted for true_false (the answer ids are 'true' / 'false'). */
  options: z.array(option).min(2).max(6).optional(),
  /** The correct option id ('true' / 'false' for true_false; the FAKE statement for fake_fact). */
  correct: z.string().min(1).optional(),
  image: image.optional(),
  /** zoom_out: where the close-up starts (fractions of the picture). */
  focus: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).optional(),
  /** evolution: oldest first, revealed one era at a time. */
  eras: z.array(z.object({ year: z.number().int().min(1850).max(2100), image })).min(2).max(8).optional(),
  /** fake_fact: the footballer; odd_one_out: the link. */
  subject: z.object({ name: text, image: image.optional() }).optional(),
  /** put_in_order / career_path / who_am_i: the Weekend League question as the engine plays it. */
  wl: z.object({
    payload: z.record(z.unknown()),
    evaluation: z.record(z.unknown()),
    source_question_id: z.string().uuid().nullable().optional(),
  }).optional(),
});

const round = z.object({
  kind: z.enum(SHOW_KINDS),
  title: text.optional(),
  questions: z.array(question).min(1).max(15),
  /** Elimination at the end of this round (see WL_SHOW_CUT). */
  cut: WL_SHOW_CUT.optional(),
});

export const showPackSchema = z.object({
  slug: z.enum(SHOW_PACK_SLUGS),
  /** The Monday (YYYY-MM-DD, Georgian time) this pack is for. */
  eventDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine((d) => {
      const day = new Date(`${d}T00:00:00Z`);
      // Round-trip rejects impossible dates (2026-02-30 would roll to March 2).
      return !Number.isNaN(day.getTime()) && day.toISOString().slice(0, 10) === d && day.getUTCDay() === 1
        && day.getUTCFullYear() >= 2026 && day.getUTCFullYear() <= 2100;
    }, 'eventDate must be a real Monday'),
  rounds: z.array(round).min(1).max(24),
}).superRefine((pack, ctx) => {
  pack.rounds.forEach((r, ri) => r.questions.forEach((q, qi) => {
    const at = (msg: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message: `round ${ri + 1} q${qi + 1}: ${msg}`, path: ['rounds', ri, 'questions', qi] });
    if (SHOW_WL_KINDS.has(r.kind)) {
      if (!q.wl) { at(`${r.kind} needs the wl question (payload + evaluation)`); return; }
      const { payload: pl, evaluation: ev } = q.wl;
      const arr = (v: unknown) => (Array.isArray(v) ? v : []);
      if (r.kind === 'put_in_order') {
        const ids = arr(pl['items']).map((it) => String((it as Record<string, unknown> | null)?.['id'] ?? ''));
        const order = arr(ev['order']).map(String);
        if (ids.length < 2 || ids.some((id) => id === '')) at('put_in_order needs items with ids');
        else if (order.length !== ids.length || [...order].sort().join('|') !== [...ids].sort().join('|')) at('put_in_order order must list every item id once');
      } else {
        const content = r.kind === 'career_path' ? arr(pl['clubs']) : arr(pl['clues']);
        if (content.length < (r.kind === 'who_am_i' ? 5 : 2)) at(`${r.kind} needs ${r.kind === 'career_path' ? 'clubs' : '5 clues'}`);
        const accepted = arr(ev['accepted_answers']).filter((a) => typeof a === 'string' && a.trim() !== '');
        if (accepted.length === 0) at(`${r.kind} needs accepted_answers`);
        if (!ev['display_answer']) at(`${r.kind} needs display_answer`);
      }
      return;
    }
    if (!q.correct) { at('correct is required'); return; }
    if (r.kind === 'true_false') {
      if (q.options) at('true_false takes no options');
      if (q.correct !== 'true' && q.correct !== 'false') at("true_false correct must be 'true' or 'false'");
      return;
    }
    if (!q.options) { at('options are required'); return; }
    const ids = q.options.map((o) => o.id);
    if (new Set(ids).size !== ids.length) at('duplicate option ids');
    // Never echo the value: an editor may have typed the answer text here.
    if (!ids.includes(q.correct)) at('correct is not one of the option ids');
    if (r.kind === 'zoom_out' && !q.image) at('zoom_out needs an image');
    if (r.kind === 'evolution' && !q.eras) at('evolution needs eras');
  }));
});

export type ShowPack = z.infer<typeof showPackSchema>;

/** Where and what failed, never the offending value (it may be answer text). */
export function redactedIssues(issues: readonly ZodIssue[]): string[] {
  return issues.slice(0, 10).map((i) => `${i.path.join('.') || '(root)'}: ${i.code === 'custom' ? i.message : i.code}`);
}
export type ShowRoundLayout = Array<{
  kind: ShowKind; count: number; title?: { ka: string; en: string }; cut?: { keep_percent?: number; keep_count?: number };
}>;

export function showPackLayout(pack: ShowPack): ShowRoundLayout {
  return pack.rounds.map((r) => ({
    kind: r.kind,
    count: r.questions.length,
    ...(r.title ? { title: i18n(r.title) } : {}),
    ...(r.cut ? { cut: r.cut } : {}),
  }));
}

/** Stable content hash: a changed stored pack (before Start) replaces the event's questions. */
export function showPackHash(pack: ShowPack): string {
  return createHash('sha256').update(JSON.stringify(pack)).digest('hex').slice(0, 16);
}

const i18n = (t: { ka: string; en?: string }) => ({ ka: t.ka, en: t.en ?? t.ka });
const img = (url: string | undefined) => (url ? { url } : null);

/** The engine rows for game 0 (single-game show). No reserves: a voided question is skipped. */
export function showPackSlots(pack: ShowPack): SlotInsert[] {
  const slots: SlotInsert[] = [];
  pack.rounds.forEach((r, roundIndex) => {
    r.questions.forEach((q, questionIndex) => {
      const show: Record<string, unknown> = { kind: r.kind };
      if (r.title) show['round_title'] = i18n(r.title);
      if (SHOW_WL_KINDS.has(r.kind) && q.wl) {
        slots.push({
          gameIndex: 0, roundIndex, questionIndex, reserveOrdinal: 0,
          kind: r.kind as SlotInsert['kind'],
          payload: { ...q.wl.payload, show },
          evaluation: q.wl.evaluation,
          sourceQuestionId: q.wl.source_question_id ?? null,
        });
        return;
      }
      if (q.focus) show['focus'] = q.focus;
      if (q.eras) show['eras'] = q.eras.map((e) => ({ year: e.year, image: { url: e.image } }));
      if (q.subject) show['subject'] = { name: i18n(q.subject.name), image: img(q.subject.image) };
      const payload: Record<string, unknown> = { prompt: i18n(q.prompt), image: img(q.image), show };
      if (r.kind !== 'true_false') {
        payload['options'] = q.options!.map((o) => ({ id: o.id, text: i18n(o.text), ...(o.image ? { image: { url: o.image } } : {}) }));
      }
      slots.push({
        gameIndex: 0, roundIndex, questionIndex, reserveOrdinal: 0,
        kind: r.kind === 'true_false' ? 'true_false' : 'mcq',
        payload,
        evaluation: { correct_id: q.correct },
        sourceQuestionId: null,
      });
    });
  });
  return slots;
}
