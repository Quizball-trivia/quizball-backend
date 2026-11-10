import { z } from 'zod';

/**
 * Mentalista, pure and self-contained (invented universe only — no real quiz content lives here or in its fixtures).
 * A room of 3–6 seats plays one chooser cycle: each admitted seat is the chooser of exactly one round, on a schedule
 * frozen when the gate closes. In a round the chooser secretly commits one legal pick from a public category's
 * options; every other seat then locks one immutable prediction of that pick; the round reveals all at once. A
 * predictor whose prediction matches the chooser's pick scores +2; the chooser always scores 0.
 *
 * The secret never reaches a non-author before the reveal: a view is a function of a seat's own choice/prediction and
 * the public category only, so two states that differ solely in another seat's uncommitted-to-it secret look identical.
 */

export const MENTALISTA_MIN_SEATS = 3;
/** One chooser cycle: a match has one round per admitted seat, so never more rounds (or categories) than this. */
export const MENTALISTA_MAX_ROUNDS = 6;
/** Options a public category may offer the chooser (and thus a predictor). */
export const MENTALISTA_MIN_OPTIONS = 3;
export const MENTALISTA_MAX_OPTIONS = 8;

/** Phase clocks: strictly validated and bounded at both the options layer and the stored content. */
export const MENTALISTA_DEFAULT_TIMING = { chooseMs: 20_000, predictMs: 20_000, revealMs: 5_000 } as const;
export const MENTALISTA_TIMING_BOUNDS = {
  chooseMs: { min: 5_000, max: 60_000 },
  predictMs: { min: 5_000, max: 60_000 },
  revealMs: { min: 2_000, max: 15_000 },
} as const;
/** A scheduler deadline this far overdue is an outage: the open phase gets a fresh window, nobody is charged. */
export const MENTALISTA_OUTAGE_MS = 5_000;

export type MentalistaLocale = 'es' | 'en' | 'ka' | 'tr' | 'ru' | 'pt' | 'de' | 'fr';
const MENTALISTA_LOCALES: readonly MentalistaLocale[] = ['es', 'en', 'ka', 'tr', 'ru', 'pt', 'de', 'fr'];

const text = (max: number) => z.string().trim().min(1).max(max);
/** es/en/ka/tr are required; ru/pt/de/fr are optional and fall back to English. */
const localized = z.object({
  es: text(200), en: text(200), ka: text(200), tr: text(200),
  ru: text(200).optional(), pt: text(200).optional(), de: text(200).optional(), fr: text(200).optional(),
}).strict();
export type MentalistaLocalized = z.infer<typeof localized>;
export const pickText = (value: MentalistaLocalized, locale: string): string =>
  value[(MENTALISTA_LOCALES as readonly string[]).includes(locale) ? (locale as MentalistaLocale) : 'en'] ?? value.en;

/**
 * A visible label, normalized for a per-locale uniqueness check: Unicode NFKC, outer trim, inner whitespace collapsed,
 * lowercased. Two options whose names only differ by case, spacing or compatibility form would read identically on a
 * seat's screen, so they are treated as the same label even though their canonical ids stay distinct.
 */
const normalizeLabel = (s: string): string => s.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * No two options of a category may show the same effective visible label in ANY supported locale — including the
 * English fallback a missing locale resolves to. Distinct canonical ids are still required separately; this guards the
 * human-readable names (what a predictor actually points at), so a round can never offer two indistinguishable picks.
 */
const optionLabelsDistinctPerLocale = (options: readonly MentalistaOption[]): boolean =>
  MENTALISTA_LOCALES.every((locale) => {
    const labels = options.map((o) => normalizeLabel(pickText(o.name, locale)));
    return new Set(labels).size === labels.length;
  });

