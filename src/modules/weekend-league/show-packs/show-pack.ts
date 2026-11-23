/**
 * Show packs: the hand-written question set for one host-run show night
 * (ორშაბათობა, every Monday). A pack is an ordered list of rounds; every
 * question is answered with ONE tap, so the live engine scores it as a
 * multiple-choice (or true/false) question: answer === correct option id.
 * The `show` block only tells the client how to present it (zoom-out,
 * crest/kit evolution, odd one out, fake fact).
 *
 * Packs are TypeScript modules (registered in ./index.ts) so they ship in
 * the compiled build and are type-checked at build time.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { SlotInsert } from '../wl-seeder.js';

export const SHOW_KINDS = ['true_false', 'mcq', 'zoom_out', 'evolution', 'odd_one_out', 'fake_fact'] as const;
export type ShowKind = (typeof SHOW_KINDS)[number];

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
  correct: z.string().min(1),
  image: image.optional(),
  /** zoom_out: where the close-up starts (fractions of the picture). */
  focus: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).optional(),
  /** evolution: oldest first, revealed one era at a time. */
  eras: z.array(z.object({ year: z.number().int().min(1850).max(2100), image })).min(2).max(8).optional(),
  /** fake_fact: the footballer; odd_one_out: the link. */
  subject: z.object({ name: text, image: image.optional() }).optional(),
});

const round = z.object({
  kind: z.enum(SHOW_KINDS),
  title: text.optional(),
  questions: z.array(question).min(1).max(15),
});

export const showPackSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]{1,40}$/),
  /** The Monday (YYYY-MM-DD, Georgian time) this pack is for. */
  eventDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  rounds: z.array(round).min(1).max(12),
}).superRefine((pack, ctx) => {
  pack.rounds.forEach((r, ri) => r.questions.forEach((q, qi) => {
    const at = (msg: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message: `round ${ri + 1} q${qi + 1}: ${msg}`, path: ['rounds', ri, 'questions', qi] });
    if (r.kind === 'true_false') {
      if (q.options) at('true_false takes no options');
      if (q.correct !== 'true' && q.correct !== 'false') at("true_false correct must be 'true' or 'false'");
      return;
    }
    if (!q.options) { at('options are required'); return; }
    const ids = q.options.map((o) => o.id);
    if (new Set(ids).size !== ids.length) at('duplicate option ids');
    if (!ids.includes(q.correct)) at(`correct "${q.correct}" is not an option id`);
    if (r.kind === 'zoom_out' && !q.image) at('zoom_out needs an image');
    if (r.kind === 'evolution' && !q.eras) at('evolution needs eras');
  }));
});

export type ShowPack = z.infer<typeof showPackSchema>;
export type ShowRoundLayout = Array<{ kind: ShowKind; count: number }>;

export function showPackLayout(pack: ShowPack): ShowRoundLayout {
  return pack.rounds.map((r) => ({ kind: r.kind, count: r.questions.length }));
}

/** Stable content hash: a changed pack (redeploy before Start) replaces the event's questions. */
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
