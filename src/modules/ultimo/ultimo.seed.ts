import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { canonical, resolvePistasSeedTarget, SEED_TARGETS, type PistasSeedTarget } from '../pistas/pistas.seed.js';
import { normalizeAnswer } from '../pistas/pistas.normalize.js';
import { CATEGORIES_PER_DAY } from './ultimo.constants.js';
import { addDays, CONTENT_START, dayNumber, PUBLISHED_DAYS } from './ultimo.days.js';
import { ultimoCategorySchema, unreachableAnswers, type UltimoCategory } from './ultimo.match.js';

/**
 * Content seeding for scripts/ultimo-seed-days.ts: validates the private day files and upserts them into
 * ultimo_days in one transaction. Nothing here may print or echo an answer: messages name days and positions only.
 */

export { SEED_TARGETS, resolvePistasSeedTarget as resolveUltimoSeedTarget };
export type UltimoSeedTarget = PistasSeedTarget;

export interface SeedDay {
  day: string;
  number: number;
  contentVersion: number;
  categories: UltimoCategory[];
}

/** The day's content version: sha256 over the canonical JSON of the stored categories, first 8 hex digits. */
export function contentHash(categories: readonly UltimoCategory[]): number {
  const hex = createHash('sha256').update(canonical(categories)).digest('hex');
  return parseInt(hex.slice(0, 8), 16) || 1;
}

/** Validates one day file and keeps exactly the stored fields (provenance and unknown fields are dropped by the schema). */
export function parseDayFile(label: string, raw: unknown): SeedDay {
  const fail = (msg: string): never => { throw new Error(`${label}: ${msg}`); };
  const d = (raw ?? {}) as { day?: unknown; number?: unknown; categories?: unknown };
  const validDay = typeof d.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.day)
    && !Number.isNaN(Date.parse(`${d.day}T00:00:00Z`)) && addDays(d.day, 0) === d.day;
  if (!validDay) fail('day must be a valid YYYY-MM-DD');
  const day = d.day as string;
  if (day < CONTENT_START) fail(`day is before the first content day ${CONTENT_START}`);
  if (d.number !== dayNumber(day)) fail(`number must be ${dayNumber(day)}`);
  if (!Array.isArray(d.categories) || d.categories.length !== CATEGORIES_PER_DAY) fail(`expected ${CATEGORIES_PER_DAY} categories`);
  const categories = (d.categories as unknown[]).map((raw, i) => {
    const parsed = ultimoCategorySchema.safeParse(raw);
    // The issue path names the field; its message could quote an answer, so only the path is printed.
    if (!parsed.success) fail(`category ${i + 1}: invalid (${parsed.error.issues.map((issue) => issue.path.join('.') || 'shape').join(', ')})`);
    return parsed.data!;
  });
  if (new Set(categories.map((c) => c.id)).size !== categories.length) fail('duplicate category id');
  categories.forEach((category, i) => {
    if (unreachableAnswers(category).length > 0) fail(`category ${i + 1}: an answer has no typeable name that names it alone`);
  });
  return { day, number: d.number as number, contentVersion: contentHash(categories), categories };
}

/** Contiguous days from CONTENT_START covering every published day (a short set would leave later days empty). */
export function assertCalendar(days: readonly SeedDay[]): void {
  if (days.length < PUBLISHED_DAYS) throw new Error(`expected at least ${PUBLISHED_DAYS} days from ${CONTENT_START}, found ${days.length}`);
  days.forEach((d, i) => {
    const expected = addDays(CONTENT_START, i);
    if (d.day !== expected) throw new Error(`days must be contiguous from ${CONTENT_START}: position ${i + 1} is ${d.day}, expected ${expected}`);
  });
  const ids = days.flatMap((d) => d.categories.map((c) => c.id));
  if (new Set(ids).size !== ids.length) throw new Error('a category id is used on two days');
}

/** What identifies a category's content: its id, titles, and its answers (ids and names). */
export interface CategoryKeys { id: string; titles: string[]; answers: string[] }

export const keysOf = (c: UltimoCategory): CategoryKeys => ({
  id: c.id,
  titles: [normalizeAnswer(c.title.es), normalizeAnswer(c.title.en)],
  answers: [...new Set(c.answers.flatMap((a) => [`id:${a.id}`, normalizeAnswer(a.display.en), normalizeAnswer(a.display.es)]))],
});