const bounded = (b: { min: number; max: number }) => z.number().int().min(b.min).max(b.max);
/**
 * The room host's timing choice — FLAT optional clocks. The shared lobby options transport (`lobbyRoomOptionsSchema`)
 * carries only flat string/number/boolean primitives, so a nested `{ timing: {...} }` blob would never survive it; the
 * host therefore tunes the clocks as top-level fields. Unknown fields rejected; each clock bounded; all optional (the
 * defaults fill the rest). Only the host options are flat — the stored content keeps its own nested `timing` block
 * (see `timingContentSchema` / `mentalistaContentSchema`).
 */
export const mentalistaOptionsSchema = z.object({
  chooseMs: bounded(MENTALISTA_TIMING_BOUNDS.chooseMs).optional(),
  predictMs: bounded(MENTALISTA_TIMING_BOUNDS.predictMs).optional(),
  revealMs: bounded(MENTALISTA_TIMING_BOUNDS.revealMs).optional(),
}).strict();
export type MentalistaTiming = { chooseMs: number; predictMs: number; revealMs: number };

/** Resolves a raw (flat) option blob to a full timing, or undefined when it is not a legal Mentalista option. */
export function resolveTiming(raw: unknown): MentalistaTiming | undefined {
  if (raw === null || raw === undefined) return { ...MENTALISTA_DEFAULT_TIMING };
  const parsed = mentalistaOptionsSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  return { ...MENTALISTA_DEFAULT_TIMING, ...parsed.data };
}

/** One legal pick the chooser may commit to: a stable id (what "a legal player ID" means) and its display name. */
export const mentalistaOptionSchema = z.object({
  id: text(64),
  name: localized,
}).strict();
export type MentalistaOption = z.infer<typeof mentalistaOptionSchema>;

/** A public category: the prompt and the options, both shown to every seat and unaffected by anyone's secret. */
export const mentalistaCategorySchema = z.object({
  id: text(64),
  difficulty: z.enum(['easy', 'medium', 'hard']),
  prompt: localized,
  options: z.array(mentalistaOptionSchema).min(MENTALISTA_MIN_OPTIONS).max(MENTALISTA_MAX_OPTIONS),
}).strict()
  .refine((c) => new Set(c.options.map((o) => o.id)).size === c.options.length, 'An option id appears twice')
  .refine((c) => optionLabelsDistinctPerLocale(c.options), 'Two options share a visible label in a supported locale');
export type MentalistaCategory = z.infer<typeof mentalistaCategorySchema>;

const timingContentSchema = z.object({
  chooseMs: bounded(MENTALISTA_TIMING_BOUNDS.chooseMs),
  predictMs: bounded(MENTALISTA_TIMING_BOUNDS.predictMs),
  revealMs: bounded(MENTALISTA_TIMING_BOUNDS.revealMs),
}).strict();

/**
 * A dealt pack: the resolved (re-validated) timing and one category per potential round. At least MIN_SEATS and never
 * more than MAX_ROUNDS categories, so any admitted roster (3–6) has a distinct category for every one of its rounds.
 */
export const mentalistaContentSchema = z.object({
  timing: timingContentSchema,
  categories: z.array(mentalistaCategorySchema).min(MENTALISTA_MIN_SEATS).max(MENTALISTA_MAX_ROUNDS),
}).strict().refine((c) => new Set(c.categories.map((x) => x.id)).size === c.categories.length, 'A category appears twice');
export type MentalistaContent = z.infer<typeof mentalistaContentSchema>;

export interface MentalistaPublicOption { id: string; name: string }
export interface MentalistaPublicCategory { id: string; prompt: string; options: MentalistaPublicOption[] }

/** What any seat may see of a category: the prompt and the options, never anyone's pick or prediction. */
export const publicCategory = (category: MentalistaCategory, locale: string): MentalistaPublicCategory => ({
  id: category.id,
  prompt: pickText(category.prompt, locale),
  options: category.options.map((o) => ({ id: o.id, name: pickText(o.name, locale) })),
});

/** A predictor whose prediction equals the committed pick scores +2; everyone else (including the chooser) scores 0. */
export const MENTALISTA_MATCH_POINTS = 2;
export const pointsFor = (matched: boolean): number => (matched ? MENTALISTA_MATCH_POINTS : 0);
