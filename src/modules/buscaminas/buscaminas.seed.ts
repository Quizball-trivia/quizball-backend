import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { CARDS_PER_ROUND, ROUNDS_PER_DAY, TARGETS_PER_ROUND } from './buscaminas.constants.js';
import { addDays, assertAppendOnly, assertUnbrokenCalendar, dayNumber, LAUNCH_DAY } from './buscaminas.days.js';
import { normalizeAnswer } from '../pistas/pistas.normalize.js';
import { BUSCAMINAS_DIFFICULTIES, BUSCAMINAS_LOCALES, type BuscaminasDayRow, type BuscaminasDifficulty, type PublicCard, type PublicRound } from './buscaminas.types.js';

/**
 * Content seeding for scripts/buscaminas-seed-days.ts: validates the full day files
 * (boards with their `ok` flags) and upserts them into buscaminas_days in one transaction.
 */

/** A day file as the content pipeline writes it: the public board plus which cards fit each clue. */
export interface SeedDay {
  day: string;
  number: number;
  contentVersion: number;
  rounds: Array<Omit<PublicRound, 'cards'> & { cards: Array<PublicCard & { ok: boolean }> }>;
}

/** Card art is served by the web from this directory only. */
const CARD_IMG = /^\/buscaminas\/v1\/p\/[A-Za-z0-9_-]+\.[a-z0-9]+$/;

/** Python's json.dumps(ensure_ascii=True): everything outside printable ASCII becomes \uXXXX. */
const pythonJson = (value: unknown): string =>
  JSON.stringify(value).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

/**
 * The content pipeline's contentVersion: the first 7 hex digits of sha256 over
 * `[[round id, [[card id, ok], …]], …]` (compact JSON), so it changes exactly when the answers do.
 */
export function answerHash(rounds: SeedDay['rounds']): number {
  const payload = pythonJson(rounds.map((r) => [r.id, r.cards.map((c) => [c.id, c.ok])]));
  return parseInt(createHash('sha256').update(payload).digest('hex').slice(0, 7), 16);
}

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

