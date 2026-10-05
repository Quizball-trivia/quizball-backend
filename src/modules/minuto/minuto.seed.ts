import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { canonical } from '../pistas/pistas.seed.js';
import { GOALS_PER_DAY } from './minuto.constants.js';
import { addDays, assertUnbrokenCalendar } from '../daily/daily.calendar.js';
import { CONTENT_START, dayNumber } from './minuto.days.js';
import { goalBaseSchema, goalSchema, minuteLeaks, MINUTO_TIERS, type MinutoGoal } from './minuto.goal.js';
import type { MinutoDayRow } from './minuto.types.js';

/**
 * Content seeding for scripts/minuto-seed-days.ts and the duel pool: validates the private files and writes them in
 * one transaction. Nothing here may print a minute: messages name days, goal positions and ids only.
 */

export interface SeedDay {
  day: string;
  number: number;
  contentVersion: number;
  goals: MinutoGoal[];
}

/** Any change to the served content (cards, pictures, minutes, order) is a new version. */
export function contentHash(goals: readonly MinutoGoal[]): number {
  const hex = createHash('sha256').update(canonical(goals)).digest('hex');
  return parseInt(hex.slice(0, 8), 16) || 1;
}

const GOAL_KEYS = new Set(Object.keys(goalBaseSchema.shape));

/**
 * Describes a refused goal without echoing it: issue codes and known field names only. Zod's own messages can quote
 * an unknown key or a value, and either may be a minute.
 */
export function describeIssues(error: { issues: Array<{ code: string; path: PropertyKey[] }> }): string {
  return [...new Set(error.issues.map((issue) => {
    const head = issue.path[0];
    const field = typeof head === 'string' && GOAL_KEYS.has(head) ? head : typeof head === 'number' ? `#${head}` : '';
    return field ? `${field}:${issue.code}` : issue.code;
  }))].join(', ');
}

/** A goal that passes the schema and names no minute anywhere a player sees before guessing; else the reason. */
export function checkGoal(raw: unknown): { goal: MinutoGoal } | { reason: string } {
  const parsed = goalSchema.safeParse(raw);
  if (!parsed.success) return { reason: `invalid (${describeIssues(parsed.error)})` };
  const leaks = minuteLeaks(parsed.data);
  return leaks.length > 0 ? { reason: `public text names the minute (${leaks.join(', ')})` } : { goal: parsed.data };
}

/** Validates one day file and keeps exactly the stored fields (an unknown field is refused, not dropped). */
export function parseDayFile(label: string, raw: unknown): SeedDay {
  const fail = (msg: string): never => { throw new Error(`${label}: ${msg}`); };
  const d = (raw ?? {}) as { day?: unknown; number?: unknown; goals?: unknown };
  const validDay = typeof d.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.day)
    && !Number.isNaN(Date.parse(`${d.day}T00:00:00Z`)) && addDays(d.day, 0) === d.day;
  if (!validDay) fail('day must be a valid YYYY-MM-DD');
  const day = d.day as string;
  if (day < CONTENT_START) fail(`day is before the first content day ${CONTENT_START}`);
  if (d.number !== dayNumber(day)) fail(`number must be ${dayNumber(day)}`);
  if (!Array.isArray(d.goals) || d.goals.length !== GOALS_PER_DAY) fail(`expected ${GOALS_PER_DAY} goals`);
  const ids = new Set<string>();
  const prints = new Set<string>();
  const goals = (d.goals as unknown[]).map((raw, i): MinutoGoal => {
    const checked = checkGoal(raw);
    if ('reason' in checked) return fail(`goal ${i + 1}: ${checked.reason}`);
    const goal = checked.goal;
    if (ids.has(goal.id)) fail(`goal ${i + 1}: duplicate id`);
    if (prints.has(goal.fingerprint)) fail(`goal ${i + 1}: duplicate goal (fingerprint)`);
    ids.add(goal.id);
    prints.add(goal.fingerprint);
    return goal;
  });
  return { day, number: d.number as number, contentVersion: contentHash(goals), goals };
}

/**
 * The supplied files are one unbroken run of days (any length, starting anywhere: the whole calendar, or a batch that
 * appends to it) with no goal on two days: a day's review publishes its minutes, so a repeat would hand later players
 * the answer. Whether the batch connects to the stored days, and repeats no goal published before, is checked inside
 * the write (`seedDays`).
 */