const jaccard = (a: readonly string[], b: readonly string[]): number => {
  const sb = new Set(b);
  const shared = new Set(a.filter((k) => sb.has(k))).size;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : shared / union;
};
const answerIds = (k: CategoryKeys) => k.answers.filter((key) => key.startsWith('id:'));
const answerNames = (k: CategoryKeys) => k.answers.filter((key) => !key.startsWith('id:'));

/**
 * Two categories are the same content when they share an id, a title, or most of their answers by id OR by name
 * (measured apart, so re-keyed answers or renamed displays cannot dilute the match): a renamed or translated copy of
 * one list is still that list. Duel packs are harvestable, so a daily category may never be (like) a pool one — nor
 * one that ever was.
 */
export function sameKeys(a: CategoryKeys, b: CategoryKeys): boolean {
  if (a.id === b.id || a.titles.some((t) => b.titles.includes(t))) return true;
  return jaccard(answerIds(a), answerIds(b)) >= 0.6 || jaccard(answerNames(a), answerNames(b)) >= 0.6;
}

export const sameCategory = (a: UltimoCategory, b: UltimoCategory): boolean => sameKeys(keysOf(a), keysOf(b));

/** Both Último seeds (days and duel pool) take this lock and check overlap inside their write transaction. */
export const ULTIMO_CONTENT_LOCK = 'ultimo-content';

export type ContentSide = 'day' | 'pool';

/**
 * Every category ever published on `side`: the ledger (append-only, so a pool item replaced or disabled after its
 * list was played is still known) plus what is stored now.
 */
export async function publishedKeys(tx: Sql, side: ContentSide): Promise<CategoryKeys[]> {
  const ledger = await tx<Array<{ keys: CategoryKeys }>>`SELECT keys FROM ultimo_content_ledger WHERE side = ${side}`;
  const stored = side === 'pool'
    ? (await tx<Array<{ payload: unknown }>>`SELECT payload FROM duel_pool WHERE game = 'ultimo'`).map((r) => r.payload)
    : (await tx<Array<{ categories: unknown[] }>>`SELECT categories FROM ultimo_days`).flatMap((r) => r.categories);
  const current = stored.map((raw) => ultimoCategorySchema.safeParse(raw)).flatMap((p) => (p.success ? [keysOf(p.data)] : []));
  return [...ledger.map((r) => r.keys), ...current];
}

/** Records what a seed published (inside its write transaction); an unchanged category is recorded once. */
export async function recordPublished(tx: Sql, side: ContentSide, categories: readonly UltimoCategory[]): Promise<void> {
  for (const category of categories) {
    const keys = keysOf(category);
    await tx`
      INSERT INTO ultimo_content_ledger (side, category_id, keys)
      SELECT ${side}, ${category.id}, ${tx.json(keys as never)}
      WHERE NOT EXISTS (SELECT 1 FROM ultimo_content_ledger WHERE side = ${side} AND category_id = ${category.id} AND keys = ${tx.json(keys as never)})
    `;
  }
}

/** Day categories (by position) that repeat any pool category ever published. */
export async function poolOverlapIn(tx: Sql, categories: readonly UltimoCategory[]): Promise<number[]> {
  const pool = await publishedKeys(tx, 'pool');
  return categories.flatMap((category, i) => (pool.some((item) => sameKeys(keysOf(category), item)) ? [i] : []));
}

export type SeedStatus = 'new' | 'changed' | 'unchanged';

export interface SeedEntry {
  day: string;
  number: number;
  status: SeedStatus;
  contentChanged: boolean;
  runs: number;
  voids: number;
  contentVersion: number;
  previousVersion: number | null;
}

export interface SeedPlan {
  entries: SeedEntry[];
  extraDays: string[];
}

interface StoredDay { day: string; number: number; contentVersion: number; categories: unknown }

const contentDiffers = (before: StoredDay, after: SeedDay): boolean =>
  before.contentVersion !== after.contentVersion || canonical(before.categories) !== canonical(after.categories);

