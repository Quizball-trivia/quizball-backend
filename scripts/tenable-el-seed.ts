#!/usr/bin/env npx tsx

// Football Tenable and Football Darts 501 in Greek, on STAGING (or an isolated local database). Mirrors
// scripts/tenable-ru-seed.ts. Nothing is written without --write.
//   npx tsx scripts/tenable-el-seed.ts names [--write]
//       one immutable set of manager / club / nation names (tenable_el_name_sets / tenable_el_names) from
//       scripts/.snapshots/tenable-names-el.json (scripts/tenable-names-el.ts). An entity whose translation is missing,
//       stale (its source name changed) or not written in Greek letters is left out and listed; a release holding one is
//       then never pinned (a pin needs every entity of the release).
//   npx tsx scripts/tenable-el-seed.ts pin --players=<wordgame el version> --names=<name set> [--write]
//       pins every played release that has no Greek names yet: Tenable's served days, room pool and live matches, and
//       Football Darts 501's (days, room pool, live legs; a release only Darts plays is pinned too). A release is pinned
//       only when every entity of it has a Greek name and every Tenable list on it is playable in Greek; a pin is never
//       changed. Prints the Greek collisions of each release. Replicas read a new pin after their next restart.
//       While the Greek tables or versions are not in the database yet (the dry run before the deploy), the names are
//       built locally from the same snapshots the seeds read (wordgame-names-el.json + fixes, tenable-names-el.json);
//       --write always reads them from the database.
// Prints ids and counts only for list entries; collision examples name the forms involved (console only).
//   [--env-file=.env]

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import postgres, { type Sql } from 'postgres';
import { isGreekText, normalizeName, normalizeNameGreek } from '../src/modules/footballers/footballers.text.js';
import { listProblems, tenableListSchema, type TenableList } from '../src/modules/tenable/tenable.content.js';
import { buildDirectory, type EntityKind, type TenableEntity } from '../src/modules/tenable/tenable.identify.js';
import { greekRows, type GreekPin } from '../src/modules/tenable/tenable.greek.js';
import { TENABLE_CONTENT_LOCK } from '../src/modules/tenable/tenable.seed.js';
import { POOLER_SAFE, requireStagingTarget } from './staging-target.js';

const NAMES = path.resolve('scripts/.snapshots/tenable-names-el.json');
const PLAYERS = path.resolve('scripts/.snapshots/wordgame-names-el.json');
const PLAYER_FIXES = path.resolve('scripts/.snapshots/wordgame-names-el-fixes.json');
const PAGE = 10_000;
const MAX_ALIASES = 24;
const opt = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const write = process.argv.includes('--write');
const mode = process.argv[2];
const dbUrl = readFileSync(opt('env-file') ?? '.env', 'utf8').match(/^DATABASE_URL\s*=\s*"?([^"\n]+)"?/m)?.[1] ?? '';
requireStagingTarget(dbUrl, { allowLocal: true });
const local = /127\.0\.0\.1|localhost/.test(dbUrl);
const sql = postgres(dbUrl, { ...POOLER_SAFE, ssl: local ? false : 'require', max: 1, connect_timeout: 20, idle_timeout: 30, onnotice: () => undefined });
// postgres.js types TransactionSql via Omit<>, which loses the tagged-template call signature; at runtime it is one.
const txSql = (tx: postgres.TransactionSql): Sql => tx as unknown as Sql;

/** A dropped pooler connection is retried (the next query reconnects); reads only. */
async function withRetry<T>(read: () => Promise<T>, tries = 5): Promise<T> {
  for (let i = 1; ; i += 1) {
    try { return await read(); } catch (error) { if (i >= tries || !/CONNECTION_CLOSED|ECONNRESET|CONNECT_TIMEOUT/.test(String(error))) throw error; }
  }
}
const readOnly = <T>(read: (tx: Sql) => Promise<T>): Promise<T> => withRetry(() => sql.begin('read only', (tx) => read(txSql(tx))) as Promise<T>);

