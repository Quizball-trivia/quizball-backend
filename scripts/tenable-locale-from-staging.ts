/**
 * Football Tenable in one Latin-script locale (pt, de, fr) for PRODUCTION, from staging. Each step is a dry run unless --write:
 *
 *   titles   tenable_list_text rows (tenable-titles-pt.ts). A row is keyed by (list id, src = hash of the English title and
 *            note), so it is copied only for a production list with the same id AND the same English; inserted with
 *            ON CONFLICT DO NOTHING (a stored title is never replaced). Replicas read them within five minutes.
 *   aliases  the immutable alias set (tenable-pt-aliases.ts write): the same version id, fingerprint and rows as staging,
 *            inserted in one transaction if production does not have it (the table trigger only lets rows in with their
 *            set). An existing set with the same id must be identical, or the script stops.
 *   pin      tenable_alias_releases rows for the PRODUCTION (kind, release) pairs in use there. Each pair is checked on
 *            production data exactly as tenable-pt-aliases.ts pin does (every list still playable, every spelling
 *            unambiguous); a pair staging uses but did not pin (it failed staging's check) is not pinned either. The dry
 *            run prints every pair and its decision. Then RESTART the backend: pins are read once per process.
 *
 *   names    tenable_display_names rows (tenable-display-names.ts apply): inserted where production has none for that
 *            (locale, kind, eid); a stored name is never replaced. The server shows a name only where the release reads
 *            it as the same entity. Replicas read them within five minutes.
 *   recheck  read only: every pinned production release as the server builds it (spellings by entity id, every pinned
 *            set): every list playable, every pinned spelling still means its own entity.
 *
 * A language may have a supplementary set after its first (pinned to the same releases): run aliases and pin once per
 * --version, the first set first.
 *
 *   PROD_DATABASE_URL=… STAGING_DATABASE_URL=… npx tsx scripts/tenable-locale-from-staging.ts titles|aliases|pin|names|recheck --locale=de [--version=<set>] [--write]
 */
import { createHash } from 'node:crypto';
import postgres from 'postgres';
import { banner, connect, opt, readOnly, requireLocale, sample, snapshot, WRITE, writeTx } from './locale-copy-common.js';
import { judgeTenableRelease } from './tenable-release-judge.js';
import { russianTextSource, tenableListSchema, type TenableList } from '../src/modules/tenable/tenable.content.js';
import { type EntityKind, type TenableEntity } from '../src/modules/tenable/tenable.identify.js';

const [mode] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!['titles', 'aliases', 'pin', 'names', 'recheck'].includes(mode)) { console.error('ABORT: mode must be titles | aliases | pin | names | recheck'); process.exit(1); }
// The tables' locale CHECKs allow pt, de and fr.
const LOCALE = requireLocale(['pt', 'de', 'fr']);
const KINDS = ['club', 'nation'] as const;
const { prod, staging } = connect();

type AliasRow = { kind: string; eid: string; aliases: string[] };
type AliasSet = { version: string; locale: string; fingerprint: string; entities: number };

/** Every list in use (days and room pool), parsed, by id. */
async function allLists(sql: postgres.Sql): Promise<TenableList[]> {
  // Days, the room pool, and the lists of live matches (which may have left the pool).
  const raw = await readOnly(sql, (tx) => tx<Array<{ list: unknown }>>`
    SELECT list FROM tenable_days UNION ALL SELECT payload FROM room_pool WHERE game = 'tenable'
    UNION ALL SELECT l FROM room_matches m JOIN room_match_content c ON c.match_id = m.id CROSS JOIN jsonb_array_elements(c.content->'lists') l
    WHERE m.game = 'tenable' AND m.status IN ('ready', 'active')`);
  return [...new Map(raw.flatMap((r) => { const p = tenableListSchema.safeParse(r.list); return p.success ? [[p.data.id, p.data] as const] : []; })).values()];
}