export function planSeed(
  stored: ReadonlyMap<string, StoredDay>,
  runs: ReadonlyMap<string, { runs: number; ranked: number }>,
  incoming: readonly SeedDay[],
  opts: { allowCorrection: boolean },
): SeedPlan {
  const blocked: string[] = [];
  const entries = incoming.map((row): SeedEntry => {
    const before = stored.get(row.day);
    const count = runs.get(row.day) ?? { runs: 0, ranked: 0 };
    const base = { day: row.day, number: row.number, runs: count.runs, voids: 0, contentVersion: row.contentVersion, previousVersion: before?.contentVersion ?? null };
    if (!before) return { ...base, status: 'new', contentChanged: false };
    const contentChanged = contentDiffers(before, row);
    if (contentChanged && count.runs > 0 && !opts.allowCorrection) {
      blocked.push(`${row.day} (${count.runs} runs): content changed; pass --allow-correction to correct a played day (its ranked runs are unranked)`);
    }
    const same = !contentChanged && before.number === row.number;
    return { ...base, status: same ? 'unchanged' : 'changed', contentChanged, voids: contentChanged ? count.ranked : 0 };
  });
  if (blocked.length > 0) throw new Error(`Refusing to change the content of days that already have runs:\n  ${blocked.join('\n  ')}`);
  const incomingDays = new Set(incoming.map((row) => row.day));
  return { entries, extraDays: [...stored.keys()].filter((day) => !incomingDays.has(day)).sort() };
}

/**
 * Plans (and unless `dryRun`, writes) the whole set in ONE transaction, holding the Último content lock: the
 * duel-pool overlap is checked inside it, so a concurrent pool seed cannot slip the same category in. A permitted
 * correction unranks the day's runs; /start then moves each unfinished run onto the new content (from scratch).
 */
export async function seedDays(
  sql: Sql, rows: readonly SeedDay[], opts: { dryRun: boolean; allowCorrection: boolean; allowPoolOverlap: boolean },
): Promise<SeedPlan & { poolOverlap: number }> {
  return sql.begin(async (transaction) => {
    const tx = transaction as unknown as Sql;
    // The production role kills a transaction idle for 15 s; keep generous but bounded budgets.
    await tx`SET LOCAL lock_timeout = '5s'`;
    await tx`SET LOCAL statement_timeout = '60s'`;
    await tx`SET LOCAL idle_in_transaction_session_timeout = '60s'`;
    await tx`SELECT pg_advisory_xact_lock(hashtext(${ULTIMO_CONTENT_LOCK}))`;
    await tx`LOCK TABLE ultimo_days IN SHARE ROW EXCLUSIVE MODE`;
    const overlap = (await poolOverlapIn(tx, rows.flatMap((row) => row.categories))).length;
    if (overlap > 0 && !opts.allowPoolOverlap) throw new Error(`${overlap} daily categor(ies) repeat a duel pool category; refused (duel content is harvestable)`);
    const storedRows = await tx<Array<Omit<StoredDay, 'contentVersion'> & { contentVersion: string }>>`
      SELECT day::text AS day, number, content_version AS "contentVersion", categories FROM ultimo_days
    `;
    const stored = new Map(storedRows.map((r) => [r.day, { ...r, contentVersion: Number(r.contentVersion) }]));
    // Every start and move holds FOR SHARE on its day row until it commits; FOR UPDATE on the corrected days waits
    // for those in flight and holds back new ones, so the run counts below are final.
    const correcting = rows.filter((row) => stored.has(row.day) && contentDiffers(stored.get(row.day)!, row)).map((row) => row.day).sort();
    if (correcting.length > 0) {
      await tx`SELECT day FROM ultimo_days WHERE day = ANY(${tx.array(correcting)}::date[]) ORDER BY day FOR UPDATE`;
    }
    const runRows = await tx<Array<{ day: string; runs: number; ranked: number }>>`
      SELECT day::text AS day, count(*)::int AS runs, (count(*) FILTER (WHERE ranked))::int AS ranked FROM ultimo_runs GROUP BY day
    `;
    const plan = planSeed(stored, new Map(runRows.map((r) => [r.day, { runs: r.runs, ranked: r.ranked }])), rows, opts);
    if (opts.dryRun) return { ...plan, poolOverlap: overlap };
    const byDay = new Map(rows.map((row) => [row.day, row]));
    for (const entry of plan.entries) {
      if (entry.status === 'unchanged') continue;
      const row = byDay.get(entry.day)!;
      await tx`
        INSERT INTO ultimo_days (day, number, content_version, categories)
        VALUES (${row.day}, ${row.number}, ${row.contentVersion}, ${tx.json(row.categories as never)})
        ON CONFLICT (day) DO UPDATE SET number = EXCLUDED.number, content_version = EXCLUDED.content_version, categories = EXCLUDED.categories
      `;
      if (entry.contentChanged && entry.runs > 0) await tx`UPDATE ultimo_runs SET ranked = false WHERE day = ${row.day} AND ranked`;
    }
    await recordPublished(tx, 'day', rows.flatMap((row) => row.categories));
    return { ...plan, poolOverlap: overlap };
  }) as Promise<SeedPlan & { poolOverlap: number }>;
}