/** Invisible format characters (zero-width spaces, direction marks) copied in from Wikidata are dropped. */
const clean = (text: string) => text.normalize('NFC').replace(/\p{Cf}/gu, '').replace(/\s+/g, ' ').trim();
/**
 * Greek letters only: every letter is Greek (accents allowed), at least one is, and the rest is digits, spaces and
 * . ' ’ - / (with the Greek keraia ΄ / ʹ as an apostrophe and – as a hyphen). Anything else (a Latin or Cyrillic letter,
 * brackets, &) is refused.
 */
function greekOnly(text: string): 'ok' | 'letter' | 'sign' | 'empty' {
  const t = clean(text);
  if (!t || t.length > 80 || !/\p{Script=Greek}/u.test(t)) return 'empty';
  for (const ch of t.normalize('NFD')) {
    if (/\p{M}/u.test(ch)) continue;
    if (/\p{L}/u.test(ch)) { if (!/\p{Script=Greek}/u.test(ch)) return 'letter'; continue; }
    if (!/[\s.'’\-/0-9΄ʹʼ–]/u.test(ch)) return 'sign';
  }
  return 'ok';
}
/** "Λίβερπουλ (ομάδα)" → "Λίβερπουλ": a trailing bracketed note is a description, not a name. */
const withoutNote = (alias: string) => clean(alias).replace(/\s*\([^)]*\)\s*$/u, '').trim();

type Kind = 'manager' | 'club' | 'nation';
interface Snapshot { entities: Record<string, { name: string; known: string; aliases: string[]; src: string }>; qualifiers: Record<string, string> }
interface NameRow { kind: Kind; eid: string; name_el: string; known_el: string; aliases_el: string[]; qualifier_el: string | null }
/** scripts/tenable-names-el.ts' freshness key: the source names the translation was made from. */
const sourceKey = (name: string, known: string) => createHash('sha256').update(JSON.stringify([name, known])).digest('hex').slice(0, 16);

async function locked<T>(fn: (tx: Sql) => Promise<T>): Promise<T> {
  return sql.begin(async (transaction) => {
    const tx = txSql(transaction);
    await tx`SET LOCAL lock_timeout = '5s'`;
    await tx`SET LOCAL statement_timeout = '300s'`;
    await tx`SET LOCAL idle_in_transaction_session_timeout = '120s'`;
    // The content seed's lock: no list or release is published while names are checked and pinned.
    await tx`SELECT pg_advisory_xact_lock(hashtext(${TENABLE_CONTENT_LOCK}))`;
    return fn(tx);
  }) as Promise<T>;
}

/** The manager / club / nation name set, built from the snapshot against every entity id of every release. */
async function buildNames(): Promise<{ version: string; fingerprint: string; rows: NameRow[]; sources: number }> {
  if (!existsSync(NAMES)) throw new Error(`Missing ${NAMES}: run scripts/tenable-names-el.ts first`);
  const snapshot = JSON.parse(readFileSync(NAMES, 'utf8')) as Snapshot;
  const sources = await readOnly((tx) => tx<Array<{ kind: Kind; eid: string; name: string; known: string; qualifier: string | null }>>`
    SELECT DISTINCT ON (kind, eid) kind, eid, name, known, qualifier FROM tenable_entities e JOIN tenable_entity_releases r ON r.id = e.release_id
    ORDER BY kind, eid, r.created_at DESC`);
  const missing = { none: [] as string[], stale: [] as string[], script: [] as string[] };
  const aliasDrops = { letter: 0, sign: 0, empty: 0, same: 0, owned: 0, cap: 0, noted: 0 };
  const rows = sources.flatMap((s): NameRow[] => {
    const key = `${s.kind}:${s.eid}`;
    const el = snapshot.entities[key];
    if (!el) { missing.none.push(key); return []; }
    if (el.src !== sourceKey(s.name, s.known)) { missing.stale.push(key); return []; }
    if (greekOnly(el.name) !== 'ok' || greekOnly(el.known) !== 'ok') { missing.script.push(key); return []; }
    const name = clean(el.name);
    const known = clean(el.known);
    const seen = new Set([normalizeNameGreek(name), normalizeNameGreek(known)]);
    const aliases: string[] = [];
    for (const raw of el.aliases) {
      const alias = withoutNote(raw);
      if (alias !== clean(raw)) aliasDrops.noted += 1;
      const verdict = greekOnly(alias);
      if (verdict !== 'ok') { aliasDrops[verdict] += 1; continue; }
      const k = normalizeNameGreek(alias);
      if (seen.has(k)) { aliasDrops.same += 1; continue; }
      seen.add(k);
      aliases.push(alias);
    }
    // "France · 1972" → "Γαλλία · 1972"; a country without a Greek name keeps the qualifier's year only.
    const [country, ...rest] = (s.qualifier ?? '').split(' · ');
    const countryEl = country && !/^\d+$/.test(country) ? snapshot.qualifiers[country] : null;
    const qualifier = s.qualifier === null ? null : [countryEl ?? (country && /^\d+$/.test(country) ? country : null), ...rest].filter(Boolean).join(' · ').slice(0, 60) || null;
    return [{ kind: s.kind, eid: s.eid, name_el: name, known_el: known, aliases_el: aliases, qualifier_el: qualifier }];
  });
  // An alias that is another entity's own name would take that name from it.
  const owned = new Map<string, Set<string>>();
  for (const r of rows) for (const n of [r.name_el, r.known_el]) {
    const key = `${r.kind}:${normalizeNameGreek(n)}`;
    owned.set(key, (owned.get(key) ?? new Set()).add(r.eid));
  }
  for (const r of rows) {
    const kept = r.aliases_el.filter((a) => {
      const holders = owned.get(`${r.kind}:${normalizeNameGreek(a)}`);
      const mine = !holders || (holders.size === 1 && holders.has(r.eid));
      if (!mine) aliasDrops.owned += 1;
      return mine;
    });
    aliasDrops.cap += Math.max(0, kept.length - MAX_ALIASES);
    r.aliases_el = kept.slice(0, MAX_ALIASES);
  }
  const byKind = (list: Array<{ kind: string }>) => Object.fromEntries((['manager', 'club', 'nation'] as const).map((k) => [k, list.filter((x) => x.kind === k).length]));
  console.log(`sources (newest release per id): ${JSON.stringify(byKind(sources))}; named in Greek: ${JSON.stringify(byKind(rows))}`);
  for (const [why, keys] of Object.entries(missing)) if (keys.length) console.log(`  left out (${why === 'none' ? 'no translation' : why === 'stale' ? 'source name changed since translated' : 'not Greek letters'}): ${keys.length} — ${keys.slice(0, 10).join(', ')}`);
  console.log(`  aliases kept ${rows.reduce((n, r) => n + r.aliases_el.length, 0)}; bracketed notes stripped ${aliasDrops.noted}; dropped: other script ${aliasDrops.letter}, other signs ${aliasDrops.sign}, empty ${aliasDrops.empty}, same as the name ${aliasDrops.same}, another entity's name ${aliasDrops.owned}, over ${MAX_ALIASES} ${aliasDrops.cap}`);
  const canonical = [...rows].sort((a, b) => (a.kind + a.eid < b.kind + b.eid ? -1 : 1)).map((r) => [r.kind, r.eid, r.name_el, r.known_el, r.aliases_el, r.qualifier_el]);
  const fingerprint = createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 32);
  return { version: `tel-${new Date().toISOString().slice(0, 10)}-${fingerprint.slice(0, 8)}`, fingerprint, rows, sources: sources.length };
}

