import { z } from 'zod';
import { normalizeAnswer } from '../pistas/pistas.normalize.js';

export const ULTIMO_LOCALES = ['es', 'en', 'ka', 'tr'] as const;
export type UltimoLocale = (typeof ULTIMO_LOCALES)[number];
export type LocalizedText = Record<UltimoLocale, string>;

const text = z.string().trim().min(1).max(200);
const localized = z.object({ es: text, en: text, ka: text, tr: text });
/** An answer name must be typeable in the answer box (UL_ANSWER_MAX_LENGTH). */
const name = z.string().trim().min(1).max(60);

/**
 * One closed-list category, the unit of both the solo days and the duel pool. Aliases may be in any of the four
 * locales; no normalised name may belong to two answers of one category (the validator and this schema refuse it).
 */
export const ultimoCategorySchema = z.object({
  id: z.string().min(1).max(80),
  difficulty: z.enum(['easy', 'medium', 'hard']),
  title: localized,
  hint: localized,
  answers: z.array(z.object({
    id: z.string().min(1).max(80),
    display: z.object({ es: name, en: name, ka: name, tr: name }),
    aliases: z.array(name).max(40),
  })).min(8).max(60),
}).superRefine((category, ctx) => {
  const owner = new Map<string, string>();
  const ids = new Set<string>();
  for (const answer of category.answers) {
    if (ids.has(answer.id)) ctx.addIssue({ code: 'custom', message: `duplicate answer id ${answer.id}`, path: ['answers'] });
    ids.add(answer.id);
    for (const name of [...Object.values(answer.display), ...answer.aliases]) {
      const key = normalizeAnswer(name);
      if (!key) continue;
      const seen = owner.get(key);
      if (seen && seen !== answer.id) ctx.addIssue({ code: 'custom', message: `"${key}" names both ${seen} and ${answer.id}`, path: ['answers'] });
      owner.set(key, answer.id);
    }
  }
});
export type UltimoCategory = z.infer<typeof ultimoCategorySchema>;

export type Match = { kind: 'answer'; index: number } | { kind: 'ambiguous' } | { kind: 'none' };

type Keys = Map<string, Set<number>>;

interface CategoryIndex {
  /** Display names and aliases, normalised: unique per answer (the schema refuses a name on two answers). */
  explicit: Keys;
  explicitCompact: Keys;
  /** Generated forms (surname, name without its first word): shared by several answers they are ambiguous. */
  derived: Keys;
  derivedCompact: Keys;
}

const indexes = new WeakMap<UltimoCategory, CategoryIndex>();

const compactOf = (value: string) => value.replace(/ /g, '');

function indexOf(category: UltimoCategory): CategoryIndex {
  const cached = indexes.get(category);
  if (cached) return cached;
  const built: CategoryIndex = { explicit: new Map(), explicitCompact: new Map(), derived: new Map(), derivedCompact: new Map() };
  const put = (map: Keys, key: string, index: number) => {
    const set = map.get(key) ?? new Set<number>();
    set.add(index);
    map.set(key, set);
  };
  const add = (tier: 'explicit' | 'derived', key: string, index: number) => {
    if (!key) return;
    put(tier === 'explicit' ? built.explicit : built.derived, key, index);
    put(tier === 'explicit' ? built.explicitCompact : built.derivedCompact, compactOf(key), index);
  };
  category.answers.forEach((answer, index) => {
    for (const name of new Set(Object.values(answer.display).map(normalizeAnswer))) {
      add('explicit', name, index);
      const words = name.split(' ');
      // The name without its first word ("di maria", "mac allister", "de paul") and the bare surname: shared by
      // two answers they are ambiguous, never the first answer's.
      if (words.length > 2) add('derived', words.slice(1).join(' '), index);
      if (words.length > 1 && words[words.length - 1].length >= 3) add('derived', words[words.length - 1], index);
    }
    for (const alias of answer.aliases) add('explicit', normalizeAnswer(alias), index);
  });
  indexes.set(category, built);
  return built;
}

/** Edit distance, bounded: anything above `max` returns max + 1. */
function distance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, row[j]);
    }
    if (best > max) return max + 1;
    prev = row;
  }
  return prev[b.length];
}

const resolve = (set: Set<number> | undefined): Match | null =>
  !set || set.size === 0 ? null : set.size === 1 ? { kind: 'answer', index: [...set][0] } : { kind: 'ambiguous' };

/**
 * Which answer a typed text names, judged against the whole category (whether it was already said is the
 * caller's check, so an ambiguous surname never becomes free once the others are said). In order: a name,
 * alias, the name without its first word or a surname (spaces ignored); then one typo (two from nine letters)
 * when that points to exactly one answer. A key naming several answers, or a typo close to several, is
 * ambiguous: the player is asked for the full name and loses nothing.
 */
export function matchAnswer(category: UltimoCategory, raw: string): Match {
  const typed = normalizeAnswer(raw);
  if (typed.length < 2) return { kind: 'none' };
  // Explicit names first (unique by construction), then generated forms, then one typo.
  const index = indexOf(category);
  const target0 = compactOf(typed);
  const exact = resolve(index.explicit.get(typed)) ?? resolve(index.explicitCompact.get(target0))
    ?? resolve(index.derived.get(typed)) ?? resolve(index.derivedCompact.get(target0));
  if (exact) return exact;
  const target = compactOf(typed);
  const tolerance = target.length >= 9 ? 2 : target.length >= 5 ? 1 : 0;
  if (tolerance === 0) return { kind: 'none' };
  const close = new Set<number>();
  for (const keys of [index.explicitCompact, index.derivedCompact]) {
    for (const [key, set] of keys) {
      // A typo is only forgiven against a key of five letters or more (no near-random short keys).
      if (key.length >= 5 && distance(key, target, tolerance) <= tolerance) for (const i of set) close.add(i);
    }
  }
  return resolve(close) ?? { kind: 'none' };
}

/** Per-answer clock: 20 s, two seconds less after every two answers said, never under 6 s. */
export const UL_TURN_START_MS = 20_000;
export const UL_TURN_STEP_MS = 2_000;
export const UL_TURN_MIN_MS = 6_000;
export const UL_MAX_MISSES = 3;
export const UL_ANSWER_MAX_LENGTH = 60;
export const turnMsFor = (said: number): number => Math.max(UL_TURN_MIN_MS, UL_TURN_START_MS - UL_TURN_STEP_MS * Math.floor(said / 2));

export const copyText = (t: LocalizedText): LocalizedText => ({ es: t.es, en: t.en, ka: t.ka, tr: t.tr });