async function titles() {
  const [prodLists, stagingRows, prodRows] = await Promise.all([
    allLists(prod),
    readOnly(staging, (tx) => tx<Array<{ list_id: string; src: string; title: string; note: string | null }>>`SELECT list_id, src, title, note FROM tenable_list_text WHERE locale = ${LOCALE}`),
    readOnly(prod, (tx) => tx<Array<{ list_id: string; src: string }>>`SELECT list_id, src FROM tenable_list_text WHERE locale = ${LOCALE}`),
  ]);
  const srcOf = new Map(prodLists.map((l) => [l.id, russianTextSource(l)]));
  const stored = new Set(prodRows.map((r) => `${r.list_id}:${r.src}`));
  const stats = { stagingTitles: stagingRows.length, noProductionList: 0, englishDiffers: 0, alreadyStored: 0, toInsert: 0 };
  const rows = stagingRows.filter((r) => {
    const src = srcOf.get(r.list_id);
    if (src === undefined) { stats.noProductionList += 1; return false; }
    if (src !== r.src) { stats.englishDiffers += 1; return false; }
    if (stored.has(`${r.list_id}:${r.src}`)) { stats.alreadyStored += 1; return false; }
    return true;
  });
  stats.toInsert = rows.length;
  const titled = new Set([...stored, ...rows.map((r) => `${r.list_id}:${r.src}`)]);
  const untitled = prodLists.filter((l) => !titled.has(`${l.id}:${russianTextSource(l)}`)).map((l) => l.id);
  console.log({ productionLists: prodLists.length, ...stats });
  console.log(`production lists that stay without a ${LOCALE} title (English shown; translate on production): ${untitled.length}${sample(untitled)}`);
  if (!WRITE || rows.length === 0) return;
  let inserted = 0;
  const written: Array<{ list_id: string; src: string }> = [];
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200).map((r) => ({ locale: LOCALE, list_id: r.list_id, src: r.src, title: r.title, note: r.note }));
    const done = await writeTx(prod, async (tx) => {
      return tx<Array<{ list_id: string; src: string }>>`INSERT INTO tenable_list_text ${tx(chunk, 'locale', 'list_id', 'src', 'title', 'note')} ON CONFLICT (locale, list_id, src) DO NOTHING RETURNING list_id, src`;
    });
    inserted += done.length;
    written.push(...done.map((d) => ({ list_id: d.list_id, src: d.src })));
  }
  // Only the keys this run inserted: a rollback never deletes a title someone else wrote meanwhile.
  console.log(`inserted keys ${snapshot(`tenable-titles-${LOCALE}-inserted`, written)}`);
  console.log(`inserted ${inserted} of ${rows.length}; replicas show them within five minutes`);
}

/** tenable-pt-aliases.ts' fingerprint: the rows sorted by kind + eid, as {kind, eid, aliases}. */
const fingerprintOf = (rows: readonly AliasRow[]) => createHash('sha256')
  .update(JSON.stringify([...rows].map((r) => ({ kind: r.kind, eid: r.eid, aliases: r.aliases })).sort((a, b) => (a.kind + a.eid).localeCompare(b.kind + b.eid))))
  .digest('hex');

async function readSet(sql: postgres.Sql, version: string): Promise<{ set: AliasSet | null; rows: AliasRow[] }> {
  return readOnly(sql, async (tx) => {
    const [set] = await tx<AliasSet[]>`SELECT version, locale, fingerprint, entities FROM tenable_alias_sets WHERE version = ${version}`;
    const rows = await tx<AliasRow[]>`SELECT kind, eid, aliases FROM tenable_aliases WHERE version = ${version} ORDER BY kind, eid`;
    return { set: set ?? null, rows };
  });
}

