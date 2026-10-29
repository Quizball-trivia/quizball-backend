import { createHash } from 'node:crypto';
import { z } from 'zod';
import { SUGGEST_LIMIT, SUGGEST_MAX, TENABLE_MATCHER_VERSION, type Directory } from '../tenable/tenable.identify.js';
import { ANSWER_MAX_LENGTH } from '../tenable/tenable.content.js';
import { D501 } from './darts501.rules.js';

export const D501_LOCALES = ['es', 'en', 'ka', 'tr', 'ru', 'pt', 'de'] as const;
export type D501Locale = (typeof D501_LOCALES)[number];
export const asD501Locale = (value: unknown): D501Locale => ((D501_LOCALES as readonly unknown[]).includes(value) ? (value as D501Locale) : 'en');

export const TITLE_MAX_LENGTH = 90;
export const NOTE_MAX_LENGTH = 200;
export const MIN_ENTRIES = 25;
export const MAX_ENTRIES = 3_000;
export const MAX_VALUE = 2_000;
/** Below this many values a dart can score (1..180), a category is not a game of darts. */
export const MIN_SCORING = 40;

export const D501_UNITS = ['apps', 'goals', 'assists', 'caps', 'apps_minus_goals'] as const;
export type D501Unit = (typeof D501_UNITS)[number];

const localized = (max: number) => z.object(Object.fromEntries(D501_LOCALES.map((l) => [l, z.string().trim().min(1).max(max)])) as Record<D501Locale, z.ZodString>).strict();

/**
 * One category: the unit of a solo day and of a room leg. `entries` is every footballer of the source's coverage with a
 * number in it; nothing of it reaches a client except the darts actually thrown (and, once a day is closed, its review).
 */
export const d501CategorySchema = z.object({
  id: z.string().min(1).max(80),
  kind: z.literal('player'),
  release: z.string().min(3).max(40),
  matcher: z.literal(TENABLE_MATCHER_VERSION),
  /** The coverage set misses are judged against (see darts501_coverage). */
  coverage: z.string().min(1).max(40),
  tier: z.enum(['easy', 'medium', 'hard']),
  topicKey: z.string().min(1).max(80),
  title: localized(TITLE_MAX_LENGTH),
  note: localized(NOTE_MAX_LENGTH).nullable(),
  unit: z.enum(D501_UNITS),
  /** What the numbers run to ("2024-25" or a date); always shown. */
  asOf: z.string().min(4).max(20),
  entries: z.array(z.object({ eid: z.string().min(1).max(64), value: z.number().int().min(1).max(MAX_VALUE) }).strict()).min(MIN_ENTRIES).max(MAX_ENTRIES),
}).strict().superRefine((c, ctx) => {
  if (new Set(c.entries.map((e) => e.eid)).size !== c.entries.length) ctx.addIssue({ code: 'custom', message: 'entries name each footballer once', path: ['entries'] });
  if (c.entries.filter((e) => e.value <= D501.maxDart).length < MIN_SCORING) ctx.addIssue({ code: 'custom', message: `fewer than ${MIN_SCORING} entries can score`, path: ['entries'] });
});
export type D501Category = z.infer<typeof d501CategorySchema>;

/**
 * One shared copy per category content: every match dealt the same category (and its number index, see entriesOf)
 * holds the same object instead of its own copy of up to MAX_ENTRIES entries. Bounded; a dropped one is simply rebuilt.
 */
const INTERN_MAX = 300;
const interned = new Map<string, D501Category>();
export function internCategory(c: D501Category): D501Category {
  const key = `${c.id}:${createHash('sha1').update(JSON.stringify(c)).digest('hex')}`;
  const held = interned.get(key);
  if (held) return held;
  interned.set(key, c);
  if (interned.size > INTERN_MAX) interned.delete(interned.keys().next().value!);
  return c;
}

export const textIn = (c: Pick<D501Category, 'title' | 'note'>, locale: D501Locale) => ({ title: c.title[locale], note: c.note ? c.note[locale] : null });

/**
 * What a category needs against its release before it may be published: every entry exists and is covered (a missing or
 * uncovered one would be scored as a miss or free instead of its number). Empty when the category is playable.
 */
export function categoryProblems(c: D501Category, directory: Directory, coverage: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  if (directory.releaseId !== c.release) problems.push(`directory release ${directory.releaseId} ≠ category release ${c.release}`);
  for (const { eid } of c.entries) {
    if (!directory.entity(eid)) problems.push(`${eid} is not in the release`);
    else if (!coverage.has(eid)) problems.push(`${eid} is not covered`);
  }
  return problems;
}

/** Darts within which a category must allow a checkout from 501. */
export const FINISH_DARTS = 6;

/**
 * True when at most `darts` different footballers, all throwable, check out from 501 (numbers each at most 180, summing
 * to 501..511, landing 0 to −10). A category without such a finish cannot be won in a few darts, whatever else it holds.
 */
export function finishWithin(c: D501Category, darts = FINISH_DARTS, throwable: (eid: string) => boolean = () => true): boolean {
  const counts = new Map<number, number>();
  for (const e of c.entries) if (e.value <= D501.maxDart && throwable(e.eid)) counts.set(e.value, (counts.get(e.value) ?? 0) + 1);
  const values = [...counts.keys()].sort((a, b) => b - a);
  const low = D501.start;
  const high = D501.start - D501.floor;
  // Biggest first; a value is used at most as many times as footballers have it.
  const reach = (from: number, left: number, sum: number): boolean => {
    if (sum >= low && sum <= high) return true;
    if (left === 0) return false;
    for (let i = from; i < values.length; i += 1) {
      const v = values[i];
      if (sum + v * left < low) return false;
      if (sum + v > high) continue;
      const n = counts.get(v)!;
      counts.set(v, n - 1);
      const ok = reach(n - 1 > 0 ? i : i + 1, left - 1, sum + v);
      counts.set(v, n);
      if (ok) return true;
    }
    return false;
  };
  return reach(0, darts, 0);
}

/**
 * Entries nobody can throw: their own names read as someone else (or as several people) and no suggestion tells them
 * apart. Not an error (they simply never score), but a category whose best-known entries are unreachable plays badly.
 */
export function unreachableEntries(c: D501Category, directory: Directory): string[] {
  return c.entries.flatMap(({ eid }) => {
    const entity = directory.entity(eid);
    if (!entity) return [eid];
    const typed = [entity.name, entity.known, ...entity.aliases].filter((form) => form.length <= ANSWER_MAX_LENGTH)
      .some((form) => { const id = directory.identify(form); return id.kind === 'entity' && id.eid === eid; });
    if (typed) return [];
    const shown = directory.suggest(entity.name.slice(0, SUGGEST_MAX), SUGGEST_LIMIT);
    const mine = shown.find((s) => s.eid === eid);
    const twin = mine && shown.some((s) => s.eid !== eid && s.label === mine.label && (s.qualifier ?? null) === (mine.qualifier ?? null));
    return mine && !twin ? [] : [eid];
  });
}
