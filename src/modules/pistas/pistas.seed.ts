import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { resolveSeedTarget, type SeedTargetName } from '../buscaminas/buscaminas.seed.js';
import { CLUES_PER_ROUND, ROUNDS_PER_DAY } from './pistas.constants.js';
import { addDays, assertAppendOnly, assertUnbrokenCalendar } from '../daily/daily.calendar.js';
import { CONTENT_START, dayNumber } from './pistas.days.js';
import { containsWords, normalizeAnswer } from './pistas.normalize.js';
import {
  CLUE_KINDS, PISTAS_DIFFICULTIES, PISTAS_LOCALES, type Clue, type ClueKind, type LocalizedText, type PistasDayRow, type PistasDifficulty,
  type StoredRound,
} from './pistas.types.js';

/**
 * Content seeding for scripts/pistas-seed-days.ts: validates the private day files and upserts them
 * into pistas_days in one transaction. Nothing here may print or echo an answer or a clue: messages
 * name days, round and clue positions and locales only.
 */

export interface SeedDay {
  day: string;
  number: number;
  contentVersion: number;
  rounds: StoredRound[];
}

/** Icon ids the web maps to its own art (e.g. `confed:uefa`, `foot:left`); never markup or a remote URL. */
const ICON = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,63}$/;

/** Key order does not matter in jsonb, so compare and hash with sorted keys. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * The day's content version: sha256 over the canonical JSON of the full stored rounds (ids, clues,
 * icons, every text, answers, order), first 8 hex digits. Any change to the served content is a new version.
 */
export function contentHash(rounds: readonly StoredRound[]): number {
  const hex = createHash('sha256').update(canonical(rounds)).digest('hex');
  return parseInt(hex.slice(0, 8), 16) || 1;
}

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

/** Validates one day file and keeps exactly the stored fields (`source` and any unknown field are dropped). */
export function parseDayFile(label: string, raw: unknown): SeedDay {
  const fail = (msg: string): never => { throw new Error(`${label}: ${msg}`); };
  const d = (raw ?? {}) as { day?: unknown; number?: unknown; rounds?: unknown };
  const validDay = typeof d.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.day)
    && !Number.isNaN(Date.parse(`${d.day}T00:00:00Z`)) && addDays(d.day, 0) === d.day;
  if (!validDay) fail('day must be a valid YYYY-MM-DD');
  const day = d.day as string;
  if (day < CONTENT_START) fail(`day is before the first content day ${CONTENT_START}`);
  if (d.number !== dayNumber(day)) fail(`number must be ${dayNumber(day)}`);
  if (!Array.isArray(d.rounds) || d.rounds.length !== ROUNDS_PER_DAY) fail(`expected ${ROUNDS_PER_DAY} rounds`);

  const text = (value: unknown, where: string): LocalizedText => {
    const v = (value ?? {}) as Record<string, unknown>;
    for (const locale of PISTAS_LOCALES) if (!nonEmpty(v[locale])) fail(`${where}.${locale} missing`);
    return { es: (v.es as string).trim(), en: (v.en as string).trim(), ka: (v.ka as string).trim(), tr: (v.tr as string).trim() };
  };

  const ids = new Set<string>();
  const answers: string[] = [];
  const rounds = (d.rounds as Array<{ id?: unknown; difficulty?: unknown; clues?: unknown; answer?: { display?: unknown; accepted?: unknown } }>).map((round, i): StoredRound => {
    const at = `round ${i + 1}`;
    if (!nonEmpty(round?.id) || (round.id as string).length > 64) fail(`${at}: id must be a non-empty string of at most 64 characters`);
    if (ids.has(round.id as string)) fail(`${at}: duplicate round id`);
    ids.add(round.id as string);
    if (!PISTAS_DIFFICULTIES.includes(round.difficulty as PistasDifficulty)) fail(`${at}: difficulty must be one of ${PISTAS_DIFFICULTIES.join('/')}`);

    const display = text(round.answer?.display, `${at}: answer.display`);
    const acceptedRaw = round.answer?.accepted;
    if (!Array.isArray(acceptedRaw) || acceptedRaw.length === 0) fail(`${at}: answer.accepted must be a non-empty list`);
    const accepted = (acceptedRaw as unknown[]).map((a, j) => {
      if (!nonEmpty(a)) fail(`${at}: answer.accepted[${j}] must be a non-empty string`);
      if (normalizeAnswer(a as string).length === 0) fail(`${at}: answer.accepted[${j}] has no letter or digit`);
      return (a as string).trim();
    });
    const acceptedForms = new Set(accepted.map(normalizeAnswer));
    for (const locale of PISTAS_LOCALES) {
      if (!acceptedForms.has(normalizeAnswer(display[locale]))) fail(`${at}: answer.display.${locale} does not normalise into answer.accepted`);
    }
    const key = normalizeAnswer(display.en);
    const repeat = answers.indexOf(key);
    if (repeat >= 0) fail(`${at}: same answer as round ${repeat + 1}`);
    answers.push(key);

    if (!Array.isArray(round.clues) || round.clues.length !== CLUES_PER_ROUND) fail(`${at}: expected ${CLUES_PER_ROUND} clues`);
    const clues = (round.clues as Array<{ kind?: unknown; icon?: unknown; text?: unknown }>).map((clue, j): Clue => {
      const where = `${at} clue ${j + 1}`;
      if (!CLUE_KINDS.includes(clue?.kind as ClueKind)) fail(`${where}: kind must be one of ${CLUE_KINDS.join('/')}`);
      const icon = clue.icon ?? null;
      if (icon !== null && (typeof icon !== 'string' || !ICON.test(icon))) fail(`${where}: icon must be null or an icon id (${ICON.source})`);
      const clueText = text(clue.text, `${where}: text`);
      for (const locale of PISTAS_LOCALES) {
        const words = normalizeAnswer(clueText[locale]);
        if ([...acceptedForms].some((form) => containsWords(words, form))) fail(`${where}: text.${locale} names an accepted answer`);
      }
      return { kind: clue.kind as ClueKind, icon: icon as string | null, text: clueText };
    });
    return { id: round.id as string, difficulty: round.difficulty as PistasDifficulty, clues, answer: { display, accepted } };
  });
  return { day, number: d.number as number, contentVersion: contentHash(rounds), rounds };
}