/** Validates one day file and keeps exactly the board fields plus the ok flags (unknown fields are dropped). */
export function parseDayFile(label: string, raw: unknown): SeedDay {
  const fail = (msg: string): never => { throw new Error(`${label}: ${msg}`); };
  const d = (raw ?? {}) as { day?: unknown; number?: unknown; contentVersion?: unknown; rounds?: unknown };
  const validDay = typeof d.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.day)
    && !Number.isNaN(Date.parse(`${d.day}T00:00:00Z`)) && addDays(d.day, 0) === d.day;
  if (!validDay) fail('day must be a valid YYYY-MM-DD');
  if (d.number !== dayNumber(d.day as string)) fail(`number must be ${dayNumber(d.day as string)}`);
  const contentVersion = d.contentVersion;
  if (!Number.isInteger(contentVersion) || (contentVersion as number) < 1 || (contentVersion as number) > 2 ** 32) fail('contentVersion must be an integer in 1..2^32');
  if (!Array.isArray(d.rounds) || d.rounds.length !== ROUNDS_PER_DAY) fail(`expected ${ROUNDS_PER_DAY} rounds`);
  const roundIds = new Set<string>();
  const rounds = (d.rounds as Array<{ id?: unknown; difficulty?: unknown; prompt?: unknown; cards?: unknown }>).map((round, i) => {
    if (!nonEmpty(round?.id)) fail(`round ${i}: missing id`);
    if (roundIds.has(round.id as string)) fail(`round ${i}: duplicate id ${String(round.id)}`);
    roundIds.add(round.id as string);
    if (!BUSCAMINAS_DIFFICULTIES.includes(round.difficulty as BuscaminasDifficulty)) fail(`round ${i}: difficulty must be one of ${BUSCAMINAS_DIFFICULTIES.join('/')}`);
    const prompt = (round.prompt ?? {}) as Record<string, unknown>;
    for (const locale of BUSCAMINAS_LOCALES) if (!nonEmpty(prompt[locale])) fail(`round ${i}: prompt.${locale} missing`);
    if (!Array.isArray(round.cards) || round.cards.length !== CARDS_PER_ROUND) fail(`round ${i}: expected ${CARDS_PER_ROUND} cards`);
    const ids = new Set<string>();
    const cards = (round.cards as Array<{ id?: unknown; name?: unknown; img?: unknown; ok?: unknown }>).map((card, j) => {
      if (!nonEmpty(card?.id)) fail(`round ${i} card ${j}: missing id`);
      if (!nonEmpty(card.name)) fail(`round ${i} card ${j}: missing name`);
      if (typeof card.img !== 'string' || !CARD_IMG.test(card.img)) fail(`round ${i} card ${j}: img must be a file under /buscaminas/v1/p/`);
      if (typeof card.ok !== 'boolean') fail(`round ${i} card ${j}: missing ok (answers stripped?)`);
      if (ids.has(card.id as string)) fail(`round ${i}: duplicate card ${String(card.id)}`);
      ids.add(card.id as string);
      return { id: card.id as string, name: card.name as string, img: card.img as string, ok: card.ok as boolean };
    });
    if (cards.filter((c) => c.ok).length !== TARGETS_PER_ROUND) fail(`round ${i}: expected ${TARGETS_PER_ROUND} correct cards`);
    return {
      id: round.id as string,
      difficulty: round.difficulty as BuscaminasDifficulty,
      prompt: { es: prompt.es as string, en: prompt.en as string, ka: prompt.ka as string, tr: prompt.tr as string },
      cards,
    };
  });
  const hash = answerHash(rounds);
  if (contentVersion !== hash) fail(`contentVersion ${String(contentVersion)} is not the answer hash ${hash}`);
  return { day: d.day as string, number: d.number as number, contentVersion: contentVersion as number, rounds };
}

/**
 * The supplied files are one unbroken run of days (any length, starting anywhere): the whole calendar, or a batch
 * that appends to it. Whether the batch connects to the stored days is checked inside the write (`seedDays`).
 */
export function assertCalendar(days: readonly SeedDay[]): void {
  if (days.length === 0) throw new Error('no days to seed');
  days.forEach((d, i) => {
    const expected = addDays(days[0].day, i);
    if (d.day !== expected) throw new Error(`days must be contiguous: position ${i + 1} is ${d.day}, expected ${expected}`);
  });
}

/** Splits a day into its public board and its server-only answers. */
export function toDayRow(d: SeedDay): BuscaminasDayRow {
  return {
    day: d.day,
    number: d.number,
    contentVersion: d.contentVersion,
    board: {
      rounds: d.rounds.map((r) => ({
        id: r.id,
        difficulty: r.difficulty,
        prompt: { es: r.prompt.es, en: r.prompt.en, ka: r.prompt.ka, tr: r.prompt.tr },
        cards: r.cards.map((c) => ({ id: c.id, name: c.name, img: c.img })),
      })),
    },
    answers: Object.fromEntries(d.rounds.map((r) => [r.id, r.cards.filter((c) => c.ok).map((c) => c.id)])),
  };
}

/** Key order does not matter in jsonb, so compare with sorted keys. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export type SeedStatus = 'new' | 'changed' | 'unchanged';

export interface SeedEntry {
  day: string;
  number: number;
  status: SeedStatus;
  /** The answers (and so the content version) differ from the stored day. */
  answersChanged: boolean;
  runs: number;
  contentVersion: number;
  previousVersion: number | null;
}

export interface SeedPlan {
  entries: SeedEntry[];
  /** Stored days the files do not contain; reported, never deleted. */
  extraDays: string[];
}

const answersDiffer = (before: BuscaminasDayRow, after: BuscaminasDayRow): boolean =>
  before.contentVersion !== after.contentVersion || canonical(before.answers) !== canonical(after.answers);

