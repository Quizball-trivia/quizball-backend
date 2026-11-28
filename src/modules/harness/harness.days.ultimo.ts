import { logger } from '../../core/logger.js';
import type { sql } from '../../db/index.js';
import { normalizeAnswer } from '../pistas/pistas.normalize.js';
import { addDays, dayNumber } from '../ultimo/ultimo.days.js';
import { ultimoCategorySchema, unreachableAnswers, type UltimoCategory } from '../ultimo/ultimo.match.js';
import { keysOf, parseDayFile, publishedKeys, repeatedLists, sameKeys, seedDaysWithin, ULTIMO_CONTENT_LOCK, type CategoryKeys } from '../ultimo/ultimo.seed.js';

// The Day Builder for Último: a day is five closed lists ("Clubs Diego Simeone
// played for or managed"), and the player names their members against a
// clock. A round here is one list. Agents choose it, write it out in full,
// check that it is complete and translate it (the harness worker); this file
// turns a finished list into the game's own category and puts five of them
// together into the next day, stored through the game's own seed.

type Db = typeof sql;
type Difficulty = 'easy' | 'medium' | 'hard';

const LOCALES = ['es', 'en', 'ka', 'tr', 'ru', 'pt', 'de', 'fr', 'el'] as const;
type Locale = (typeof LOCALES)[number];
type AllText = Record<Locale, string>;

/** The difficulty of each of a day's five lists, in order: every stored day follows it. */
export const ULTIMO_PATTERN: readonly Difficulty[] = ['easy', 'easy', 'medium', 'medium', 'hard'];
export const ULTIMO_PER_DAY: Record<Difficulty, number> = { easy: 2, medium: 2, hard: 1 };
const NAME_MAX = 60;
const TEXT_MAX = 200;

/** A list after the completeness check, in English. */
export interface CheckedList {
  title: string;
  hint: string;
  answers: Array<{ name: string; aliases: string[] }>;
}

/** The same list in every language, answer by answer in the same order. */
export interface LocalizedList {
  title: Partial<AllText>;
  hint: Partial<AllText>;
  answers: Array<{ display: Partial<AllText>; aliases?: string[] }>;
}

const allText = (value: unknown, max: number): AllText | null => {
  const v = (value ?? {}) as Record<string, unknown>;
  const out = {} as AllText;
  for (const locale of LOCALES) {
    const text = typeof v[locale] === 'string' ? (v[locale] as string).trim() : '';
    if (!text || text.length > max) return null;
    out[locale] = text;
  }
  return out;
};

/** Pure: a short id out of a name: lower case, letters and digits, hyphens between. */
export function slug(value: string, max = 60): string {
  return (
    normalizeAnswer(value)
      .replace(/[^a-z0-9 ]/g, '')
      .trim()
      .replace(/ +/g, '-')
      .slice(0, max)
      .replace(/-+$/, '') || 'x'
  );
}

/**
 * Pure: a finished list as the game stores a category, or the reason it cannot be one. Every answer must have a
 * name in every language; a spelling that would also name another answer of the list is left out (the game refuses
 * a name that fits two answers); the game's own schema has the last word.
 */
