import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ENTITY_KINDS, SUGGEST_LIMIT, SUGGEST_MAX, TENABLE_MATCHER_VERSION, type Directory } from './tenable.identify.js';

export const TENABLE_LOCALES = ['es', 'en', 'ka', 'tr', 'ru', 'pt'] as const;
export type TenableLocale = (typeof TENABLE_LOCALES)[number];
export const SLOTS = 10;
/** Same cap as the answer box and the report endpoint: every slot must be typeable in full. */
export const ANSWER_MAX_LENGTH = 60;
export const TITLE_MAX_LENGTH = 90;
/** The ranking rule under the title (small print: eligibility, tie-break, what counts). */
export const NOTE_MAX_LENGTH = 200;

/** Russian is optional: existing lists get theirs from tenable_list_ru (see tenable.text.ts), English stands in for it. */
const localized = (max: number) => z.object({
  es: z.string().trim().min(1).max(max), en: z.string().trim().min(1).max(max),
  ka: z.string().trim().min(1).max(max), tr: z.string().trim().min(1).max(max),
  ru: z.string().trim().min(1).max(max).optional(), pt: z.string().trim().min(1).max(max).optional(),
}).strict();

/** What a Russian title was translated from: the English title and note. A list corrected in English no longer matches it. */
export const russianTextSource = (list: Pick<TenableList, 'title' | 'note'>): string =>
  createHash('sha256').update(JSON.stringify([list.title.en, list.note?.en ?? null])).digest('hex').slice(0, 16);

/** The figure behind a rank, rendered per locale from its unit ("141 goals", "141 goles"). */
export const FIGURE_UNITS = ['goals', 'apps', 'caps', 'titles', 'eur_m', 'assists', 'wins', 'points', 'seasons', 'year', 'none'] as const;
export type FigureUnit = (typeof FIGURE_UNITS)[number];

/**
 * One hidden top-10 list, the unit of the solo days and of the room pool. `slots` are entity ids of the list's kind,
 * best first; nothing in it may reach a client before the list (or its day) is revealed.
 */
export const tenableListSchema = z.object({
  id: z.string().min(1).max(80),
  kind: z.enum(ENTITY_KINDS),
  /** The entity release the slots were checked against, and the matcher version that checked them. */
  release: z.string().min(3).max(40),
  matcher: z.literal(TENABLE_MATCHER_VERSION),
  tier: z.enum(['easy', 'medium', 'hard']),
  topicKey: z.string().min(1).max(80),
  title: localized(TITLE_MAX_LENGTH),
  /** The visible ranking rule when it is not obvious from the title (a tie-break, an as-of date). */
  note: localized(NOTE_MAX_LENGTH).nullable(),
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  slots: z.array(z.object({
    eid: z.string().min(1).max(64),
    figure: z.object({ value: z.number().finite().nonnegative(), unit: z.enum(FIGURE_UNITS) }).strict(),
  }).strict()).length(SLOTS),
}).strict().superRefine((list, ctx) => {
  if (new Set(list.slots.map((s) => s.eid)).size !== SLOTS) ctx.addIssue({ code: 'custom', message: 'a list names ten different entities', path: ['slots'] });
});
export type TenableList = z.infer<typeof tenableListSchema>;

/**
 * What a list needs against its directory before it may be published: every slot exists and can be reached by typing
 * its own full name (the matcher decides it means that entity, not "ambiguous"), or by picking its suggestion when the
 * name is shared. Returns the problems, empty when the list is playable.
 */
export function listProblems(list: TenableList, directory: Directory): string[] {
  const problems: string[] = [];
  if (directory.kind !== list.kind) problems.push(`directory is ${directory.kind}, list is ${list.kind}`);
  if (directory.releaseId !== list.release) problems.push(`directory release ${directory.releaseId} ≠ list release ${list.release}`);
  list.slots.forEach((slot, i) => {
    const entity = directory.entity(slot.eid);
    if (!entity) { problems.push(`slot ${i + 1}: ${slot.eid} is not in the release`); return; }
    // What the answer box can really send: a typed name of at most ANSWER_MAX_LENGTH that the matcher reads as this
    // entity, or a suggestion found by typing its name (the box searches the first SUGGEST_MAX letters and sends the id).
    const typeable = [entity.name, entity.known, ...entity.aliases].filter((form) => form.length <= ANSWER_MAX_LENGTH);
    const typed = typeable.some((form) => { const id = directory.identify(form); return id.kind === 'entity' && id.eid === slot.eid; });
    const shown = directory.suggest(entity.name.slice(0, SUGGEST_MAX), SUGGEST_LIMIT);
    const mine = shown.find((s) => s.eid === slot.eid);
    if (!typed && !mine) problems.push(`slot ${i + 1}: ${slot.eid} can be neither typed nor picked`);
    // A namesake shown the same way (same name, same or no qualifier) would make the pick a coin toss.
    if (mine && shown.some((s) => s.eid !== slot.eid && s.label === mine.label && (s.qualifier ?? null) === (mine.qualifier ?? null))) {
      problems.push(`slot ${i + 1}: ${slot.eid} looks the same as a namesake in the suggestions`);
    }
  });
  return problems;
}