export function planSeed(
  stored: ReadonlyMap<string, BuscaminasDayRow>,
  runs: ReadonlyMap<string, number>,
  incoming: readonly BuscaminasDayRow[],
  opts: { allowCorrection: boolean },
): SeedPlan {
  const blocked: string[] = [];
  const entries = incoming.map((row): SeedEntry => {
    const before = stored.get(row.day);
    const count = runs.get(row.day) ?? 0;
    const base = { day: row.day, number: row.number, runs: count, contentVersion: row.contentVersion, previousVersion: before?.contentVersion ?? null };
    if (!before) return { ...base, status: 'new', answersChanged: false };
    const answersChanged = answersDiffer(before, row);
    const same = !answersChanged && before.number === row.number && canonical(before.board) === canonical(row.board);
    if (answersChanged && count > 0) {
      if (!opts.allowCorrection) blocked.push(`${row.day} (${count} runs): answers changed; pass --allow-correction to correct a played day`);
      else if (before.contentVersion === row.contentVersion) blocked.push(`${row.day} (${count} runs): a correction must change contentVersion so unfinished runs restart`);
    }
    return { ...base, status: same ? 'unchanged' : 'changed', answersChanged };
  });
  if (blocked.length > 0) throw new Error(`Refusing to change the answers of days that already have runs:\n  ${blocked.join('\n  ')}`);
  const incomingDays = new Set(incoming.map((row) => row.day));
  return { entries, extraDays: [...stored.keys()].filter((day) => !incomingDays.has(day)).sort() };
}

/** Taken by the days seed and the duel pool writer, so each re-checks the other's content inside its own write. */
export const BUSCAMINAS_CONTENT_LOCK = 'buscaminas-content';

/**
 * Rounds whose category is in the duel pool (duel packs are harvestable, so a daily category may never be a pool
 * category). Matched exactly as the pool writer matches the days (normalised Spanish prompt, longer than two
 * characters); disabled pool items count too, since their packs were already dealt. No duel_pool table means none.
 */
export async function duelPoolOverlap(sql: Sql, rows: readonly BuscaminasDayRow[]): Promise<number> {
  const [table] = await sql<Array<{ present: boolean }>>`SELECT to_regclass('public.duel_pool') IS NOT NULL AS present`;
  if (!table?.present) return 0;
  // the pool as it is, plus everything it ever held (the ledger remembers items replaced or removed since)
  const pool = await sql<Array<{ prompt: string | null }>>`
    SELECT payload->'prompt'->>'es' AS prompt FROM duel_pool WHERE game = 'buscaminas'
    UNION ALL SELECT key FROM buscaminas_content_ledger WHERE side = 'pool'
  `;
  const keys = new Set(pool.flatMap((item) => (item.prompt ? [normalizeAnswer(item.prompt)] : [])).filter((key) => key.length > 2));
  return rows.reduce((n, row) => n + row.board.rounds.filter((round) => keys.has(normalizeAnswer(round.prompt.es))).length, 0);
}

const unchangedDay = (before: BuscaminasDayRow | undefined, row: BuscaminasDayRow): boolean =>
  !!before && !answersDiffer(before, row) && before.number === row.number && canonical(before.board) === canonical(row.board);

/** Plans (and unless `dryRun`, writes) the whole set in ONE transaction; a refused correction writes nothing. */
/** Daily categories ever published: the stored days plus the ledger (days since corrected keep their keys). */
export async function dailyKeys(sql: Sql): Promise<Set<string>> {
  const rows = await sql<Array<{ prompt: string | null }>>`
    SELECT round->'prompt'->>'es' AS prompt FROM buscaminas_days, jsonb_array_elements(board->'rounds') AS round
    UNION ALL SELECT key FROM buscaminas_content_ledger WHERE side = 'day'
  `;
  return new Set(rows.flatMap((row) => (row.prompt ? [normalizeAnswer(row.prompt)] : [])).filter((key) => key.length > 2));
}

