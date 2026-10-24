import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * Dato falso futbolero, pure and shared by the daily and the rooms: a card is one footballer, one claim and five
 * options, four true and one fake. Find the fake. Right +1, wrong or no answer 0; Doble o nada makes it +2 / −1.
 * Descartar 2 greys out two true options. Each joker once per daily or per match.
 */

export const DF_CATEGORIES = ['clubs', 'leagues', 'worldCups', 'numbers', 'trophies', 'coachedClubs'] as const;
export type DfCategory = (typeof DF_CATEGORIES)[number];
export const DF_DIFFICULTIES = ['easy', 'medium', 'hard'] as const;
export type DfDifficulty = (typeof DF_DIFFICULTIES)[number];
export type DfJoker = 'cut' | 'double';
export const DF_LOCALES = ['en', 'es', 'ka', 'tr', 'ru', 'pt', 'de'] as const;
export type DfLocale = (typeof DF_LOCALES)[number];

/** Both seeders (days and room pool) take this lock, so the daily / room overlap check cannot be raced. */
export const DATO_FALSO_CONTENT_LOCK = 'dato_falso_content';
/**
 * Who a card is about, for keeping the dailies and the room pool apart: a footballer is on one side only, whatever the
 * claim (a room card about his clubs would help with a daily card about his leagues). By id and by name, since one
 * person can come from two sources under two ids.
 */
export const dfPlayerKeys = (card: Pick<DfCard, 'player'>): { id: string; name: string } => ({
  id: card.player.id,
  name: card.player.name.en.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(),
});

export const DF_OPTIONS = 5;
export const DF_CARDS = 10;
/** The difficulty curve of a day and of a match. */
export const DF_ORDER: readonly DfDifficulty[] = ['easy', 'medium', 'easy', 'medium', 'hard', 'medium', 'easy', 'hard', 'medium', 'hard'];
export const DF_PACK_WANTED = { easy: 3, medium: 4, hard: 3 } as const;

/** Limits validate.py mirrors (per locale). */
export const DF_LIMITS = { name: 60, label: 40, explain: 180, id: 64 } as const;
/** Days between two cards about the same footballer in the dailies. */
export const DF_PLAYER_GAP_DAYS = 7;

const text = (max: number) => z.string().trim().min(1).max(max);
/** pt and de are optional until every card carries them; pick() falls back to English. */
const localized = (max: number) => z.object({ en: text(max), es: text(max), ka: text(max), tr: text(max), ru: text(max), pt: text(max).optional(), de: text(max).optional() }).strict();
export type DfLocalized = z.infer<ReturnType<typeof localized>>;

const assetUrl = z.string().max(400).regex(/^(https:\/\/|\/assets\/)/, 'Expected an https URL or a /assets/ path');

export const dfArtSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('crest'), src: assetUrl }).strict(),
  z.object({ kind: z.literal('flag'), src: assetUrl }).strict(),
  z.object({ kind: z.literal('trophy'), src: assetUrl.optional() }).strict(),
  z.object({ kind: z.literal('shirt'), number: z.number().int().min(0).max(99) }).strict(),
  z.object({ kind: z.literal('text') }).strict(),
]);
export type DfArt = z.infer<typeof dfArtSchema>;

export const dfCardSchema = z.object({
  id: text(DF_LIMITS.id).regex(/^[a-z0-9-]+$/),
  category: z.enum(DF_CATEGORIES),
  difficulty: z.enum(DF_DIFFICULTIES),
  player: z.object({ id: text(DF_LIMITS.id), name: localized(DF_LIMITS.name), portrait: assetUrl.nullable() }).strict(),
  options: z.array(z.object({ label: localized(DF_LIMITS.label), art: dfArtSchema }).strict()).length(DF_OPTIONS),
  fake: z.number().int().min(0).max(DF_OPTIONS - 1),
  explain: localized(DF_LIMITS.explain),
}).strict().superRefine((card, ctx) => {
  for (const locale of DF_LOCALES) {
    // An option still without its pt or de label is shown in English, so that is the text it must not repeat.
    const labels = card.options.map((o) => (o.label[locale] ?? o.label.en).toLocaleLowerCase(locale));
    if (new Set(labels).size !== labels.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Two options read the same in ${locale}` });
  }
});
export type DfCard = z.infer<typeof dfCardSchema>;

export const pick = (value: DfLocalized, locale: string): string => value[(DF_LOCALES as readonly string[]).includes(locale) ? (locale as DfLocale) : 'en'] ?? value.en;

/** A card's points: right +1, otherwise 0; doubled, +2 or −1 (a doubled card left unanswered counts as wrong). */
export const pointsFor = (right: boolean, doubled: boolean): number => (right ? (doubled ? 2 : 1) : doubled ? -1 : 0);

/**
 * The two true options Descartar 2 greys out: fixed by the salt, the card and who asks (a retried move never
 * rerolls), and drawn only among the true ones, so they say nothing about which is the fake beyond what they remove.
 */
export function cutFor(card: Pick<DfCard, 'id' | 'fake'>, salt: string, who: string | number = ''): number[] {
  const rank = (option: number) => createHash('sha256').update(`${salt}:${card.id}:${who}:${option}`).digest('hex');
  return [...Array(DF_OPTIONS).keys()]
    .filter((option) => option !== card.fake)
    .sort((a, b) => (rank(a) < rank(b) ? -1 : 1))
    .slice(0, 2)
    .sort((a, b) => a - b);
}

export interface DfPublicOption { label: string; art: DfArt }
export interface DfPublicCard { id: string; category: DfCategory; player: { name: string; portrait: string | null }; options: DfPublicOption[] }

/** What a player may see of a card before its reveal: never the fake, never the explanation. */
export const publicCard = (card: DfCard, locale: string): DfPublicCard => ({
  id: card.id,
  category: card.category,
  player: { name: pick(card.player.name, locale), portrait: card.player.portrait },
  options: card.options.map((o) => ({ label: pick(o.label, locale), art: o.art })),
});

export interface DfRevealed { fake: number; explain: string }
export const revealOf = (card: DfCard, locale: string): DfRevealed => ({ fake: card.fake, explain: pick(card.explain, locale) });