/** The staging set to copy: --version, or the only set of the locale that staging has. */
async function stagingSet(): Promise<{ set: AliasSet; rows: AliasRow[] }> {
  let version = opt('version');
  if (!version) {
    const sets = await readOnly(staging, (tx) => tx<Array<{ version: string }>>`SELECT version FROM tenable_alias_sets WHERE locale = ${LOCALE} ORDER BY created_at`);
    if (sets.length !== 1) throw new Error(`staging has ${sets.length} ${LOCALE} alias sets (${sets.map((s) => s.version).join(', ')}): pass --version=<set>`);
    version = sets[0].version;
  }
  const { set, rows } = await readSet(staging, version);
  if (!set || set.locale !== LOCALE) throw new Error(`staging has no ${LOCALE} alias set ${version}`);
  // A set is complete only as written: its row count and fingerprint must still be the ones recorded with it.
  if (rows.length !== set.entities || fingerprintOf(rows) !== set.fingerprint) throw new Error(`staging set ${version} does not match its own fingerprint/count (${rows.length} rows, ${set.entities} recorded)`);
  return { set, rows };
}

async function aliases() {
  const { set, rows } = await stagingSet();
  console.log(`staging set ${set.version}: ${rows.length} entities (${rows.filter((r) => r.kind === 'nation').length} nations, ${rows.filter((r) => r.kind === 'club').length} clubs), ${rows.reduce((n, r) => n + r.aliases.length, 0)} spellings, fingerprint ${set.fingerprint.slice(0, 12)}…`);
  const onProd = await readSet(prod, set.version);
  if (onProd.set) {
    const same = onProd.set.fingerprint === set.fingerprint && onProd.rows.length === rows.length && fingerprintOf(onProd.rows) === set.fingerprint;
    if (!same) throw new Error(`production already has a set ${set.version} that differs from staging's: stop and look`);
    console.log('production already has this set, identical: nothing to write. Next: pin');
    return;
  }
  console.log(`production does not have ${set.version}: ${WRITE ? 'inserting' : 'would insert'} the set row and ${rows.length} alias rows in one transaction`);
  if (!WRITE) return;
  await writeTx(prod, async (tx) => {
    await tx`INSERT INTO tenable_alias_sets (version, locale, fingerprint, entities) VALUES (${set.version}, ${LOCALE}, ${set.fingerprint}, ${set.entities})`;
    // One statement for every row; the trigger accepts them because the set was created in this same transaction.
    await tx`INSERT INTO tenable_aliases (version, kind, eid, aliases)
      SELECT ${set.version}, x.kind, x.eid, x.aliases FROM jsonb_to_recordset(${tx.json(rows as never)}::jsonb) AS x(kind text, eid text, aliases text[])`;
  });
  const check = await readSet(prod, set.version);
  console.log(`written: ${check.rows.length} rows, fingerprint ${fingerprintOf(check.rows) === set.fingerprint ? 'matches' : 'DOES NOT MATCH — investigate before pinning'}. Next: pin --version=${set.version}`);
}

async function entitiesOf(kind: EntityKind, release: string): Promise<TenableEntity[]> {
  return readOnly(prod, (tx) => tx<TenableEntity[]>`SELECT eid, name, known, fame, aliases, qualifier FROM tenable_entities WHERE release_id = ${release} AND kind = ${kind}`);
}

/** Every set pinned to this production release (any language), by entity id: what the server merges. */
async function pinnedRows(kind: string, release: string): Promise<{ versions: string[]; rows: AliasRow[] }> {
  return readOnly(prod, async (tx) => {
    const versions = (await tx<Array<{ version: string }>>`SELECT version FROM tenable_alias_releases WHERE kind = ${kind} AND release_id = ${release} ORDER BY created_at, locale`).map((v) => v.version);
    const rows = versions.length ? await tx<AliasRow[]>`SELECT kind, eid, aliases FROM tenable_aliases WHERE version = ANY(${versions})` : [];
    return { versions, rows };
  });
}