/** Records published content (inside the write's transaction), in one statement; a key already recorded for that side and day is kept once. */
export async function recordBuscaminasContent(tx: Sql, side: 'day' | 'pool', entries: ReadonlyArray<{ key: string; day: string | null }>): Promise<void> {
  const rows = entries.filter((entry) => entry.key.length > 2);
  if (rows.length === 0) return;
  await tx`
    INSERT INTO buscaminas_content_ledger (side, key, day)
    SELECT ${side}, e->>'key', (e->>'day')::date FROM jsonb_array_elements(${tx.json(rows as never)}) AS e
    ON CONFLICT (side, key, COALESCE(day, '1970-01-01'::date)) DO NOTHING
  `;
}

/** A day's category keys, for the ledger. */
export const dayKeys = (row: Pick<BuscaminasDayRow, 'day' | 'board'>) =>
  row.board.rounds.map((round) => ({ key: normalizeAnswer(round.prompt.es), day: row.day }));

export async function seedDays(
  sql: Sql, rows: readonly BuscaminasDayRow[], opts: { appendOnly?: boolean; dryRun: boolean; allowCorrection: boolean; allowPoolOverlap?: boolean },
): Promise<SeedPlan> {
  return sql.begin((transaction) => seedDaysTx(transaction as unknown as Sql, rows, opts)) as Promise<SeedPlan>;
}

/** The seed inside the caller's transaction (a CMS approval commits the batch row and the days together). */
export async function seedDaysTx(
  tx: Sql, rows: readonly BuscaminasDayRow[], opts: { appendOnly?: boolean; dryRun: boolean; allowCorrection: boolean; allowPoolOverlap?: boolean },
): Promise<SeedPlan> {
  // The production role kills a transaction idle for 15 s; keep generous but bounded budgets.
  await tx`SET LOCAL lock_timeout = '5s'`;
  await tx`SET LOCAL statement_timeout = '60s'`;
  await tx`SET LOCAL idle_in_transaction_session_timeout = '60s'`;
  // One seed at a time (gameplay's FOR SHARE row locks do not conflict with this table lock), and never beside a
  // pool write: the overlap with the duel pool is checked here, inside the write.
  await tx`SELECT pg_advisory_xact_lock(hashtext(${BUSCAMINAS_CONTENT_LOCK}))`;
  await tx`LOCK TABLE buscaminas_days IN SHARE ROW EXCLUSIVE MODE`;
  const storedRows = await tx<Array<Omit<BuscaminasDayRow, 'contentVersion'> & { contentVersion: string }>>`
    SELECT day::text AS day, number, content_version AS "contentVersion", board, answers FROM buscaminas_days
  `;
  const stored = new Map(storedRows.map((r) => [r.day, { ...r, contentVersion: Number(r.contentVersion) }]));
  // Only what this seed writes: a stored day supplied again unchanged is not re-judged.
  const overlap = await duelPoolOverlap(tx, rows.filter((row) => !unchangedDay(stored.get(row.day), row)));
  if (overlap > 0 && !opts.allowPoolOverlap) throw new Error(`${overlap} daily round(s) use a duel pool category; refused (duel content is harvestable)`);
  // The stored days are the calendar: a seed may extend it but never leave a hole in it.
  assertUnbrokenCalendar(LAUNCH_DAY, stored.keys(), rows.map((row) => row.day));
  // An append (CMS-approved batch) may only add days after the stored ones: never correct or re-supply one.
  if (opts.appendOnly) assertAppendOnly(stored.keys(), rows.map((row) => row.day));
  // Every start and move holds FOR SHARE on its day row until it commits. Taking FOR UPDATE on the
  // days whose answers change waits for those in flight and holds back new ones, so the run count
  // below is final and no run can start or move on the old answers once they are replaced.
  const correcting = rows.filter((row) => stored.has(row.day) && answersDiffer(stored.get(row.day)!, row)).map((row) => row.day).sort();
  if (correcting.length > 0) {
    await tx`SELECT day FROM buscaminas_days WHERE day = ANY(${tx.array(correcting)}::date[]) ORDER BY day FOR UPDATE`;
  }
  const runRows = await tx<Array<{ day: string; runs: number }>>`
    SELECT day::text AS day, count(*)::int AS runs FROM buscaminas_runs GROUP BY day
  `;
  const plan = planSeed(stored, new Map(runRows.map((r) => [r.day, r.runs])), rows, opts);
  if (opts.dryRun) return plan;
  const byDay = new Map(rows.map((row) => [row.day, row]));
  for (const entry of plan.entries) {
    if (entry.status === 'unchanged') continue;
    const row = byDay.get(entry.day)!;
    await tx`
      INSERT INTO buscaminas_days (day, number, content_version, board, answers)
      VALUES (${row.day}, ${row.number}, ${row.contentVersion}, ${tx.json(row.board as never)}, ${tx.json(row.answers as never)})
      ON CONFLICT (day) DO UPDATE
        SET number = EXCLUDED.number, content_version = EXCLUDED.content_version, board = EXCLUDED.board, answers = EXCLUDED.answers
    `;
  }
  // everything stored before this write (content shipped before the ledger existed, and what a correction replaces)
  // and everything it wrote: a category stays published even after it leaves the table
  await recordBuscaminasContent(tx, 'day', [...stored.values(), ...rows].flatMap(dayKeys));
  return plan;
}

