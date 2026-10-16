#!/usr/bin/env npx tsx

// Football Tenable in Russian, on STAGING (or an isolated local database). Nothing is written without --write.
//   npx tsx scripts/tenable-ru-seed.ts names [--write]
//       one immutable set of manager / club / nation names (tenable_ru_name_sets / tenable_ru_names) from
//       scripts/.snapshots/tenable-names-ru.json (scripts/tenable-names-ru.ts); refused unless it names every one of them
//   npx tsx scripts/tenable-ru-seed.ts pin --players=<wordgame ru version> --names=<name set> [--write]
//       pins every played release (served days, the room pool, live matches) that has no Russian names yet. A release is
//       pinned only when every entity of it has a Russian name and every list on it is playable in Cyrillic; a pin is
//       never changed. Replicas read a new pin after their next restart.
//   npx tsx scripts/tenable-ru-seed.ts titles [--write]
//       Russian titles and notes (tenable_list_ru) from scripts/.snapshots/tenable-titles-ru.json; lists keep their hash.
// Prints ids and counts only, never names of list entries.
//   [--env-file=.env]

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import postgres, { type Sql } from 'postgres';
import { normalizeNameCyrillic } from '../src/modules/footballers/footballers.text.js';
import { listProblems, russianTextSource, tenableListSchema, type TenableList } from '../src/modules/tenable/tenable.content.js';
import { buildDirectory, type EntityKind, type TenableEntity } from '../src/modules/tenable/tenable.identify.js';
import { russianRows } from '../src/modules/tenable/tenable.russian.js';
import { TENABLE_CONTENT_LOCK } from '../src/modules/tenable/tenable.seed.js';
import { POOLER_SAFE, requireStagingTarget } from './staging-target.js';

const NAMES = path.resolve('scripts/.snapshots/tenable-names-ru.json');
const TITLES = path.resolve('scripts/.snapshots/tenable-titles-ru.json');
const opt = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const write = process.argv.includes('--write');
const mode = process.argv[2];
const dbUrl = readFileSync(opt('env-file') ?? '.env', 'utf8').match(/^DATABASE_URL\s*=\s*"?([^"\n]+)"?/m)?.[1] ?? '';
requireStagingTarget(dbUrl, { allowLocal: true });
const sql = postgres(dbUrl, { ...POOLER_SAFE, ssl: /127\.0\.0\.1|localhost/.test(dbUrl) ? false : 'require', max: 1, connect_timeout: 20, idle_timeout: 30, onnotice: () => undefined });

const CYRILLIC_ONLY = (t: string) => /[а-яё]/i.test(t) && !/\p{Script=Latin}/u.test(t);
type Kind = 'manager' | 'club' | 'nation';
interface Snapshot { entities: Record<string, { name: string; known: string; aliases: string[] }>; qualifiers: Record<string, string> }

async function locked<T>(fn: (tx: Sql) => Promise<T>): Promise<T> {
  return sql.begin(async (transaction) => {
    const tx = transaction as unknown as Sql;
    await tx`SET LOCAL lock_timeout = '5s'`;
    await tx`SET LOCAL statement_timeout = '300s'`;
    await tx`SET LOCAL idle_in_transaction_session_timeout = '120s'`;
    // The content seed's lock: no list or release is published while names are checked and pinned.
    await tx`SELECT pg_advisory_xact_lock(hashtext(${TENABLE_CONTENT_LOCK}))`;
    return fn(tx);
  }) as Promise<T>;
}