async function names(): Promise<void> {
  const { version, fingerprint, rows } = await buildNames();
  console.log(`name set ${version}: ${rows.length} entities`);
  if (!write) { console.log('Dry run: nothing written (add --write).'); return; }
  await locked(async (tx) => {
    const [existing] = await tx<Array<{ fingerprint: string }>>`SELECT fingerprint FROM tenable_el_name_sets WHERE version = ${version}`;
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error(`Name set ${version} exists with other content`);
      console.log('Already there with the same content.');
      return;
    }
    await tx`INSERT INTO tenable_el_name_sets (version, fingerprint, entities) VALUES (${version}, ${fingerprint}, ${rows.length})`;
    for (let i = 0; i < rows.length; i += 1_000) {
      await tx`INSERT INTO tenable_el_names ${tx(rows.slice(i, i + 1_000).map((r) => ({ version, ...r })), 'version', 'kind', 'eid', 'name_el', 'known_el', 'aliases_el', 'qualifier_el')}`;
    }
    console.log(`Written: ${version}. Pin releases with: pin --players=<version> --names=${version}`);
  });
}

/**
 * The word games' Greek names exactly as scripts/wordgame-el-names-seed.ts builds its version (same artifact, fixes,
 * rules and fingerprint), for a dry run before that version is in the database. Returns the fingerprint so the caller
 * can check it is the version it was given.
 */