/** The shared rule, on production's rows (see tenable-release-judge.ts). */
function judgeRelease(kind: EntityKind, release: string, own: TenableEntity[], lists: TenableList[], pinned: AliasRow[], extra: AliasRow[]) {
  const { problems, fine } = judgeTenableRelease(kind, release, own, lists, pinned, extra);
  for (const line of fine) console.log(`    (fine, on no list) ${line}`);
  return problems;
}

async function pin() {
  const { set, rows } = await stagingSet();
  const onProd = await readSet(prod, set.version);
  if (onProd.set && fingerprintOf(onProd.rows) !== set.fingerprint) throw new Error(`production set ${set.version} differs from staging's`);
  if (!onProd.set) {
    if (WRITE) throw new Error(`production has no set ${set.version}: run "aliases --write" first`);
    console.log(`(production does not have ${set.version} yet; checking with staging's rows)`);
  }
  const [prodLists, stagingLists, stagingPins] = await Promise.all([
    allLists(prod),
    allLists(staging),
    readOnly(staging, (tx) => tx<Array<{ kind: string; release_id: string }>>`SELECT kind, release_id FROM tenable_alias_releases WHERE version = ${set.version}`),
  ]);
  const pinKey = (kind: string, release: string) => `${kind}/${release}`;
  const pinnedOnStaging = new Set(stagingPins.map((p) => pinKey(p.kind, p.release_id)));
  const stagingInUse = new Set(stagingLists.map((l) => pinKey(l.kind, l.release)));
  console.log(`staging pins of ${set.version}: ${[...pinnedOnStaging].join(', ') || 'none'}`);

  const ready: Array<{ kind: string; release: string; versions: string[] }> = [];
  for (const kind of KINDS) {
    for (const release of [...new Set(prodLists.filter((l) => l.kind === kind).map((l) => l.release))].sort()) {
      const key = pinKey(kind, release);
      const lists = prodLists.filter((l) => l.kind === kind && l.release === release);
      const current = await pinnedRows(kind, release);
      if (current.versions.includes(set.version)) { console.log(`  ${key} (${lists.length} lists): already pinned on production to ${set.version}`); continue; }
      if (stagingInUse.has(key) && !pinnedOnStaging.has(key)) {
        console.log(`  ${key} (${lists.length} lists): NOT pinned — staging uses this release but did not pin ${set.version} to it`);
        continue;
      }
      const own = await entitiesOf(kind, release);
      if (!rows.some((r) => own.some((e) => e.eid === r.eid))) { console.log(`  ${key}: not pinned — the set names none of its entities`); continue; }
      const problems = own.length === 0 ? ['no entities for this release on production'] : judgeRelease(kind, release, own, lists, current.rows, rows);
      if (problems.length) {
        console.log(`  ${key} (${lists.length} lists): NOT pinned\n    ${problems.slice(0, 20).join('\n    ')}`);
        continue;
      }
      ready.push({ kind, release, versions: current.versions });
      console.log(`  ${key} (${lists.length} lists): ${WRITE ? 'PIN' : 'would pin'} — every list still playable, every spelling its own entity, no existing name changes meaning${pinnedOnStaging.has(key) ? ' (pinned on staging too)' : ' (release not used on staging)'}`);
    }
  }
  console.log(`\n${ready.length} pins ${WRITE ? 'to write' : 'would be written'}: ${ready.map((r) => pinKey(r.kind, r.release)).join(', ') || 'none'}`);
  if (!WRITE || ready.length === 0) return;
  await writeTx(prod, async (tx) => {
    // No other pin may land between the check above and these rows.
    await tx`LOCK TABLE tenable_alias_releases IN SHARE ROW EXCLUSIVE MODE`;
    for (const r of ready) {
      const now = (await tx<Array<{ version: string }>>`SELECT version FROM tenable_alias_releases WHERE kind = ${r.kind} AND release_id = ${r.release} ORDER BY created_at, locale`).map((v) => v.version);
      if (now.join() !== r.versions.join()) throw new Error(`${r.kind}/${r.release}: pins changed during the check; run pin again`);
    }
    await tx`INSERT INTO tenable_alias_releases (kind, release_id, locale, version)
      SELECT x.kind, x.release, ${LOCALE}, ${set.version} FROM jsonb_to_recordset(${tx.json(ready.map((r) => ({ kind: r.kind, release: r.release })) as never)}::jsonb) AS x(kind text, release text)`;
  });
  console.log(`Pinned ${ready.length}. RESTART the production backend so every replica loads them (pins are read once per process).`);
}

