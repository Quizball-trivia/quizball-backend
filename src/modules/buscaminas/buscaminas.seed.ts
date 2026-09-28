import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { CARDS_PER_ROUND, ROUNDS_PER_DAY, TARGETS_PER_ROUND } from './buscaminas.constants.js';
import { addDays, dayNumber, LAUNCH_DAY, PUBLISHED_DAYS } from './buscaminas.days.js';
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

/** The whole published calendar or nothing: a short set would silently leave later days empty. */
export function assertCalendar(days: readonly SeedDay[]): void {
  if (days.length !== PUBLISHED_DAYS) throw new Error(`expected ${PUBLISHED_DAYS} days from ${LAUNCH_DAY}, found ${days.length}`);
  days.forEach((d, i) => {
    const expected = addDays(LAUNCH_DAY, i);
    if (d.day !== expected) throw new Error(`days must be contiguous from ${LAUNCH_DAY}: position ${i + 1} is ${d.day}, expected ${expected}`);
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
    const answersChanged = before.contentVersion !== row.contentVersion || canonical(before.answers) !== canonical(row.answers);
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

/** Plans (and unless `dryRun`, writes) the whole set in ONE transaction; a refused correction writes nothing. */
export async function seedDays(sql: Sql, rows: readonly BuscaminasDayRow[], opts: { dryRun: boolean; allowCorrection: boolean }): Promise<SeedPlan> {
  return sql.begin(async (transaction) => {
    // postgres.js types a transaction without its call signature; it is the same tagged function.
    const tx = transaction as unknown as Sql;
    // The production role kills a transaction idle for 15 s; keep generous but bounded budgets.
    await tx`SET LOCAL lock_timeout = '5s'`;
    await tx`SET LOCAL statement_timeout = '60s'`;
    await tx`SET LOCAL idle_in_transaction_session_timeout = '60s'`;
    // One seed at a time; readers are never blocked.
    await tx`LOCK TABLE buscaminas_days IN SHARE ROW EXCLUSIVE MODE`;
    const storedRows = await tx<Array<Omit<BuscaminasDayRow, 'contentVersion'> & { contentVersion: string }>>`
      SELECT day::text AS day, number, content_version AS "contentVersion", board, answers FROM buscaminas_days
    `;
    const runRows = await tx<Array<{ day: string; runs: number }>>`
      SELECT day::text AS day, count(*)::int AS runs FROM buscaminas_runs GROUP BY day
    `;
    const plan = planSeed(
      new Map(storedRows.map((r) => [r.day, { ...r, contentVersion: Number(r.contentVersion) }])),
      new Map(runRows.map((r) => [r.day, r.runs])),
      rows,
      opts,
    );
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
    return plan;
  }) as Promise<SeedPlan>;
}

export const PROJECT_REFS = { staging: 'nsdfiprfmhdqhbfxfwpv', production: 'lfbwhxvwubzeqkztghok' } as const;
export type SeedTargetName = keyof typeof PROJECT_REFS;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Supabase project of a direct (db.<ref>.supabase.co) or pooler (user postgres.<ref>) URL; same rule as scripts/migration-safety.mjs. */
function projectRef(url: URL): string | null {
  return url.hostname.match(/^db\.([a-z0-9]+)\.supabase\.co$/)?.[1]
    ?? decodeURIComponent(url.username).match(/^postgres\.([a-z0-9]+)$/)?.[1]
    ?? null;
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