async function buildPlayers(): Promise<{ fingerprint: string; rows: Map<string, { name_el: string; game_name_el: string; aliases_el: string[] }> }> {
  if (!existsSync(PLAYERS)) throw new Error(`Missing ${PLAYERS}`);
  type Entry = { full: string; short: string; alt?: string[] };
  const artifact = JSON.parse(readFileSync(PLAYERS, 'utf8')) as Record<string, Entry>;
  if (existsSync(PLAYER_FIXES)) Object.assign(artifact, JSON.parse(readFileSync(PLAYER_FIXES, 'utf8')) as Record<string, Entry>);
  const usable = (t: string | undefined): t is string => !!t && t.length <= 80 && /[α-ω]/.test(normalizeNameGreek(t)) && !/\p{Script=Latin}|\p{Script=Cyrillic}/u.test(t);
  const all: Array<{ release_id: string; pid: string; name: string; game_name: string; fame: number; created_at: string }> = [];
  for (let after = { r: '', p: '' }; ;) {
    const from = after;
    const page = await readOnly((tx) => tx<typeof all>`
      SELECT w.release_id, w.pid, w.name, w.game_name, w.fame, r.created_at::text AS created_at
        FROM wordgame_players w JOIN wordgame_releases r ON r.id = w.release_id
       WHERE (w.release_id, w.pid) > (${from.r}, ${from.p}) ORDER BY w.release_id, w.pid LIMIT ${PAGE}`);
    all.push(...page);
    if (page.length < PAGE) break;
    after = { r: page[page.length - 1].release_id, p: page[page.length - 1].pid };
  }
  const newest = new Map<string, (typeof all)[number]>();
  for (const r of all) { const seen = newest.get(r.pid); if (!seen || r.created_at > seen.created_at) newest.set(r.pid, r); }
  const rows: Array<[string, string, string, string[], number]> = [];
  for (const p of newest.values()) {
    const entry = artifact[`${p.name}|${p.game_name}`];
    const full = entry?.full.normalize('NFC');
    const short = entry?.short.normalize('NFC');
    if (!entry || !usable(full) || !usable(short)) continue;
    const seen = new Set([normalizeNameGreek(full), normalizeNameGreek(short)]);
    const aliases: string[] = [];
    for (const raw of entry.alt ?? []) {
      const alt = raw.normalize('NFC').trim();
      const key = normalizeNameGreek(alt);
      if (!usable(alt) || seen.has(key) || aliases.length >= 4) continue;
      seen.add(key);
      aliases.push(alt);
    }
    rows.push([p.pid, full, short, aliases, p.fame]);
  }
  rows.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const fingerprint = createHash('sha256').update(JSON.stringify(rows)).digest('hex').slice(0, 32);
  return { fingerprint, rows: new Map(rows.map(([pid, name_el, game_name_el, aliases_el]) => [pid, { name_el, game_name_el, aliases_el }])) };
}