async function recheck() {
  const lists = await allLists(prod);
  const pinned = await readOnly(prod, (tx) => tx<Array<{ kind: EntityKind; release_id: string }>>`SELECT DISTINCT kind, release_id FROM tenable_alias_releases ORDER BY kind, release_id`);
  let bad = 0;
  for (const { kind, release_id: release } of pinned) {
    const current = await pinnedRows(kind, release);
    const mine = lists.filter((l) => l.kind === kind && l.release === release);
    const problems = judgeRelease(kind, release, await entitiesOf(kind, release), mine, current.rows, []);
    if (problems.length) bad += 1;
    console.log(`  ${kind}/${release} (pins ${current.versions.join(', ')}; ${mine.length} lists): ${problems.length ? `PROBLEMS\n    ${problems.slice(0, 30).join('\n    ')}` : 'clean'}`);
  }
  console.log(bad ? `${bad} releases with problems` : 'all pinned production releases clean');
  if (bad) process.exitCode = 1;
}

async function names() {
  const [source, target] = await Promise.all([
    readOnly(staging, (tx) => tx<Array<{ kind: string; eid: string; name: string }>>`SELECT kind, eid, name FROM tenable_display_names WHERE locale = ${LOCALE} ORDER BY kind, eid`),
    readOnly(prod, (tx) => tx<Array<{ kind: string; eid: string; name: string }>>`SELECT kind, eid, name FROM tenable_display_names WHERE locale = ${LOCALE}`),
  ]);
  const stored = new Map(target.map((r) => [`${r.kind}:${r.eid}`, r.name]));
  const rows = source.filter((r) => !stored.has(`${r.kind}:${r.eid}`));
  const differs = source.filter((r) => stored.has(`${r.kind}:${r.eid}`) && stored.get(`${r.kind}:${r.eid}`) !== r.name);
  console.log({ staging: source.length, production: target.length, toInsert: rows.length, storedDifferently: differs.length });
  for (const r of differs.slice(0, 20)) console.log(`  kept on production: ${r.kind}:${r.eid} ${stored.get(`${r.kind}:${r.eid}`)} (staging: ${r.name})`);
  if (!WRITE || rows.length === 0) return;
  const written: Array<{ kind: string; eid: string }> = [];
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200).map((r) => ({ locale: LOCALE, kind: r.kind, eid: r.eid, name: r.name }));
    const done = await writeTx(prod, (tx) => tx<Array<{ kind: string; eid: string }>>`INSERT INTO tenable_display_names ${tx(chunk, 'locale', 'kind', 'eid', 'name')} ON CONFLICT (locale, kind, eid) DO NOTHING RETURNING kind, eid`);
    written.push(...done);
  }
  // Only the keys this run inserted: a rollback deletes exactly these.
  console.log(`inserted keys ${snapshot(`tenable-names-${LOCALE}-inserted`, written)}`);
  console.log(`inserted ${written.length} of ${rows.length}; replicas show them within five minutes`);
}

async function main() {
  banner(`Football Tenable ${mode}`, LOCALE);
  await ({ titles, aliases, pin, names, recheck } as Record<string, () => Promise<void>>)[mode]();
}
main().catch((e) => { console.error(`ABORT: ${(e as Error).message}`); process.exitCode = 1; }).finally(() => Promise.all([prod.end(), staging.end()]));