export function assertCalendar(days: readonly SeedDay[]): void {
  if (days.length === 0) throw new Error('no days to seed');
  const seen = new Map<string, string>();
  days.forEach((d, i) => {
    const expected = addDays(days[0].day, i);
    if (d.day !== expected) throw new Error(`days must be contiguous: position ${i + 1} is ${d.day}, expected ${expected}`);
    d.goals.forEach((goal, j) => {
      for (const key of [`id:${goal.id}`, `fp:${goal.fingerprint}`]) {
        const other = seen.get(key);
        if (other) throw new Error(`${d.day} goal ${j + 1}: same goal as ${other}`);
        seen.set(key, `${d.day} goal ${j + 1}`);
      }
    });
  });
}

export const toDayRow = (d: SeedDay): MinutoDayRow => ({ day: d.day, number: d.number, contentVersion: d.contentVersion, goals: d.goals });

/** Both Minuto seeds (days and duel pool) take this lock and check overlap inside their write transaction. */
export const MINUTO_CONTENT_LOCK = 'minuto-content';

export type ContentSide = 'day' | 'pool';
export interface GoalKey { id: string; fingerprint: string; day?: string | null }

const keyOf = (goal: Pick<MinutoGoal, 'id' | 'fingerprint'>): GoalKey => ({ id: goal.id, fingerprint: goal.fingerprint });

/**
 * Every goal ever published on `side`: the append-only ledger (a pool goal replaced or disabled after it was played
 * is still known) plus what is stored now.
 */
export async function publishedKeys(tx: Sql, side: ContentSide): Promise<GoalKey[]> {
  const ledger = await tx<GoalKey[]>`SELECT goal_id AS id, fingerprint, day::text AS day FROM minuto_content_ledger WHERE side = ${side}`;
  if (side === 'pool') {
    const pool = await tx<Array<{ payload: unknown }>>`SELECT payload FROM duel_pool WHERE game = 'minuto'`;
    return [...ledger, ...pool.map((r) => goalSchema.safeParse(r.payload)).flatMap((p) => (p.success ? [keyOf(p.data)] : []))];
  }
  const days = await tx<Array<{ day: string; goals: unknown[] }>>`SELECT day::text AS day, goals FROM minuto_days`;
  const current = days.flatMap((d) => d.goals.map((raw) => goalSchema.safeParse(raw)).flatMap((p) => (p.success ? [{ ...keyOf(p.data), day: d.day }] : [])));
  return [...ledger, ...current];
}

/** Positions of `goals` that repeat a goal published on `side`, by id or by fingerprint (checked separately). */
export function overlapping(goals: readonly Pick<MinutoGoal, 'id' | 'fingerprint'>[], published: readonly GoalKey[]): number[] {
  const ids = new Set(published.map((k) => k.id));
  const prints = new Set(published.map((k) => k.fingerprint));
  return goals.flatMap((goal, i) => (ids.has(goal.id) || prints.has(goal.fingerprint) ? [i] : []));
}

/**
 * Daily goals (by day and position) already published on ANOTHER day, now or ever: a day's review discloses its
 * minutes, so a correction may not move a goal to a different day.
 */
export function movedDailyGoals(days: readonly SeedDay[], published: readonly GoalKey[]): string[] {
  const origins = new Map<string, Set<string>>();
  const add = (key: string, day: string) => origins.set(key, (origins.get(key) ?? new Set()).add(day));
  for (const key of published) {
    if (!key.day) continue;
    add(`id:${key.id}`, key.day);
    add(`fp:${key.fingerprint}`, key.day);
  }
  return days.flatMap((d) => d.goals.flatMap((goal, i) => {
    // Either identity counts on its own: a disclosed goal under a reused id, or a reused fingerprint, is still that goal.
    const elsewhere = [...(origins.get(`id:${goal.id}`) ?? []), ...(origins.get(`fp:${goal.fingerprint}`) ?? [])].filter((day) => day !== d.day);
    return elsewhere.length > 0 ? [`${d.day} goal ${i + 1} (published on ${[...new Set(elsewhere)].sort().join(', ')})`] : [];
  }));
}

