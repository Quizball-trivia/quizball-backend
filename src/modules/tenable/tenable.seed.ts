import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { z } from 'zod';
import { addDays } from '../daily/daily.calendar.js';
import { canonical } from '../pistas/pistas.seed.js';
import { CONTENT_START } from '../tenable-daily/tenable-daily.days.js';
import { listProblems, tenableListSchema, type TenableList } from './tenable.content.js';
import { russianPinOf, russianRows } from './tenable.russian.js';
import { buildDirectory, TENABLE_MATCHER_VERSION, withRussian, type Directory, type EntityKind, type TenableEntity } from './tenable.identify.js';

/**
 * Seeding of Football Tenable's lists: the solo days (tenable_days) and the room pool (room_pool, game 'tenable'),
 * validated and written in ONE transaction under one lock, with every published list appended to the ledger in the same
 * transaction. Nothing here may print an answer: messages name list ids, days and counts only.
 */
export const TENABLE_CONTENT_LOCK = 'tenable-content';
/** Two lists sharing this many entities are the same list for the overlap rule. */
export const OVERLAP_ENTITIES = 4;

const supersedesSchema = z.string().min(1).max(80).optional();
type SeedList = TenableList & { supersedes?: string };

const daysFileSchema = z.object({ days: z.array(z.object({ day: z.string(), list: z.unknown() }).strict()).min(1) }).strict();
const poolFileSchema = z.object({ lists: z.array(z.unknown()).min(1) }).strict();