/** A stand-in for the database that answers greekRows' two page queries from names built here (dry run only). */
function localNames(players: Map<string, { name_el: string; game_name_el: string; aliases_el: string[] }>, set: NameRow[], latin: readonly TenableEntity[]): Sql {
  const ids = new Set(latin.map((e) => e.eid));
  const byKind = new Map<string, NameRow[]>();
  for (const r of set) byKind.set(r.kind, [...(byKind.get(r.kind) ?? []), r]);
  return (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    const player = text.includes('wordgame_el_names');
    if (!player && !text.includes('tenable_el_names')) throw new Error('unexpected query in a local dry run');
    const [after, limit] = values.slice(-2) as [string, number];
    const rows = player
      ? [...players].filter(([pid]) => ids.has(pid)).map(([eid, n]) => ({ eid, name: n.name_el, known: n.game_name_el, aliases: n.aliases_el, qualifier: null }))
      : (byKind.get(values[2] as string) ?? []).filter((r) => ids.has(r.eid)).map((r) => ({ eid: r.eid, name: r.name_el, known: r.known_el, aliases: r.aliases_el, qualifier: r.qualifier_el }));
    return rows.filter((r) => r.eid > after).sort((a, b) => (a.eid < b.eid ? -1 : 1)).slice(0, limit);
  }) as unknown as Sql;
}

async function latinRows(kind: EntityKind, release: string): Promise<TenableEntity[]> {
  const out: TenableEntity[] = [];
  for (let after = ''; ;) {
    const from = after;
    const page = await readOnly((tx) => (kind === 'player'
      ? tx<TenableEntity[]>`
          SELECT p.pid AS eid, p.name, p.game_name AS known, p.fame, p.aliases, m.qualifier
          FROM wordgame_players p LEFT JOIN tenable_player_meta m ON m.release_id = p.release_id AND m.pid = p.pid
          WHERE p.release_id = ${release} AND p.pid > ${from} ORDER BY p.pid LIMIT ${PAGE}`
      : tx<TenableEntity[]>`SELECT eid, name, known, fame, aliases, qualifier FROM tenable_entities
          WHERE release_id = ${release} AND kind = ${kind} AND eid > ${from} ORDER BY eid LIMIT ${PAGE}`));
    out.push(...page);
    if (page.length < PAGE) return out;
    after = page[page.length - 1].eid;
  }
}

/** Every Tenable list that is or may still be played: served days, the whole room pool, and the lists of live matches. */
async function playedLists(): Promise<TenableList[]> {
  const raw = await readOnly((tx) => tx<Array<{ list: unknown }>>`
    SELECT list FROM tenable_days
    UNION ALL SELECT payload FROM room_pool WHERE game = 'tenable'
    UNION ALL SELECT l FROM room_matches m JOIN room_match_content c ON c.match_id = m.id CROSS JOIN jsonb_array_elements(c.content->'lists') l
      WHERE m.game = 'tenable' AND m.status IN ('ready', 'active')`);
  return raw.flatMap((r) => { const parsed = tenableListSchema.safeParse(r.list); return parsed.success ? [parsed.data] : []; });
}