/**
 * The supplied files are one unbroken run of days (any length, starting anywhere): the whole calendar, or a batch
 * that appends to it. Whether the batch connects to the stored days, and repeats no player, is checked inside the
 * write (`seedDays`).
 */
export function assertCalendar(days: readonly SeedDay[]): void {
  if (days.length === 0) throw new Error('no days to seed');
  days.forEach((d, i) => {
    const expected = addDays(days[0].day, i);
    if (d.day !== expected) throw new Error(`days must be contiguous: position ${i + 1} is ${d.day}, expected ${expected}`);
  });
}

type DayPlayers = { day: string; rounds: ReadonlyArray<{ answer: { display: Record<string, string>; accepted: readonly string[] } }> };

/**
 * Rounds of `days` whose player is also the answer on a different day of `others`, as "day round N = day round M"
 * (positions only, never a name). A player may be a daily answer once. The rule is `samePlayer`'s (a display name
 * of one is a display name or an accepted answer of the other), looked up through two name indexes so a seed of a
 * year of days stays well inside its transaction budget. Not known here: a player a correction removed from a
 * played day (Pistas keeps no publication ledger).
 */
export function repeatedPlayers(days: readonly DayPlayers[], others: readonly DayPlayers[]): string[] {
  const names = (values: Iterable<string>) => [...new Set([...values].map(normalizeAnswer).filter((v) => v.length > 2))];
  type Ref = { day: string; round: number };
  const byDisplay = new Map<string, Ref[]>();
  const byAny = new Map<string, Ref[]>();
  const add = (index: Map<string, Ref[]>, name: string, ref: Ref) => { (index.get(name) ?? index.set(name, []).get(name)!).push(ref); };
  for (const other of others) {
    other.rounds.forEach((round, j) => {
      const ref = { day: other.day, round: j + 1 };
      const display = names(Object.values(round.answer.display));
      for (const name of display) add(byDisplay, name, ref);
      for (const name of names([...Object.values(round.answer.display), ...round.answer.accepted])) add(byAny, name, ref);
    });
  }
  const within = others === days;
  const found: string[] = [];
  for (const day of days) {
    day.rounds.forEach((round, i) => {
      const display = names(Object.values(round.answer.display));
      const any = names([...Object.values(round.answer.display), ...round.answer.accepted]);
      const hits = new Map<string, Ref>();
      for (const ref of [...display.flatMap((name) => byAny.get(name) ?? []), ...any.flatMap((name) => byDisplay.get(name) ?? [])]) {
        // Never the day itself; within one set, each pair once (from its later day).
        if (ref.day === day.day || (within && ref.day > day.day)) continue;
        hits.set(`${ref.day}#${ref.round}`, ref);
      }
      for (const ref of [...hits.values()].sort((a, b) => a.day.localeCompare(b.day) || a.round - b.round)) {
        found.push(`${day.day} round ${i + 1} = ${ref.day} round ${ref.round}`);
      }
    });
  }
  return found;
}