export function ultimoCategory(number: number, difficulty: Difficulty, checked: CheckedList, localized: LocalizedList): { ok: true; category: UltimoCategory } | { ok: false; why: string } {
  const fail = (why: string) => ({ ok: false as const, why });
  if (!checked || typeof checked !== 'object' || !Array.isArray(checked.answers) || typeof checked.title !== 'string') return fail('its checked list is not in the shape expected');
  if (!localized || typeof localized !== 'object' || !Array.isArray(localized.answers)) return fail('its translations are not in the shape expected');
  if (localized.answers.length !== checked.answers.length) return fail('the translations do not match the list answer for answer');
  const title = allText(localized.title, TEXT_MAX);
  const hint = allText(localized.hint, TEXT_MAX);
  if (!title) return fail('the title is missing in a language, or too long');
  if (!hint) return fail('the hint is missing in a language, or too long');

  const displays: AllText[] = [];
  for (const [i, a] of localized.answers.entries()) {
    const display = allText(a?.display, NAME_MAX);
    if (!display) return fail(`answer ${i + 1} has no name in a language, or one too long to type`);
    displays.push(display);
  }
  // Who each spelling belongs to: the names shown come first, so an alias never takes a name another answer shows.
  const owner = new Map<string, number>();
  for (const [i, display] of displays.entries()) {
    for (const name of Object.values(display)) {
      const key = normalizeAnswer(name);
      if (!key) continue;
      const seen = owner.get(key);
      if (seen !== undefined && seen !== i) return fail(`answers ${seen + 1} and ${i + 1} have the same name in a language`);
      owner.set(key, i);
    }
  }
  const ids = new Set<string>();
  const answers = checked.answers.map((a, i) => {
    let id = slug(typeof a?.name === 'string' ? a.name : displays[i]!.en);
    for (let n = 2; ids.has(id); n++) id = `${slug(displays[i]!.en, 56)}-${n}`;
    ids.add(id);
    const aliases: string[] = [];
    for (const raw of [...(Array.isArray(a?.aliases) ? a.aliases : []), ...(Array.isArray(localized.answers[i]?.aliases) ? localized.answers[i]!.aliases! : [])]) {
      const alias = typeof raw === 'string' ? raw.trim() : '';
      const key = normalizeAnswer(alias);
      if (!key || alias.length > NAME_MAX || aliases.length >= 40) continue;
      const seen = owner.get(key);
      // Already this answer's own name, or a spelling that names another answer too: left out.
      if (seen !== undefined) continue;
      owner.set(key, i);
      aliases.push(alias);
    }
    return { id, display: displays[i]!, aliases };
  });
  const parsed = ultimoCategorySchema.safeParse({ id: `hq${number}-${slug(checked.title, 60)}`.slice(0, 80), difficulty, title, hint, answers });
  // The issue path names the field; its message could quote an answer, so only the path is kept.
  if (!parsed.success) return fail(`the game's own shape refused it (${[...new Set(parsed.error.issues.map((issue) => issue.path.slice(0, 2).join('.') || 'shape'))].join(', ')})`);
  if (unreachableAnswers(parsed.data).length > 0) return fail('an answer has no name a player could type that means it alone');
  return { ok: true, category: parsed.data };
}

export const lastUltimoDay = async (db: Db) => (await db<Array<{ day: string | null }>>`SELECT max(day)::text AS day FROM public.ultimo_days`)[0]?.day ?? null;

/** Every list a new one may not repeat, by its English title: stored days and the duel pool. */
export async function ultimoTaken(db: Db): Promise<string[]> {
  const days = await db<Array<{ title: string | null }>>`SELECT c->'title'->>'en' AS title FROM public.ultimo_days d, jsonb_array_elements(d.categories) AS c`;
  const [pool] = await db<Array<{ present: boolean }>>`SELECT to_regclass('public.duel_pool') IS NOT NULL AS present`;
  const duel = pool?.present ? await db<Array<{ title: string | null }>>`SELECT payload->'title'->>'en' AS title FROM public.duel_pool WHERE game = 'ultimo'` : [];
  return [...days, ...duel].map((r) => r.title ?? '').filter(Boolean);
}

type Candidate = { row: ListRow; category: UltimoCategory; keys: CategoryKeys };

/**
 * Pure: five lists for one day, in the day's order of difficulty, no two of them much alike; the oldest that fit.
 * Null when no such five exist. Earlier choices are taken back when they leave a later place with no list.
 */
export function pickDay(usable: ReadonlyMap<Difficulty, readonly Candidate[]>, pattern: readonly Difficulty[] = ULTIMO_PATTERN): Candidate[] | null {
  const place = (picks: Candidate[]): Candidate[] | null => {
    if (picks.length === pattern.length) return picks;
    for (const c of usable.get(pattern[picks.length]!) ?? []) {
      if (picks.includes(c) || picks.some((p) => sameKeys(p.keys, c.keys))) continue;
      const done = place([...picks, c]);
      if (done) return done;
    }
    return null;
  };
  return place([]);
}

export interface ListRow {
  id: string;
  number: number;
  difficulty: Difficulty;
  checked: unknown;
  localized: unknown;
}

/**
 * Puts five ready lists together into the next day and stores it, inside the caller's transaction (which already
 * holds the builder's lock for this game). Returns the day, or null when there are not enough lists for one.
 * `drop` ends a list with its reason; `built` records the day.
 */