export const contentHash = (content: unknown): number => parseInt(createHash('sha256').update(canonical(content)).digest('hex').slice(0, 8), 16) || 1;
const dayNumber = (day: string): number => Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${CONTENT_START}T00:00:00Z`)) / 86_400_000) + 1;

/** `supersedes` is the seed's own field: it is taken off before the stored list is validated (the list schema is strict). */
function parseList(raw: unknown, where: string): SeedList {
  const { supersedes, ...rest } = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const lineage = supersedesSchema.safeParse(supersedes);
  const parsed = tenableListSchema.safeParse(rest);
  // The issue path names the field; its message could quote content, so only the path is printed.
  if (!parsed.success || !lineage.success) throw new Error(`${where}: invalid list (${parsed.success ? 'supersedes' : parsed.error.issues.slice(0, 4).map((i) => i.path.join('.') || 'shape').join(', ')})`);
  if (lineage.data === parsed.data.id) throw new Error(`${where}: a list cannot supersede itself`);
  return { ...parsed.data, ...(lineage.data ? { supersedes: lineage.data } : {}) };
}

/** Contiguous days from CONTENT_START, one list each, no list on two days. */
export { parseList };
export function parseDaysFile(raw: unknown): Array<{ day: string; number: number; list: SeedList }> {
  const parsed = daysFileSchema.safeParse(raw);
  if (!parsed.success) throw new Error('Invalid days file: expected {days: [{day, list}]}');
  const ids = new Set<string>();
  return parsed.data.days.map((d, i) => {
    const expected = addDays(CONTENT_START, i);
    if (d.day !== expected) throw new Error(`days must be contiguous from ${CONTENT_START}: position ${i + 1} is ${d.day}, expected ${expected}`);
    const list = parseList(d.list, d.day);
    if (ids.has(list.id)) throw new Error(`${d.day}: list ${list.id} is on more than one day`);
    ids.add(list.id);
    return { day: d.day, number: dayNumber(d.day), list };
  });
}

export function parsePoolFile(raw: unknown): SeedList[] {
  const parsed = poolFileSchema.safeParse(raw);
  if (!parsed.success) throw new Error('Invalid pool file: expected {lists: [...]}');
  const lists = parsed.data.lists.map((l, i) => parseList(l, `list ${i + 1}`));
  const ids = new Set(lists.map((l) => l.id));
  if (ids.size !== lists.length) throw new Error('A list id appears twice in the pool file');
  return lists;
}

async function loadDirectory(tx: Sql, kind: EntityKind, release: string): Promise<Directory> {
  const rows = kind === 'player'
    ? await tx<TenableEntity[]>`
        SELECT p.pid AS eid, p.name, p.game_name AS known, p.fame, p.aliases, m.qualifier
        FROM wordgame_players p LEFT JOIN tenable_player_meta m ON m.release_id = p.release_id AND m.pid = p.pid
        WHERE p.release_id = ${release}`
    : await tx<TenableEntity[]>`SELECT eid, name, known, fame, aliases, qualifier FROM tenable_entities WHERE release_id = ${release} AND kind = ${kind}`;
  if (rows.length === 0) throw new Error(`Release ${release} has no ${kind} entities here; seed the release first`);
  const latin = buildDirectory(kind, release, rows);
  const pin = await russianPinOf(tx, kind, release);
  const russian = pin ? await russianRows(tx, kind, release, rows, pin) : null;
  return russian ? withRussian(latin, buildDirectory(kind, release, russian, 'cyrillic')) : latin;
}

/** Every list against its directory (reachable slots), in the target database's own releases. */
async function checkPlayable(tx: Sql, lists: readonly SeedList[]): Promise<void> {
  const directories = new Map<string, Directory>();
  const failures: string[] = [];
  for (const list of lists) {
    const key = `${list.kind}:${list.release}`;
    if (!directories.has(key)) directories.set(key, await loadDirectory(tx, list.kind, list.release));
    const directory = directories.get(key)!;
    // A release with Russian names keeps every list playable in Cyrillic too.
    const problems = [...listProblems(list, directory), ...(directory.russian ? listProblems(list, directory.russian).map((p) => `in Russian: ${p}`) : [])];
    // Problems name slot numbers and entity ids, never names.
    if (problems.length > 0) failures.push(`${list.id}: ${problems.slice(0, 3).join('; ')}`);
  }
  if (failures.length > 0) throw new Error(`${failures.length} list(s) are not playable; nothing written:\n${failures.slice(0, 20).join('\n')}`);
}

interface LedgerRow { side: string; list_id: string; topic_key: string; eids: string[]; supersedes: string | null; day: string | null }

/**
 * A list may not repeat the topic of anything published under another id (except its own lineage on the same side: what
 * it supersedes, transitively, and what supersedes it), nor share OVERLAP_ENTITIES entities with a list on the other
 * side: a room reveal must never hand out a daily answer (and the reserved demo lists are public already). A daily list
 * belongs to its day: neither it nor a correction of it may land on another day (the old day is in the public archive).
 */
export function overlapFailures(lists: ReadonlyArray<SeedList & { day?: string }>, side: 'day' | 'room', ledger: readonly LedgerRow[]): string[] {
  const failures: string[] = [];
  const all: LedgerRow[] = [...ledger, ...lists.map((l) => ({ side, list_id: l.id, topic_key: l.topicKey, eids: l.slots.map((s) => s.eid), supersedes: l.supersedes ?? null, day: l.day ?? null }))];
  const parents = new Map<string, Set<string>>();
  for (const r of all) {
    if (r.side !== side || !r.supersedes) continue;
    if (!parents.has(r.list_id)) parents.set(r.list_id, new Set());
    parents.get(r.list_id)!.add(r.supersedes);
  }
  const ancestors = (id: string): Set<string> => {
    const seen = new Set<string>();
    const stack = [...(parents.get(id) ?? [])];
    while (stack.length > 0) {
      const p = stack.pop()!;
      if (seen.has(p)) continue;
      seen.add(p);
      stack.push(...(parents.get(p) ?? []));
    }
    return seen;
  };
  for (const list of lists) {
    const up = ancestors(list.id);
    if (up.has(list.id)) { failures.push(`${list.id}: its supersedes chain loops`); continue; }
    if (list.supersedes && !all.some((r) => r.side === side && r.list_id === list.supersedes)) {
      failures.push(`${list.id} supersedes ${list.supersedes}, which is not published on the ${side} side`);
      continue;
    }
    if (side === 'day') {
      const elsewhere = all.find((r) => r.side === 'day' && (r.list_id === list.id || up.has(r.list_id)) && r.day && r.day !== list.day);
      if (elsewhere) { failures.push(`${list.id} would move a list published on ${elsewhere.day} to ${list.day}`); continue; }
    }
    const eids = new Set(list.slots.map((s) => s.eid));
    for (const other of all) {
      // The same list on the same side is a republication (or a correction) of itself; on the other side it never is.
      if (other.list_id === list.id && other.side === side) continue;
      if (other.list_id === list.id) {
        failures.push(`${list.id} is already published on the ${other.side} side`);
        break;
      }
      if (other.side === side && (up.has(other.list_id) || ancestors(other.list_id).has(list.id))) continue;
      // Across sides, shared entities leak (a room reveal would show a daily's answers); on one side they are only
      // related lists (two tables of one league), refused only when they are the same topic.
      const shared = other.side === side ? 0 : other.eids.filter((e) => eids.has(e)).length;
      if (other.topic_key === list.topicKey || shared >= OVERLAP_ENTITIES) {
        failures.push(`${list.id} repeats ${other.side} list ${other.list_id} (${other.topic_key === list.topicKey ? 'same topic' : `${shared} shared`})`);
        break;
      }
    }
  }
  return failures;
}

async function lockAndReadLedger(tx: Sql): Promise<LedgerRow[]> {
  // The production role kills a transaction idle for 15 s; keep generous but bounded budgets.
  await tx`SET LOCAL lock_timeout = '5s'`;
  await tx`SET LOCAL statement_timeout = '120s'`;
  await tx`SET LOCAL idle_in_transaction_session_timeout = '120s'`;
  await tx`SELECT pg_advisory_xact_lock(hashtext(${TENABLE_CONTENT_LOCK}))`;
  // Every version ever published, retired ones included: a corrected list keeps its old content reserved.
  return tx<LedgerRow[]>`SELECT side, list_id, topic_key, eids, supersedes, day::text AS day FROM tenable_content_ledger`;
}

export interface SeedOutcome { fresh: number; unchanged: number; corrected: number; unranked: number }

/** The days in one transaction. A changed day that already has runs needs `allowCorrection` (its ranked runs are unranked). */
export async function seedDays(sql: Sql, days: ReadonlyArray<{ day: string; number: number; list: SeedList }>, opts: { dryRun: boolean; allowCorrection: boolean }): Promise<SeedOutcome> {
  return sql.begin(async (transaction) => {
    const tx = transaction as unknown as Sql;
    const ledger = await lockAndReadLedger(tx);
    await tx`LOCK TABLE tenable_days IN SHARE ROW EXCLUSIVE MODE`;
    await checkPlayable(tx, days.map((d) => d.list));
    const overlaps = overlapFailures(days.map((d) => ({ ...d.list, day: d.day })), 'day', ledger);
    if (overlaps.length > 0) throw new Error(`${overlaps.length} overlap(s); nothing written:\n${overlaps.slice(0, 20).join('\n')}`);
    const stored = new Map((await tx<Array<{ day: string; contentVersion: string }>>`SELECT day::text AS day, content_version AS "contentVersion" FROM tenable_days`).map((r) => [r.day, Number(r.contentVersion)]));
    const withVersion = days.map((d) => {
      const { supersedes: _s, ...list } = d.list;
      return { ...d, stored: list, version: contentHash(list) };
    });
    const changed = withVersion.filter((d) => stored.has(d.day) && stored.get(d.day) !== d.version).map((d) => d.day).sort();
    // Every start and move holds FOR SHARE on its day row until it commits: FOR UPDATE waits for those in flight.
    if (changed.length > 0) await tx`SELECT day FROM tenable_days WHERE day = ANY(${tx.array(changed)}::date[]) ORDER BY day FOR UPDATE`;
    const played = new Map((await tx<Array<{ day: string; runs: number }>>`
      SELECT day::text AS day, count(*)::int AS runs FROM tenable_runs WHERE day = ANY(${tx.array(changed)}::date[]) GROUP BY day`).map((r) => [r.day, r.runs]));
    const blocked = changed.filter((day) => (played.get(day) ?? 0) > 0);
    if (blocked.length > 0 && !opts.allowCorrection) throw new Error(`Refusing to change days that already have runs (${blocked.join(', ')}); pass --allow-correction (their ranked runs are unranked)`);
    const outcome: SeedOutcome = { fresh: 0, unchanged: 0, corrected: 0, unranked: 0 };
    for (const d of withVersion) {
      if (!stored.has(d.day)) outcome.fresh += 1;
      else if (stored.get(d.day) === d.version) { outcome.unchanged += 1; continue; }
      else outcome.corrected += 1;
      if (opts.dryRun) continue;
      await tx`
        INSERT INTO tenable_days (day, number, content_version, list) VALUES (${d.day}, ${d.number}, ${d.version}, ${tx.json(d.stored as never)})
        ON CONFLICT (day) DO UPDATE SET number = EXCLUDED.number, content_version = EXCLUDED.content_version, list = EXCLUDED.list`;
      await tx`
        INSERT INTO tenable_content_ledger (side, list_id, topic_key, kind, eids, day, supersedes)
        VALUES ('day', ${d.list.id}, ${d.list.topicKey}, ${d.list.kind}, ${tx.array(d.list.slots.map((s) => s.eid))}, ${d.day}, ${d.list.supersedes ?? null})`;
      if (stored.has(d.day) && (played.get(d.day) ?? 0) > 0) outcome.unranked += (await tx`UPDATE tenable_runs SET ranked = false WHERE day = ${d.day} AND ranked`).count;
    }
    return outcome;
  }) as Promise<SeedOutcome>;
}

/** The room pool in one transaction: new lists added, unchanged ones kept, a changed one refused (room packs are immutable). */
export async function seedPool(sql: Sql, lists: readonly SeedList[], opts: { dryRun: boolean }): Promise<{ fresh: number; unchanged: number }> {
  return sql.begin(async (transaction) => {
    const tx = transaction as unknown as Sql;
    const ledger = await lockAndReadLedger(tx);
    await checkPlayable(tx, lists);
    const overlaps = overlapFailures(lists, 'room', ledger);
    if (overlaps.length > 0) throw new Error(`${overlaps.length} overlap(s); nothing written:\n${overlaps.slice(0, 20).join('\n')}`);
    const stored = new Map((await tx<Array<{ item_id: string; fingerprint: string }>>`SELECT item_id, fingerprint FROM room_pool WHERE game = 'tenable'`).map((r) => [r.item_id, r.fingerprint]));
    const out = { fresh: 0, unchanged: 0 };
    const superseded: string[] = [];
    for (const list of lists) {
      const { supersedes: _s, ...payload } = list;
      const fingerprint = createHash('sha256').update(canonical(payload)).digest('hex').slice(0, 32);
      const existing = stored.get(list.id);
      if (existing === fingerprint) { out.unchanged += 1; continue; }
      if (existing) throw new Error(`${list.id}: a room list changed; publish a new id that supersedes it instead`);
      out.fresh += 1;
      if (opts.dryRun) continue;
      await tx`
        INSERT INTO room_pool (game, item_id, difficulty, fingerprint, payload, tags)
        VALUES ('tenable', ${list.id}, ${list.tier}, ${fingerprint}, ${tx.json(payload as never)}, ${tx.array([list.kind])})`;
      if (list.supersedes) superseded.push(list.supersedes);
      await tx`
        INSERT INTO tenable_content_ledger (side, list_id, topic_key, kind, eids, supersedes)
        VALUES ('room', ${list.id}, ${list.topicKey}, ${list.kind}, ${tx.array(list.slots.map((s) => s.eid))}, ${list.supersedes ?? null})`;
    }
    // After every insert: a chain given in any order (C, B, A) leaves only its newest version dealt.
    if (superseded.length > 0) await tx`UPDATE room_pool SET enabled = false WHERE game = 'tenable' AND item_id = ANY(${tx.array(superseded)})`;
    return out;
  }) as Promise<{ fresh: number; unchanged: number }>;
}

const entityFileSchema = z.object({
  release: z.string().min(3).max(40),
  entities: z.array(z.object({
    eid: z.string().min(1).max(64),
    kind: z.enum(['manager', 'club', 'nation']),
    name: z.string().min(1).max(80),
    known: z.string().min(1).max(80),
    aliases: z.array(z.string().min(1).max(80)).max(24),
    qualifier: z.string().min(1).max(40).nullable(),
    fame: z.number().int().min(0).max(100),
  }).passthrough()).min(1),
}).passthrough();

/**
 * An entity release (managers, clubs, nations) in one transaction. A release is immutable: the same release with the
 * same content is "unchanged", different content under an existing id is refused (lists name the release they were
 * checked against; publish a new release id instead).
 */
export async function seedEntityRelease(sql: Sql, raw: unknown, opts: { dryRun: boolean }): Promise<{ release: string; counts: Record<string, number>; status: 'new' | 'unchanged' }> {
  const parsed = entityFileSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid entity file (${parsed.error.issues.slice(0, 4).map((i) => i.path.join('.') || 'shape').join(', ')})`);
  const { release, entities } = parsed.data;
  const ids = new Set<string>();
  for (const e of entities) {
    const key = `${e.kind}:${e.eid}`;
    if (ids.has(key)) throw new Error(`Duplicate entity ${key}`);
    ids.add(key);
  }
  const rows = entities.map((e) => ({ eid: e.eid, kind: e.kind, name: e.name, known: e.known, aliases: e.aliases, qualifier: e.qualifier, fame: e.fame }));
  const fingerprint = createHash('sha256').update(canonical(rows.sort((a, b) => (a.kind + a.eid < b.kind + b.eid ? -1 : 1)))).digest('hex').slice(0, 32);
  const counts = rows.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.kind]: (acc[r.kind] ?? 0) + 1 }), {});
  return sql.begin(async (transaction) => {
    const tx = transaction as unknown as Sql;
    await tx`SET LOCAL lock_timeout = '5s'`;
    await tx`SET LOCAL statement_timeout = '300s'`;
    await tx`SET LOCAL idle_in_transaction_session_timeout = '120s'`;
    await tx`SELECT pg_advisory_xact_lock(hashtext(${TENABLE_CONTENT_LOCK}))`;
    const [existing] = await tx<Array<{ fingerprint: string }>>`SELECT fingerprint FROM tenable_entity_releases WHERE id = ${release}`;
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error(`Entity release ${release} exists with other content; publish a new release id`);
      return { release, counts, status: 'unchanged' as const };
    }
    if (!opts.dryRun) {
      await tx`INSERT INTO tenable_entity_releases (id, fingerprint, matcher_version, counts) VALUES (${release}, ${fingerprint}, ${TENABLE_MATCHER_VERSION}, ${tx.json(counts)})`;
      for (let i = 0; i < rows.length; i += 2_000) {
        const page = rows.slice(i, i + 2_000).map((r) => ({ release_id: release, kind: r.kind, eid: r.eid, name: r.name, known: r.known, fame: r.fame, aliases: r.aliases, qualifier: r.qualifier }));
        await tx`INSERT INTO tenable_entities ${tx(page, 'release_id', 'kind', 'eid', 'name', 'known', 'fame', 'aliases', 'qualifier')}`;
      }
    }
    return { release, counts, status: 'new' as const };
  }) as Promise<{ release: string; counts: Record<string, number>; status: 'new' | 'unchanged' }>;
}