async function names(): Promise<void> {
  if (!existsSync(NAMES)) throw new Error(`Missing ${NAMES}: run scripts/tenable-names-ru.ts first`);
  const snapshot = JSON.parse(readFileSync(NAMES, 'utf8')) as Snapshot;
  const sources = await sql.begin('read only', (tx) => tx<Array<{ kind: Kind; eid: string; qualifier: string | null }>>`
    SELECT DISTINCT ON (kind, eid) kind, eid, qualifier FROM tenable_entities e JOIN tenable_entity_releases r ON r.id = e.release_id
    ORDER BY kind, eid, r.created_at DESC`);
  const missing: string[] = [];
  const rows = sources.flatMap((s) => {
    const ru = snapshot.entities[`${s.kind}:${s.eid}`];
    if (!ru || !CYRILLIC_ONLY(ru.name) || !CYRILLIC_ONLY(ru.known)) { missing.push(`${s.kind}:${s.eid}`); return []; }
    // "France · 1972" → "Франция · 1972"; a country without a Russian name keeps the qualifier's year only.
    const [country, ...rest] = (s.qualifier ?? '').split(' · ');
    const countryRu = country && !/^\d+$/.test(country) ? snapshot.qualifiers[country] : null;
    const qualifier = s.qualifier === null ? null : [countryRu ?? (country && /^\d+$/.test(country) ? country : null), ...rest].filter(Boolean).join(' · ') || null;
    return [{ kind: s.kind, eid: s.eid, name_ru: ru.name.normalize('NFC'), known_ru: ru.known.normalize('NFC'), aliases_ru: ru.aliases.map((a) => a.normalize('NFC')), qualifier_ru: qualifier }];
  });
  if (missing.length > 0) throw new Error(`${missing.length} entities have no Russian name (${missing.slice(0, 10).join(', ')}); run scripts/tenable-names-ru.ts again`);
  // An alias that is another entity's own name would take that name from it ("Спартак" as a former name of another club).
  const owned = new Map<string, Set<string>>();
  for (const r of rows) for (const n of [r.name_ru, r.known_ru]) {
    const key = `${r.kind}:${normalizeNameCyrillic(n)}`;
    owned.set(key, (owned.get(key) ?? new Set()).add(r.eid));
  }
  let dropped = 0;
  for (const r of rows) {
    const kept = r.aliases_ru.filter((a) => {
      const holders = owned.get(`${r.kind}:${normalizeNameCyrillic(a)}`);
      return !holders || (holders.size === 1 && holders.has(r.eid));
    }).slice(0, 24);
    dropped += r.aliases_ru.length - kept.length;
    r.aliases_ru = kept;
  }
  const canonical = [...rows].sort((a, b) => (a.kind + a.eid < b.kind + b.eid ? -1 : 1)).map((r) => [r.kind, r.eid, r.name_ru, r.known_ru, r.aliases_ru, r.qualifier_ru]);
  const fingerprint = createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 32);
  const version = `trn-${new Date().toISOString().slice(0, 10)}-${fingerprint.slice(0, 8)}`;
  console.log(`name set ${version}: ${rows.length} entities, ${dropped} aliases dropped (another entity's name)`);
  if (!write) { console.log('Dry run: nothing written (add --write).'); return; }
  await locked(async (tx) => {
    const [existing] = await tx<Array<{ fingerprint: string }>>`SELECT fingerprint FROM tenable_ru_name_sets WHERE version = ${version}`;
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error(`Name set ${version} exists with other content`);
      console.log('Already there with the same content.');
      return;
    }
    await tx`INSERT INTO tenable_ru_name_sets (version, fingerprint, entities) VALUES (${version}, ${fingerprint}, ${rows.length})`;
    for (let i = 0; i < rows.length; i += 1_000) {
      await tx`INSERT INTO tenable_ru_names ${tx(rows.slice(i, i + 1_000).map((r) => ({ version, ...r })), 'version', 'kind', 'eid', 'name_ru', 'known_ru', 'aliases_ru', 'qualifier_ru')}`;
    }
    console.log(`Written: ${version}. Pin releases with: pin --players=<version> --names=${version}`);
  });
}

async function latinRows(tx: Sql, kind: EntityKind, release: string): Promise<TenableEntity[]> {
  return kind === 'player'
    ? tx<TenableEntity[]>`
        SELECT p.pid AS eid, p.name, p.game_name AS known, p.fame, p.aliases, m.qualifier
        FROM wordgame_players p LEFT JOIN tenable_player_meta m ON m.release_id = p.release_id AND m.pid = p.pid
        WHERE p.release_id = ${release}`
    : tx<TenableEntity[]>`SELECT eid, name, known, fame, aliases, qualifier FROM tenable_entities WHERE release_id = ${release} AND kind = ${kind}`;
}

/** Every list that is or may still be played: served days, the whole room pool, and the lists of live matches. */
async function playedLists(tx: Sql): Promise<TenableList[]> {
  const raw = await tx<Array<{ list: unknown }>>`
    SELECT list FROM tenable_days
    UNION ALL SELECT payload FROM room_pool WHERE game = 'tenable'
    UNION ALL SELECT l FROM room_matches m JOIN room_match_content c ON c.match_id = m.id CROSS JOIN jsonb_array_elements(c.content->'lists') l
      WHERE m.game = 'tenable' AND m.status IN ('ready', 'active')`;
  return raw.flatMap((r) => { const parsed = tenableListSchema.safeParse(r.list); return parsed.success ? [parsed.data] : []; });
}