/** Every Darts 501 category that is or may still be played (days, room pool, live legs): footballer releases only. */
async function playedCategories(): Promise<Array<{ id: string; release: string; eids: string[] }>> {
  const raw = await readOnly((tx) => tx<Array<{ c: { id?: unknown; release?: unknown; entries?: unknown } }>>`
    SELECT category AS c FROM darts501_days
    UNION ALL SELECT payload FROM room_pool WHERE game = 'darts501'
    UNION ALL SELECT l FROM room_matches m JOIN room_match_content c ON c.match_id = m.id CROSS JOIN jsonb_array_elements(c.content->'legs') l
      WHERE m.game = 'darts501' AND m.status IN ('ready', 'active')`);
  return raw.flatMap(({ c }) => (typeof c?.release === 'string' && typeof c.id === 'string' && Array.isArray(c.entries)
    ? [{ id: c.id, release: c.release, eids: (c.entries as Array<{ eid?: unknown }>).map((e) => String(e.eid)) }]
    : []));
}

/**
 * Greek forms (name, known name, aliases; compared normalised) held by more than one entity of the release, and Greek
 * forms a typed answer would not route to the Greek names (no Greek letter) that equal another entity's Latin form.
 */
function collisions(latin: readonly TenableEntity[], greek: readonly TenableEntity[]) {
  const holders = new Map<string, Set<string>>();
  const fullNames = new Map<string, Set<string>>();
  for (const e of greek) {
    for (const form of [e.name, e.known, ...e.aliases]) {
      const k = normalizeNameGreek(form);
      if (k) holders.set(k, (holders.get(k) ?? new Set()).add(e.eid));
    }
    const k = normalizeNameGreek(e.name);
    fullNames.set(k, (fullNames.get(k) ?? new Set()).add(e.eid));
  }
  const latinForms = new Map<string, Set<string>>();
  for (const e of latin) for (const form of [e.name, e.known, ...e.aliases]) {
    const k = normalizeName(form);
    if (k) latinForms.set(k, (latinForms.get(k) ?? new Set()).add(e.eid));
  }
  const crossScript: string[] = [];
  for (const e of greek) for (const form of [e.name, e.known, ...e.aliases]) {
    if (isGreekText(form)) continue;
    const others = [...(latinForms.get(normalizeName(form)) ?? [])].filter((eid) => eid !== e.eid);
    if (others.length) crossScript.push(`${e.eid} "${form}" = Latin form of ${others.join(', ')}`);
  }
  const shared = [...holders].filter(([, eids]) => eids.size > 1);
  const sharedFull = [...fullNames].filter(([, eids]) => eids.size > 1);
  // For scale: the same count in Latin.
  const latinFull = new Map<string, number>();
  for (const e of latin) latinFull.set(normalizeName(e.name), (latinFull.get(normalizeName(e.name)) ?? 0) + 1);
  return { shared, sharedFull, crossScript, latinSharedFull: [...latinFull.values()].filter((n) => n > 1).length };
}