const playerMetaSchema = z.object({
  release: z.string().min(1).max(64),
  players: z.array(z.object({ pid: z.string().min(1).max(64), qualifier: z.string().min(1).max(40) }).strict()).min(1),
}).strict();

/**
 * Qualifiers of a footballer release's namesakes (tenable_player_meta), append-only: a qualifier once written never
 * changes (an answer box may be showing it). Every pid must be in the release. A process that already loaded the
 * release's directory shows new qualifiers after its next restart.
 */
export async function seedPlayerMeta(sql: Sql, raw: unknown, opts: { dryRun: boolean }): Promise<{ release: string; fresh: number; unchanged: number }> {
  const parsed = playerMetaSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid player meta file (${parsed.error.issues.slice(0, 4).map((i) => i.path.join('.') || 'shape').join(', ')})`);
  const { release, players } = parsed.data;
  if (new Set(players.map((p) => p.pid)).size !== players.length) throw new Error('A pid appears twice in the player meta file');
  return sql.begin(async (transaction) => {
    const tx = transaction as unknown as Sql;
    await tx`SET LOCAL lock_timeout = '5s'`;
    await tx`SET LOCAL statement_timeout = '120s'`;
    await tx`SET LOCAL idle_in_transaction_session_timeout = '120s'`;
    await tx`SELECT pg_advisory_xact_lock(hashtext(${TENABLE_CONTENT_LOCK}))`;
    const pids = players.map((p) => p.pid);
    const [{ known }] = await tx<Array<{ known: number }>>`SELECT count(*)::int AS known FROM wordgame_players WHERE release_id = ${release} AND pid = ANY(${tx.array(pids)})`;
    if (known !== players.length) throw new Error(`${players.length - known} pid(s) are not in footballer release ${release}; nothing written`);
    const stored = new Map((await tx<Array<{ pid: string; qualifier: string }>>`
      SELECT pid, qualifier FROM tenable_player_meta WHERE release_id = ${release}`).map((r) => [r.pid, r.qualifier]));
    const changed = players.filter((p) => stored.has(p.pid) && stored.get(p.pid) !== p.qualifier).length;
    if (changed > 0) throw new Error(`${changed} qualifier(s) differ from the stored ones; qualifiers are append-only, nothing written`);
    const fresh = players.filter((p) => !stored.has(p.pid));
    if (!opts.dryRun) {
      for (let i = 0; i < fresh.length; i += 2_000) {
        const page = fresh.slice(i, i + 2_000).map((p) => ({ release_id: release, pid: p.pid, qualifier: p.qualifier }));
        await tx`INSERT INTO tenable_player_meta ${tx(page, 'release_id', 'pid', 'qualifier')}`;
      }
    }
    return { release, fresh: fresh.length, unchanged: players.length - fresh.length };
  }) as Promise<{ release: string; fresh: number; unchanged: number }>;
}