/** Records what a seed published (inside its write transaction); a goal already recorded is not repeated. */
export async function recordPublished(tx: Sql, side: ContentSide, goals: readonly (Pick<MinutoGoal, 'id' | 'fingerprint'> & { day?: string })[]): Promise<void> {
  for (const goal of goals) {
    const day = side === 'day' ? goal.day ?? null : null;
    await tx`
      INSERT INTO minuto_content_ledger (side, goal_id, fingerprint, day)
      SELECT ${side}, ${goal.id}, ${goal.fingerprint}, ${day}::date
      WHERE NOT EXISTS (
        SELECT 1 FROM minuto_content_ledger WHERE side = ${side} AND goal_id = ${goal.id} AND fingerprint = ${goal.fingerprint}
          AND day IS NOT DISTINCT FROM ${day}::date
      )
    `;
  }
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

interface StoredDay { day: string; number: number; contentVersion: number; goals: unknown }

const contentDiffers = (before: StoredDay, after: SeedDay): boolean =>
  before.contentVersion !== after.contentVersion || canonical(before.goals) !== canonical(after.goals);

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
 * Plans (and unless `dryRun`, writes) the whole set in ONE transaction, holding the Minuto content lock: the duel
 * pool overlap is checked inside it, so a concurrent pool seed cannot slip the same goal in. A permitted correction
 * unranks the day's runs; /start then moves each unfinished run onto the new content.
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
    await tx`SELECT pg_advisory_xact_lock(hashtext(${MINUTO_CONTENT_LOCK}))`;
    await tx`LOCK TABLE minuto_days IN SHARE ROW EXCLUSIVE MODE`;
    const overlap = overlapping(rows.flatMap((row) => row.goals), await publishedKeys(tx, 'pool')).length;
    if (overlap > 0 && !opts.allowPoolOverlap) throw new Error(`${overlap} daily goal(s) are in the duel pool; refused (duel content is harvestable)`);
    const moved = movedDailyGoals(rows, await publishedKeys(tx, 'day'));
    if (moved.length > 0) throw new Error(`goals already published on another day; refused (their minutes are public): ${moved.slice(0, 10).join('; ')}`);
    const storedRows = await tx<Array<Omit<StoredDay, 'contentVersion'> & { contentVersion: string }>>`
      SELECT day::text AS day, number, content_version AS "contentVersion", goals FROM minuto_days
    `;
    const stored = new Map(storedRows.map((r) => [r.day, { ...r, contentVersion: Number(r.contentVersion) }]));
    // The stored days are the calendar: a seed may extend it but never leave a hole in it.
    assertUnbrokenCalendar(CONTENT_START, stored.keys(), rows.map((row) => row.day));
    const correcting = rows.filter((row) => stored.has(row.day) && contentDiffers(stored.get(row.day)!, row)).map((row) => row.day).sort();
    if (correcting.length > 0) {
      await tx`SELECT day FROM minuto_days WHERE day = ANY(${tx.array(correcting)}::date[]) ORDER BY day FOR UPDATE`;
    }
    const runRows = await tx<Array<{ day: string; runs: number; ranked: number }>>`
      SELECT day::text AS day, count(*)::int AS runs, (count(*) FILTER (WHERE ranked))::int AS ranked FROM minuto_runs GROUP BY day
    `;
    const plan = planSeed(stored, new Map(runRows.map((r) => [r.day, { runs: r.runs, ranked: r.ranked }])), rows, opts);
    if (opts.dryRun) return { ...plan, poolOverlap: overlap };
    const byDay = new Map(rows.map((row) => [row.day, row]));
    for (const entry of plan.entries) {
      if (entry.status === 'unchanged') continue;
      const row = byDay.get(entry.day)!;
      await tx`
        INSERT INTO minuto_days (day, number, content_version, goals)
        VALUES (${row.day}, ${row.number}, ${row.contentVersion}, ${tx.json(row.goals as never)})
        ON CONFLICT (day) DO UPDATE SET number = EXCLUDED.number, content_version = EXCLUDED.content_version, goals = EXCLUDED.goals
      `;
      if (entry.contentChanged && entry.runs > 0) await tx`UPDATE minuto_runs SET ranked = false WHERE day = ${row.day} AND ranked`;
    }
    await recordPublished(tx, 'day', rows.flatMap((row) => row.goals.map((goal) => ({ ...goal, day: row.day }))));
    return { ...plan, poolOverlap: overlap };
  }) as Promise<SeedPlan & { poolOverlap: number }>;
}

/** A pool goal's duel difficulty is its tier. */
export const poolDifficulty = (goal: MinutoGoal): (typeof MINUTO_TIERS)[number] => goal.tier;