async function pin(): Promise<void> {
  const players = opt('players');
  const namesVersion = opt('names');
  if (!players || !namesVersion) throw new Error('pin needs --players=<wordgame el version> and --names=<name set>');
  const [tables] = await readOnly((tx) => tx<Array<{ releases: string | null }>>`SELECT to_regclass('public.tenable_el_releases')::text AS releases`);
  let inDb = false;
  if (tables.releases) {
    const [found] = await readOnly((tx) => tx<Array<{ players: boolean; names: boolean }>>`
      SELECT EXISTS (SELECT 1 FROM wordgame_el_versions WHERE version = ${players}) AS players,
             EXISTS (SELECT 1 FROM tenable_el_name_sets WHERE version = ${namesVersion}) AS names`);
    inDb = found.players && found.names;
  }
  if (write && !inDb) throw new Error(`--write needs the Greek tables and both versions in the database (${players}, ${namesVersion}); write them first`);
  let source: { players: Awaited<ReturnType<typeof buildPlayers>>['rows']; names: NameRow[] } | null = null;
  if (!inDb) {
    console.log(tables.releases ? 'The given versions are not in the database: building them locally from the snapshots (dry run).' : 'The Greek tables are not in this database yet: building the names locally from the snapshots (dry run).');
    const [built, set] = [await buildPlayers(), await buildNames()];
    const suffix = players.split('-').pop();
    console.log(`players: ${built.rows.size} Greek names, fingerprint ${built.fingerprint.slice(0, 8)} (${suffix === built.fingerprint.slice(0, 8) ? 'matches' : 'DOES NOT MATCH'} ${players}); names: ${set.version} (${set.version === namesVersion ? 'matches' : `given ${namesVersion}`})`);
    source = { players: built.rows, names: set.rows };
  }
  const lists = await playedLists();
  const categories = await playedCategories();
  const pinned = tables.releases ? new Set((await readOnly((tx) => tx<Array<{ k: string }>>`SELECT kind || ':' || release_id AS k FROM tenable_el_releases`)).map((r) => r.k)) : new Set<string>();
  const tenableReleases = new Map(lists.map((l) => [`${l.kind}:${l.release}`, { kind: l.kind, release: l.release }]));
  const dartsOnly = [...new Set(categories.map((c) => c.release))].filter((r) => !tenableReleases.has(`player:${r}`)).map((release) => ({ kind: 'player' as EntityKind, release }));
  const releases = [...tenableReleases.values(), ...dartsOnly];
  const todo = releases.filter((r) => !pinned.has(`${r.kind}:${r.release}`));
  console.log(`${lists.length} Tenable lists and ${categories.length} Darts 501 categories in play; ${releases.length} releases (${dartsOnly.length} Darts-only), ${releases.length - todo.length} pinned already, ${todo.length} to check`);
  const ready: typeof todo = [];
  const totals = { shared: 0, sharedFull: 0, crossScript: 0 };
  for (const r of todo) {
    const label = `${r.kind}:${r.release}${dartsOnly.includes(r) ? ' (Darts only)' : ''}`;
    const latin = await latinRows(r.kind, r.release);
    const proposed: GreekPin = r.kind === 'player' ? { players_version: players, names_version: null } : { players_version: null, names_version: namesVersion };
    let greek = await greekRows(source ? localNames(source.players, source.names, latin) : sql, r.kind, r.release, latin, proposed);
    let covered = true;
    if (!greek) {
      covered = false;
      const named = source ? new Set(r.kind === 'player' ? [...source.players.keys()] : source.names.filter((n) => n.kind === r.kind).map((n) => n.eid)) : null;
      const lacking = named ? latin.filter((e) => !named.has(e.eid)) : [];
      console.log(`${label}: NOT pinned, the Greek names do not cover all ${latin.length} entities${named ? ` (${lacking.length} without: ${lacking.slice(0, 8).map((e) => e.eid).join(', ')})` : ''}`);
      if (!named) continue;
      // The rest is reported on the entities that have a Greek name (what a pin would hold once the gaps are named).
      const part = latin.filter((e) => named.has(e.eid));
      greek = await greekRows(localNames(source!.players, source!.names, part), r.kind, r.release, part, proposed);
      if (!greek) continue;
    }
    const directory = buildDirectory(r.kind, r.release, greek, 'greek');
    const failures = lists.filter((l) => l.kind === r.kind && l.release === r.release).flatMap((l) => listProblems(l, directory).map((p) => `${l.id}: ${p}`));
    // Darts categories: reported, not a condition (the Latin names are not checked this way either).
    const dartsIssues = r.kind === 'player'
      ? categories.filter((c) => c.release === r.release).flatMap((c) => listProblems({ id: c.id, kind: 'player', release: r.release, slots: c.eids.map((eid) => ({ eid })) } as unknown as TenableList, directory).map((p) => `${c.id}: ${p}`))
      : [];
    const found = collisions(latin, greek);
    totals.shared += found.shared.length; totals.sharedFull += found.sharedFull.length; totals.crossScript += found.crossScript.length;
    const example = (rows: Array<[string, Set<string>]>) => rows.slice(0, 4).map(([form, eids]) => `"${form}" ${[...eids].slice(0, 4).join('/')}${eids.size > 4 ? '…' : ''}`).join('; ');
    console.log(`${label}: ${greek.length} entities named in Greek; collisions: ${found.shared.length} shared forms (${found.sharedFull.length} shared full names; ${found.latinSharedFull} in Latin), ${found.crossScript.length} equal to another entity's Latin form`);
    if (found.sharedFull.length) console.log(`    shared full names e.g. ${example(found.sharedFull)}`);
    if (found.shared.length) console.log(`    shared forms e.g. ${example(found.shared)}`);
    if (found.crossScript.length) console.log(`    cross-script e.g. ${found.crossScript.slice(0, 4).join('; ')}`);
    if (dartsIssues.length) console.log(`    Darts 501 entries hard to name in Greek: ${dartsIssues.length} (e.g. ${dartsIssues.slice(0, 5).join('; ')})`);
    if (failures.length > 0) {
      console.log(`${label}: ${covered ? 'NOT pinned, ' : '(covered part) '}${failures.length} slot problem(s) in Greek:\n  ${failures.slice(0, 15).join('\n  ')}`);
      continue;
    }
    if (!covered) continue;
    console.log(`${label}: ready`);
    ready.push(r);
  }
  console.log(`collisions over the checked releases: ${totals.shared} shared Greek forms (${totals.sharedFull} shared full names), ${totals.crossScript} equal to another entity's Latin form`);
  console.log(`ready to pin: ${ready.length} of ${todo.length}: ${ready.map((r) => `${r.kind}:${r.release}`).join(', ') || 'none'}`);
  if (!write) { console.log('Dry run: nothing written (add --write).'); return; }
  await locked(async (tx) => {
    // Checked again under the content lock, on what the database holds now: a list published or a release pinned since is seen.
    const now = new Set((await tx<Array<{ k: string }>>`SELECT kind || ':' || release_id AS k FROM tenable_el_releases`).map((p) => p.k));
    const raw = await tx<Array<{ list: unknown }>>`
      SELECT list FROM tenable_days UNION ALL SELECT payload FROM room_pool WHERE game = 'tenable'
      UNION ALL SELECT l FROM room_matches m JOIN room_match_content c ON c.match_id = m.id CROSS JOIN jsonb_array_elements(c.content->'lists') l
        WHERE m.game = 'tenable' AND m.status IN ('ready', 'active')`;
    const current = raw.flatMap((x) => { const parsed = tenableListSchema.safeParse(x.list); return parsed.success ? [parsed.data] : []; });
    for (const r of ready) {
      if (now.has(`${r.kind}:${r.release}`)) { console.log(`${r.kind}:${r.release}: pinned meanwhile, skipped`); continue; }
      const latin = await latinRows(r.kind, r.release);
      const greek = await greekRows(tx, r.kind, r.release, latin, r.kind === 'player' ? { players_version: players, names_version: null } : { players_version: null, names_version: namesVersion });
      const directory = greek && buildDirectory(r.kind, r.release, greek, 'greek');
      if (!directory || current.some((l) => l.kind === r.kind && l.release === r.release && listProblems(l, directory).length > 0)) throw new Error(`${r.kind}:${r.release} changed during the check; run pin again`);
      await tx`INSERT INTO tenable_el_releases (kind, release_id, players_version, names_version)
        VALUES (${r.kind}, ${r.release}, ${r.kind === 'player' ? players : null}, ${r.kind === 'player' ? null : namesVersion})`;
    }
    console.log(`Pinned ${ready.length}. Restart the backend so every replica loads them.`);
  });
}

const run = mode === 'names' ? names : mode === 'pin' ? pin : null;
if (!run) { console.error('usage: tenable-el-seed.ts names|pin [--write]'); process.exit(1); }
run().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; }).finally(() => sql.end());