export async function ultimoDay(tx: Db, ready: ListRow[], drop: (row: ListRow, why: string) => Promise<void>, built: (day: string, number: number, rows: ListRow[]) => Promise<void>): Promise<string | null> {
  // The same lock both Último seeds take: no list can be published beside this one while it is being compared.
  await tx`SELECT pg_advisory_xact_lock(hashtext(${ULTIMO_CONTENT_LOCK}))`;
  const last = await lastUltimoDay(tx);
  if (!last) return null;
  const next = addDays(last, 1);
  const published = await publishedKeys(tx as never, 'day');
  const pool = await publishedKeys(tx as never, 'pool');

  const usable = new Map<Difficulty, Candidate[]>([['easy', []], ['medium', []], ['hard', []]]);
  // What is published plus what is kept so far: a list that is exactly one of these (same id, title or members) is a repeat.
  const known = [...published];
  for (const row of ready) {
    // Anything unexpected in a list ends that list, not the whole build.
    let made: ReturnType<typeof ultimoCategory>;
    try {
      made = ultimoCategory(row.number, row.difficulty, row.checked as CheckedList, row.localized as LocalizedList);
    } catch (err) {
      logger.warn({ err, round: row.number }, 'Day round could not be read');
      made = { ok: false, why: 'it could not be read' };
    }
    if (!made.ok) {
      await drop(row, `could not be stored: ${made.why}`);
      continue;
    }
    const keys = keysOf(made.category);
    // A closed day shows its whole list, and duel lists are played over and over: a list is a daily list once.
    // Against other daily lists only an exact repeat counts (look-alikes, such as a later squad of the same team, are
    // normal across days); against the duel pool anything alike does.
    if (repeatedLists(known, [{ day: next, categories: [made.category] }]).length > 0 || pool.some((item) => sameKeys(keys, item))) {
      await drop(row, 'this list, or one almost the same, was already used');
      continue;
    }
    known.push(keys);
    usable.get(row.difficulty)!.push({ row, category: made.category, keys });
  }

  for (let attempt = 0; attempt < 24; attempt++) {
    // One day does not carry two lists that are much alike: one of them is passed over for this day (it stays ready
    // for another), not dropped. Every combination is tried before the day is given up.
    const picks = pickDay(usable);
    if (!picks) {
      // Not enough lists yet: wait for more. Enough lists, but too alike to share any day: waiting would never end,
      // and they would fill the room new lists are ordered into. The newest of the look-alikes goes, and it is tried again.
      if ((['easy', 'medium', 'hard'] as const).some((d) => usable.get(d)!.length < ULTIMO_PER_DAY[d])) return null;
      const all = [...usable.values()].flat();
      const alike = all.filter((c) => all.some((o) => o !== c && sameKeys(o.keys, c.keys)));
      const newest = alike[alike.length - 1];
      if (!newest) return null;
      await drop(newest.row, 'too much like other lists that are waiting to share a day with any of them');
      const list = usable.get(newest.row.difficulty)!;
      list.splice(list.indexOf(newest), 1);
      continue;
    }
    const remove = (bad: (typeof picks)[number]) => {
      const list = usable.get(bad.row.difficulty)!;
      list.splice(list.indexOf(bad), 1);
    };
    let parsed;
    try {
      parsed = parseDayFile(next, { day: next, number: dayNumber(next), categories: picks.map((p) => p.category) });
    } catch (err) {
      // The seed's messages name positions and fields only, never an answer.
      const message = err instanceof Error ? err.message : 'refused';
      const at = /category (\d+)/.exec(message);
      if (!at) throw err;
      const bad = picks[Number(at[1]) - 1]!;
      await drop(bad.row, `the game's checks refused it: ${message.replace(/^[^:]*: /, '').replace(/^category \d+:? ?/, '')}`);
      remove(bad);
      continue;
    }
    try {
      await seedDaysWithin(tx as never, [parsed], { dryRun: false, allowCorrection: false, allowPoolOverlap: false, append: true });
    } catch (err) {
      // The seed names the lists that repeat a published one, as "<day> c<n>": those are dropped and the day is tried again.
      const message = err instanceof Error ? err.message : '';
      const repeats = [...message.matchAll(/ c(\d+)/g)].map((m) => picks[Number(m[1]) - 1]).filter((p): p is (typeof picks)[number] => Boolean(p));
      if (!message.includes('repeat a list already published') || repeats.length === 0) throw err;
      for (const bad of repeats) {
        await drop(bad.row, 'this list, or one almost the same, was already used');
        remove(bad);
      }
      continue;
    }
    await built(next, parsed.number, picks.map((p) => p.row));
    return next;
  }
  return null;
}