export const PROJECT_REFS = { staging: 'nsdfiprfmhdqhbfxfwpv', production: 'lfbwhxvwubzeqkztghok' } as const;
export type SeedTargetName = keyof typeof PROJECT_REFS;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

const SUPABASE_POOLER_HOST = /^[a-z0-9-]+\.pooler\.supabase\.com$/;
const SUPABASE_DIRECT_HOST = /^db\.([a-z0-9]+)\.supabase\.co$/;

/**
 * The Supabase project a URL really connects to, else null. The pooler names the project only in the
 * user (postgres.<ref>), so that user is trusted on a Supabase pooler host and nowhere else: on any
 * other host it says nothing about where the connection goes. A direct host names the project itself.
 */
function projectRef(url: URL): string | null {
  const userRef = decodeURIComponent(url.username).match(/^postgres\.([a-z0-9]+)$/)?.[1] ?? null;
  if (SUPABASE_POOLER_HOST.test(url.hostname)) return userRef;
  const hostRef = url.hostname.match(SUPABASE_DIRECT_HOST)?.[1] ?? null;
  if (hostRef && (userRef === null || userRef === hostRef)) return hostRef;
  return null;
}

/**
 * Host guard: a local database needs no flag; anything else needs `--target staging|production`
 * AND a DATABASE_URL of that exact Supabase project. The label names the host or project, never credentials.
 */
export function resolveSeedTarget(databaseUrl: string | undefined, target: SeedTargetName | undefined): { kind: 'local' | SeedTargetName; label: string } {
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error('DATABASE_URL is not a valid URL');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') throw new Error('DATABASE_URL must be a postgres:// URL');
  if (LOCAL_HOSTS.has(url.hostname)) {
    if (target) throw new Error(`--target ${target} was given but DATABASE_URL is a local database (${url.hostname})`);
    return { kind: 'local', label: `local ${url.hostname}:${url.port || '5432'}${url.pathname}` };
  }
  const ref = projectRef(url);
  const where = ref ? `Supabase project ${ref}` : `host ${url.hostname}`;
  if (!target) throw new Error(`Refusing to seed a non-local database (${where}) without --target staging|production`);
  if (ref !== PROJECT_REFS[target]) throw new Error(`--target ${target} expects Supabase project ${PROJECT_REFS[target]}, but DATABASE_URL points at ${where}`);
  return { kind: target, label: `${target} (Supabase project ${ref})` };
}