export const toDayRow = (d: SeedDay): PistasDayRow => ({ day: d.day, number: d.number, contentVersion: d.contentVersion, rounds: d.rounds });

export type SeedStatus = 'new' | 'changed' | 'unchanged';

export interface SeedEntry {
  day: string;
  number: number;
  status: SeedStatus;
  /** The content (and so the content version) differs from the stored day. */
  contentChanged: boolean;
  runs: number;
  /** Ranked runs this correction unranks (written only with --write). */
  voids: number;
  contentVersion: number;
  previousVersion: number | null;
}

export interface SeedPlan {
  entries: SeedEntry[];
  /** Stored days the files do not contain; reported, never deleted. */
  extraDays: string[];
}

const contentDiffers = (before: PistasDayRow, after: PistasDayRow): boolean =>
  before.contentVersion !== after.contentVersion || canonical(before.rounds) !== canonical(after.rounds);

export function planSeed(
  stored: ReadonlyMap<string, PistasDayRow>,
  runs: ReadonlyMap<string, { runs: number; ranked: number }>,
  incoming: readonly PistasDayRow[],
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
 * Plans (and unless `dryRun`, writes) the whole set in ONE transaction; a refused correction writes
 * nothing. A permitted correction unranks the day's runs (their scores were earned on other content)
 * and never touches their state: /start moves each run onto the new content as it stands.
 */
/**
 * Daily players the private duel pool already uses (duel packs are harvestable, so a daily answer may never
 * be a pool player). Counted by display name; an absent duel_pool table (before its migration) means none.
 */
export async function duelPoolOverlap(sql: Sql, rows: readonly PistasDayRow[]): Promise<number> {
  const [table] = await sql<Array<{ present: boolean }>>`SELECT to_regclass('public.duel_pool') IS NOT NULL AS present`;
  if (!table?.present) return 0;
  // Disabled pool items count too (their packs were already dealt), and so does everything the pool ever held.
  const pool = await sql<Array<{ answer: { display: Record<string, string>; accepted: string[] } }>>`
    SELECT payload->'answer' AS answer FROM duel_pool WHERE game = 'pistas'
    UNION ALL SELECT jsonb_build_object('display', display, 'accepted', accepted) FROM pistas_content_ledger WHERE side = 'pool'
  `;
  // samePlayer against every pool player, indexed: a display name of one side among all names of the other.
  const names = (values: Iterable<string>) => [...values].map(normalizeAnswer).filter((v) => v.length > 2);
  const poolDisplay = new Set<string>();
  const poolAny = new Set<string>();
  for (const item of pool) {
    const display = Object.values(item.answer?.display ?? {});
    for (const name of names(display)) poolDisplay.add(name);
    for (const name of names([...display, ...(item.answer?.accepted ?? [])])) poolAny.add(name);
  }
  return rows.reduce((n, row) => n + row.rounds.filter((round) => {
    const display = Object.values(round.answer.display);
    return names(display).some((name) => poolAny.has(name)) || names([...display, ...round.answer.accepted]).some((name) => poolDisplay.has(name));
  }).length, 0);
}

/** Taken by the days seed and the duel pool writer, so each re-checks the other's content inside its own write. */
export const PISTAS_CONTENT_LOCK = 'pistas-content';

type LedgerPlayer = { display: Record<string, string>; accepted: string[] };

/** One ledger identity per player: every normalised name, sorted. */
const playerIdentity = (player: LedgerPlayer): string =>
  [...new Set([...Object.values(player.display), ...player.accepted].map(normalizeAnswer).filter((name) => name.length > 2))].sort().join('|');

/** Records published players (inside the write's transaction), in one statement; a player already recorded for that side and day is kept once. */
export async function recordPistasContent(tx: Sql, side: 'day' | 'pool', entries: ReadonlyArray<LedgerPlayer & { day: string | null }>): Promise<void> {
  const rows = entries
    .map(({ display, accepted, day }) => ({ display, accepted, day, identity: playerIdentity({ display, accepted }) }))
    .filter((row) => row.identity.length > 0);
  if (rows.length === 0) return;
  await tx`
    INSERT INTO pistas_content_ledger (side, display, accepted, identity, day)
    SELECT ${side}, e->'display', e->'accepted', e->>'identity', (e->>'day')::date FROM jsonb_array_elements(${tx.json(rows as never)}) AS e
    ON CONFLICT (side, identity, COALESCE(day, '1970-01-01'::date)) DO NOTHING
  `;
}

/** Daily answers the ledger remembers (players corrected away included), as pseudo-days. */
export async function ledgerDailyPlayers(sql: Sql): Promise<DayPlayers[]> {
  const ledger = await sql<Array<{ day: string; display: Record<string, string>; accepted: string[] }>>`
    SELECT day::text AS day, display, accepted FROM pistas_content_ledger WHERE side = 'day'
  `;
  const byDay = new Map<string, Array<{ answer: LedgerPlayer }>>();
  for (const entry of ledger) (byDay.get(entry.day) ?? byDay.set(entry.day, []).get(entry.day)!).push({ answer: { display: entry.display, accepted: entry.accepted } });
  return [...byDay].map(([day, rounds]) => ({ day, rounds }));
}

export async function seedDays(
  sql: Sql, rows: readonly PistasDayRow[], opts: { appendOnly?: boolean; dryRun: boolean; allowCorrection: boolean; allowRepeats?: boolean; allowPoolOverlap?: boolean },
): Promise<SeedPlan> {
  return sql.begin((transaction) => seedDaysTx(transaction as unknown as Sql, rows, opts)) as Promise<SeedPlan>;
}

/** The seed inside the caller's transaction (a CMS approval commits the batch row and the days together). */
export async function seedDaysTx(
  tx: Sql, rows: readonly PistasDayRow[], opts: { appendOnly?: boolean; dryRun: boolean; allowCorrection: boolean; allowRepeats?: boolean; allowPoolOverlap?: boolean },
): Promise<SeedPlan> {
  // The production role kills a transaction idle for 15 s; keep generous but bounded budgets.
  await tx`SET LOCAL lock_timeout = '5s'`;
  await tx`SET LOCAL statement_timeout = '60s'`;
  await tx`SET LOCAL idle_in_transaction_session_timeout = '60s'`;
  // One seed at a time (gameplay's FOR SHARE row locks do not conflict with this table lock), and never beside a
  // pool write: the overlap with the duel pool is checked here, inside the write.
  await tx`SELECT pg_advisory_xact_lock(hashtext(${PISTAS_CONTENT_LOCK}))`;
  await tx`LOCK TABLE pistas_days IN SHARE ROW EXCLUSIVE MODE`;
  const storedRows = await tx<Array<Omit<PistasDayRow, 'contentVersion'> & { contentVersion: string }>>`
    SELECT day::text AS day, number, content_version AS "contentVersion", rounds FROM pistas_days
  `;
  const stored = new Map(storedRows.map((r) => [r.day, { ...r, contentVersion: Number(r.contentVersion) }]));
  // The stored days are the calendar: a seed may extend it but never leave a hole in it.
  assertUnbrokenCalendar(CONTENT_START, stored.keys(), rows.map((row) => row.day));
  // An append (CMS-approved batch) may only add days after the stored ones: never correct or re-supply one.
  if (opts.appendOnly) assertAppendOnly(stored.keys(), rows.map((row) => row.day));
  // Only what this seed writes: a stored day supplied again unchanged is not re-judged.
  const writing = rows.filter((row) => { const before = stored.get(row.day); return !before || contentDiffers(before, row) || before.number !== row.number; });
  const overlap = await duelPoolOverlap(tx, writing);
  if (overlap > 0 && !opts.allowPoolOverlap) throw new Error(`${overlap} daily player(s) are in the duel pool; refused (duel content is harvestable)`);
  // A player is a daily answer once: never on a day other than the one that published it.
  if (!opts.allowRepeats) {
    // everything a day ever published stays used on every OTHER day: the stored days (including the ones these files
    // replace, before the ledger has seen them) and the ledger (players corrected away); repeatedPlayers skips a day's own
    const others = [...stored.values(), ...(await ledgerDailyPlayers(tx))];
    const repeats = [...new Set([...repeatedPlayers(rows, rows), ...repeatedPlayers(rows, others)])];
    if (repeats.length > 0) throw new Error(`a player is the answer on two days (pass --allow-repeats to reuse a player on purpose): ${repeats.join('; ')}`);
  }
  // Every start and move holds FOR SHARE on its day row until it commits. Taking FOR UPDATE on the
  // days whose content changes waits for those in flight and holds back new ones, so the run counts
  // below are final and no run can start or move on the old content once it is replaced.
  const correcting = rows.filter((row) => stored.has(row.day) && contentDiffers(stored.get(row.day)!, row)).map((row) => row.day).sort();
  if (correcting.length > 0) {
    await tx`SELECT day FROM pistas_days WHERE day = ANY(${tx.array(correcting)}::date[]) ORDER BY day FOR UPDATE`;
  }
  const runRows = await tx<Array<{ day: string; runs: number; ranked: number }>>`
    SELECT day::text AS day, count(*)::int AS runs, (count(*) FILTER (WHERE ranked))::int AS ranked FROM pistas_runs GROUP BY day
  `;
  const plan = planSeed(stored, new Map(runRows.map((r) => [r.day, { runs: r.runs, ranked: r.ranked }])), rows, opts);
  if (opts.dryRun) return plan;
  const byDay = new Map(rows.map((row) => [row.day, row]));
  for (const entry of plan.entries) {
    if (entry.status === 'unchanged') continue;
    const row = byDay.get(entry.day)!;
    await tx`
      INSERT INTO pistas_days (day, number, content_version, rounds)
      VALUES (${row.day}, ${row.number}, ${row.contentVersion}, ${tx.json(row.rounds as never)})
      ON CONFLICT (day) DO UPDATE SET number = EXCLUDED.number, content_version = EXCLUDED.content_version, rounds = EXCLUDED.rounds
    `;
    if (entry.contentChanged && entry.runs > 0) {
      await tx`UPDATE pistas_runs SET ranked = false WHERE day = ${row.day} AND ranked`;
    }
  }
  // everything stored before this write (players shipped before the ledger existed, and what a correction replaces)
  // and everything it wrote: a player stays published even after it leaves the table
  await recordPistasContent(tx, 'day', [...stored.values(), ...rows].flatMap((row) => row.rounds.map((round) => ({ ...round.answer, day: row.day }))));
  return plan;
}

export type PistasSeedTarget = 'local' | SeedTargetName;
export const SEED_TARGETS: readonly PistasSeedTarget[] = ['local', 'staging', 'production'];

/**
 * Host guard (Buscaminas' guard, with the target always explicit): `--target local` needs a local
 * DATABASE_URL; staging/production need a DATABASE_URL of exactly that Supabase project.
 */
export function resolvePistasSeedTarget(databaseUrl: string | undefined, target: PistasSeedTarget | undefined): { kind: PistasSeedTarget; label: string } {
  if (!target) throw new Error('--target local|staging|production is required');
  if (target !== 'local') return resolveSeedTarget(databaseUrl, target);
  try {
    return resolveSeedTarget(databaseUrl, undefined);
  } catch (error) {
    throw new Error(`--target local: ${(error as Error).message}`);
  }
}