async function pin(): Promise<void> {
  const players = opt('players');
  const namesVersion = opt('names');
  if (!players || !namesVersion) throw new Error('pin needs --players=<wordgame ru version> and --names=<name set>');
  await locked(async (tx) => {
    const lists = await playedLists(tx);
    const pinned = new Set((await tx<Array<{ k: string }>>`SELECT kind || ':' || release_id AS k FROM tenable_ru_releases`).map((r) => r.k));
    const releases = [...new Map(lists.map((l) => [`${l.kind}:${l.release}`, { kind: l.kind, release: l.release }])).values()];
    const todo = releases.filter((r) => !pinned.has(`${r.kind}:${r.release}`));
    console.log(`${releases.length} played releases, ${releases.length - todo.length} pinned already, ${todo.length} to check`);
    const ready: typeof todo = [];
    for (const r of todo) {
      const latin = await latinRows(tx, r.kind, r.release);
      const proposed = r.kind === 'player' ? { players_version: players, names_version: null } : { players_version: null, names_version: namesVersion };
      const russian = await russianRows(tx, r.kind, r.release, latin, proposed);
      if (!russian) { console.log(`${r.kind}:${r.release}: NOT pinned, the Russian names do not cover all ${latin.length} entities`); continue; }
      const directory = buildDirectory(r.kind, r.release, russian, 'cyrillic');
      const failures = lists.filter((l) => l.kind === r.kind && l.release === r.release).flatMap((l) => listProblems(l, directory).map((p) => `${l.id}: ${p}`));
      if (failures.length > 0) {
        console.log(`${r.kind}:${r.release}: NOT pinned, ${failures.length} slot problem(s) in Cyrillic:\n  ${failures.slice(0, 15).join('\n  ')}`);
        continue;
      }
      console.log(`${r.kind}:${r.release}: ready (${latin.length} entities)`);
      ready.push(r);
    }
    if (!write) { console.log('Dry run: nothing written (add --write).'); return; }
    for (const r of ready) {
      await tx`INSERT INTO tenable_ru_releases (kind, release_id, players_version, names_version)
        VALUES (${r.kind}, ${r.release}, ${r.kind === 'player' ? players : null}, ${r.kind === 'player' ? null : namesVersion})`;
    }
    console.log(`Pinned ${ready.length}. Restart the backend so every replica loads them.`);
  });
}

async function titles(): Promise<void> {
  if (!existsSync(TITLES)) throw new Error(`Missing ${TITLES}: run scripts/tenable-titles-ru.ts first`);
  const translated = JSON.parse(readFileSync(TITLES, 'utf8')) as Record<string, { src: string; title: string; note: string | null }>;
  await locked(async (tx) => {
    const lists = await playedLists(tx);
    const rows = [...new Map(lists.map((l) => [l.id, l])).values()].flatMap((l) => {
      const t = translated[l.id];
      if (!t || t.src !== russianTextSource(l)) return [];
      if ((l.note === null) !== (t.note === null) || t.title.length > 90 || (t.note?.length ?? 0) > 200) return [];
      return [{ list_id: l.id, src: t.src, title: t.title, note: t.note }];
    });
    const lacking = new Set(lists.map((l) => l.id)).size - rows.length;
    console.log(`${rows.length} lists with a Russian title for their current English, ${lacking} without`);
    if (!write) { console.log('Dry run: nothing written (add --write).'); return; }
    for (let i = 0; i < rows.length; i += 500) {
      await tx`INSERT INTO tenable_list_ru ${tx(rows.slice(i, i + 500), 'list_id', 'src', 'title', 'note')} ON CONFLICT (list_id, src) DO UPDATE SET title = EXCLUDED.title, note = EXCLUDED.note`;
    }
    console.log('Written. Replicas show them within five minutes.');
  });
}

const run = mode === 'names' ? names : mode === 'pin' ? pin : mode === 'titles' ? titles : null;
if (!run) { console.error('usage: tenable-ru-seed.ts names|pin|titles [--write]'); process.exit(1); }
run().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; }).finally(() => sql.end());
