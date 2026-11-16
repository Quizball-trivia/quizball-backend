/**
 * Football Tenable / Darts 501 in Greek for PRODUCTION, from staging: the steps tenable-locale-from-staging.ts runs for
 * --locale=el (the Greek names are a name set and release pins, like Russian, not an alias set).
 *
 *   aliases  the immutable Greek name set (tenable_el_name_sets / tenable_el_names, scripts/tenable-el-seed.ts names):
 *            the same version id, fingerprint and rows as staging, inserted in one transaction if production does not
 *            have it. An existing set with the same id must be identical, or the script stops.
 *   pin      tenable_el_releases rows for the PRODUCTION releases Tenable or Darts 501 plays there, to the same versions
 *            staging pinned (--players=<word-game el version>, the name set). Each release is checked on production data
 *            as tenable-el-seed.ts pin does (every entity named in Greek, every Tenable list playable in Greek); a release
 *            staging uses but did not pin is not pinned either. The word-game el version must already be on production
 *            (it is copied with the word games' Greek names). Then RESTART the backend: pins are read once per process.
 *   recheck  read only: every Greek-pinned production release as the server builds it (still covered, lists playable).
 */
import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import { opt, readOnly, sample, WRITE, writeTx } from './locale-copy-common.js';
import { listProblems, tenableListSchema, type TenableList } from '../src/modules/tenable/tenable.content.js';
import { buildDirectory, type EntityKind, type TenableEntity } from '../src/modules/tenable/tenable.identify.js';
import { greekRows } from '../src/modules/tenable/tenable.greek.js';
import { TENABLE_CONTENT_LOCK } from '../src/modules/tenable/tenable.seed.js';

type NameRow = { kind: string; eid: string; name_el: string; known_el: string; aliases_el: string[]; qualifier_el: string | null };
type NameSet = { version: string; fingerprint: string; entities: number };

/** tenable-el-seed.ts' fingerprint: [kind, eid, name, known, aliases, qualifier] sorted by kind + eid. */
const fingerprintOf = (rows: readonly NameRow[]) => createHash('sha256')
  .update(JSON.stringify([...rows].sort((a, b) => (a.kind + a.eid < b.kind + b.eid ? -1 : 1)).map((r) => [r.kind, r.eid, r.name_el, r.known_el, r.aliases_el, r.qualifier_el])))
  .digest('hex').slice(0, 32);

async function tablesThere(sql: postgres.Sql): Promise<boolean> {
  const [row] = await readOnly(sql, (tx) => tx<Array<{ t: string | null }>>`SELECT to_regclass('public.tenable_el_releases')::text AS t`);
  return row.t !== null;
}

async function readSet(sql: postgres.Sql, version: string): Promise<{ set: NameSet | null; rows: NameRow[] }> {
  return readOnly(sql, async (tx) => {
    const [set] = await tx<NameSet[]>`SELECT version, fingerprint, entities FROM tenable_el_name_sets WHERE version = ${version}`;
    const rows = set ? await tx<NameRow[]>`SELECT kind, eid, name_el, known_el, aliases_el, qualifier_el FROM tenable_el_names WHERE version = ${version} ORDER BY kind, eid` : [];
    return { set: set ?? null, rows };
  });
}

/** --version, or the only Greek name set staging has; checked against its own count and fingerprint. */
async function stagingSet(staging: postgres.Sql): Promise<{ set: NameSet; rows: NameRow[] }> {
  if (!(await tablesThere(staging))) throw new Error('staging has no Greek Tenable tables yet');
  let version = opt('version');
  if (!version) {
    const sets = await readOnly(staging, (tx) => tx<Array<{ version: string }>>`SELECT version FROM tenable_el_name_sets ORDER BY created_at`);
    if (sets.length !== 1) throw new Error(`staging has ${sets.length} Greek name sets (${sets.map((s) => s.version).join(', ')}): pass --version=<set>`);
    version = sets[0].version;
  }
  const { set, rows } = await readSet(staging, version);
  if (!set) throw new Error(`staging has no Greek name set ${version}`);
  if (rows.length !== set.entities || fingerprintOf(rows) !== set.fingerprint) throw new Error(`staging set ${version} does not match its own fingerprint/count (${rows.length} rows, ${set.entities} recorded)`);
  return { set, rows };
}

export async function greekNameSet(prod: postgres.Sql, staging: postgres.Sql): Promise<void> {
  const { set, rows } = await stagingSet(staging);
  console.log(`staging Greek name set ${set.version}: ${rows.length} entities, ${rows.reduce((n, r) => n + r.aliases_el.length, 0)} aliases, fingerprint ${set.fingerprint.slice(0, 12)}…`);
  if (!(await tablesThere(prod))) throw new Error('production has no Greek Tenable tables yet: deploy the migration first');
  const onProd = await readSet(prod, set.version);
  if (onProd.set) {
    if (onProd.set.fingerprint !== set.fingerprint || fingerprintOf(onProd.rows) !== set.fingerprint) throw new Error(`production already has a set ${set.version} that differs from staging's: stop and look`);
    console.log('production already has this set, identical: nothing to write. Next: pin');
    return;
  }
  console.log(`production does not have ${set.version}: ${WRITE ? 'inserting' : 'would insert'} the set row and ${rows.length} name rows in one transaction`);
  if (!WRITE) return;
  await writeTx(prod, async (tx) => {
    await tx`INSERT INTO tenable_el_name_sets (version, fingerprint, entities) VALUES (${set.version}, ${set.fingerprint}, ${set.entities})`;
    // One statement for every row; the trigger accepts them because the set was created in this same transaction.
    await tx`INSERT INTO tenable_el_names (version, kind, eid, name_el, known_el, aliases_el, qualifier_el)
      SELECT ${set.version}, x.kind, x.eid, x.name_el, x.known_el, x.aliases_el, x.qualifier_el
      FROM jsonb_to_recordset(${tx.json(rows as never)}::jsonb) AS x(kind text, eid text, name_el text, known_el text, aliases_el text[], qualifier_el text)`;
  });
  const check = await readSet(prod, set.version);
  console.log(`written: ${check.rows.length} rows, fingerprint ${fingerprintOf(check.rows) === set.fingerprint ? 'matches' : 'DOES NOT MATCH — investigate before pinning'}. Next: pin --players=<word-game el version>`);
}

/** Every release in play: Tenable lists (days, pool, live matches) and Darts 501 categories (player releases). */
async function inPlay(sql: postgres.Sql): Promise<{ lists: TenableList[]; releases: Array<{ kind: EntityKind; release: string }> }> {
  const raw = await readOnly(sql, (tx) => tx<Array<{ list: unknown }>>`
    SELECT list FROM tenable_days UNION ALL SELECT payload FROM room_pool WHERE game = 'tenable'
    UNION ALL SELECT l FROM room_matches m JOIN room_match_content c ON c.match_id = m.id CROSS JOIN jsonb_array_elements(c.content->'lists') l
    WHERE m.game = 'tenable' AND m.status IN ('ready', 'active')`);
  // Every copy of a list (a day and the pool may hold the same id): all of them are checked and fingerprinted.
  const lists = raw.flatMap((r) => { const p = tenableListSchema.safeParse(r.list); return p.success ? [p.data] : []; });
  const darts = await readOnly(sql, (tx) => tx<Array<{ release: string | null }>>`
    SELECT category->>'release' AS release FROM darts501_days
    UNION SELECT payload->>'release' FROM room_pool WHERE game = 'darts501'
    UNION SELECT l->>'release' FROM room_matches m JOIN room_match_content c ON c.match_id = m.id CROSS JOIN jsonb_array_elements(c.content->'legs') l
    WHERE m.game = 'darts501' AND m.status IN ('ready', 'active')`);
  const releases = new Map(lists.map((l) => [`${l.kind}/${l.release}`, { kind: l.kind, release: l.release }]));
  for (const d of darts) if (d.release) releases.set(`player/${d.release}`, { kind: 'player', release: d.release });
  return { lists, releases: [...releases.values()].sort((a, b) => `${a.kind}/${a.release}`.localeCompare(`${b.kind}/${b.release}`)) };
}

/** The lists in play on `releases` (id + hash of the whole list) and the versions, as one hash. */
function playFingerprint(play: { lists: readonly TenableList[] }, releases: ReadonlyArray<{ kind: EntityKind; release: string }>, players: string, names: string): string {
  const wanted = new Set(releases.map((r) => `${r.kind}/${r.release}`));
  const lists = play.lists.filter((l) => wanted.has(`${l.kind}/${l.release}`))
    .map((l) => `${l.id}:${createHash('sha256').update(JSON.stringify(l)).digest('hex')}`);
  const distinct = [...new Set(lists)].sort();
  return createHash('sha256').update(JSON.stringify([players, names, [...wanted].sort(), distinct])).digest('hex');
}

async function latinRows(sql: postgres.Sql, kind: EntityKind, release: string): Promise<TenableEntity[]> {
  const out: TenableEntity[] = [];
  for (let after = ''; ;) {
    const from = after;
    const page = await readOnly(sql, (tx) => (kind === 'player'
      ? tx<TenableEntity[]>`SELECT p.pid AS eid, p.name, p.game_name AS known, p.fame, p.aliases, m.qualifier
          FROM wordgame_players p LEFT JOIN tenable_player_meta m ON m.release_id = p.release_id AND m.pid = p.pid
          WHERE p.release_id = ${release} AND p.pid > ${from} ORDER BY p.pid LIMIT 10000`
      : tx<TenableEntity[]>`SELECT eid, name, known, fame, aliases, qualifier FROM tenable_entities
          WHERE release_id = ${release} AND kind = ${kind} AND eid > ${from} ORDER BY eid LIMIT 10000`));
    out.push(...page);
    if (page.length < 10_000) return out;
    after = page[page.length - 1].eid;
  }
}

/** Problems of a release under a (proposed) pin on this database: coverage, then every list in Greek. */
async function judgeGreek(sql: postgres.Sql, kind: EntityKind, release: string, lists: readonly TenableList[], pin: { players_version: string | null; names_version: string | null }): Promise<string[]> {
  const latin = await latinRows(sql, kind, release);
  if (latin.length === 0) return ['no entities for this release here'];
  const greek = await greekRows(sql, kind, release, latin, pin);
  if (!greek) return [`the Greek names do not cover all ${latin.length} entities`];
  const directory = buildDirectory(kind, release, greek, 'greek');
  return lists.filter((l) => l.kind === kind && l.release === release).flatMap((l) => listProblems(l, directory).map((p) => `${l.id}: ${p}`));
}

export async function greekPins(prod: postgres.Sql, staging: postgres.Sql): Promise<void> {
  const players = opt('players');
  if (!players) throw new Error('pin --locale=el needs --players=<word-game el version> (the version staging pinned player releases to)');
  const { set } = await stagingSet(staging);
  if (!(await tablesThere(prod))) throw new Error('production has no Greek Tenable tables yet: deploy the migration first');
  const [have] = await readOnly(prod, (tx) => tx<Array<{ players: boolean; names: boolean }>>`
    SELECT EXISTS (SELECT 1 FROM wordgame_el_versions WHERE version = ${players}) AS players, EXISTS (SELECT 1 FROM tenable_el_name_sets WHERE version = ${set.version}) AS names`);
  const lacking = [!have.players && `word-game el version ${players}`, !have.names && `name set ${set.version} (run aliases --locale=el --write)`].filter(Boolean);
  if (lacking.length) throw new Error(`production lacks ${lacking.join(' and ')}: copy them first`);
  const [prodPlay, stagingPlay, stagingPins, prodPins] = await Promise.all([
    inPlay(prod),
    inPlay(staging),
    readOnly(staging, (tx) => tx<Array<{ kind: string; release_id: string; players_version: string | null; names_version: string | null }>>`SELECT kind, release_id, players_version, names_version FROM tenable_el_releases`),
    readOnly(prod, (tx) => tx<Array<{ kind: string; release_id: string }>>`SELECT kind, release_id FROM tenable_el_releases`),
  ]);
  const key = (kind: string, release: string) => `${kind}/${release}`;
  const onStaging = new Map(stagingPins.map((p) => [key(p.kind, p.release_id), p]));
  const stagingInUse = new Set(stagingPlay.releases.map((r) => key(r.kind, r.release)));
  const pinnedHere = new Set(prodPins.map((p) => key(p.kind, p.release_id)));
  const ready: Array<{ kind: EntityKind; release: string }> = [];
  for (const r of prodPlay.releases) {
    const k = key(r.kind, r.release);
    if (pinnedHere.has(k)) { console.log(`  ${k}: already pinned on production`); continue; }
    const proposed = r.kind === 'player' ? { players_version: players, names_version: null } : { players_version: null, names_version: set.version };
    const staged = onStaging.get(k);
    if (stagingInUse.has(k) && !staged) { console.log(`  ${k}: NOT pinned — staging uses this release but did not pin it`); continue; }
    if (staged && (staged.players_version !== proposed.players_version || staged.names_version !== proposed.names_version)) {
      console.log(`  ${k}: NOT pinned — staging pinned it to ${staged.players_version ?? staged.names_version}, not ${proposed.players_version ?? proposed.names_version}`);
      continue;
    }
    const problems = await judgeGreek(prod, r.kind, r.release, prodPlay.lists, proposed);
    if (problems.length) { console.log(`  ${k}: NOT pinned\n    ${problems.slice(0, 20).join('\n    ')}`); continue; }
    ready.push(r);
    console.log(`  ${k}: ${WRITE ? 'PIN' : 'would pin'} — every entity named in Greek, every list playable in Greek${staged ? ' (pinned on staging too)' : ' (release not used on staging)'}`);
  }
  // What was validated: the lists in play on these releases (id + content hash) and the versions they were checked with.
  const validated = playFingerprint(prodPlay, ready, players, set.version);
  console.log(`\n${ready.length} pins ${WRITE ? 'to write' : 'would be written'}${sample(ready.map((r) => key(r.kind, r.release)), 20)}`);
  if (!WRITE || ready.length === 0) return;
  await writeTx(prod, async (tx) => {
    // The content seed's lock: no list is published, and no other pin lands, between this check and the immutable pins.
    await tx`SELECT pg_advisory_xact_lock(hashtext(${TENABLE_CONTENT_LOCK}))`;
    await tx`LOCK TABLE tenable_el_releases IN SHARE ROW EXCLUSIVE MODE`;
    const now = await tx<Array<{ k: string }>>`SELECT kind || '/' || release_id AS k FROM tenable_el_releases`;
    if (now.some((p) => ready.some((r) => key(r.kind, r.release) === p.k))) throw new Error('a release was pinned during the check; run pin again');
    // The full Greek check ran before this transaction; here only a cheap re-read that nothing it judged has changed
    // (short statements: the production role ends a transaction idle for 15 s).
    const [versions] = await tx<Array<{ players: boolean; names: boolean }>>`
      SELECT EXISTS (SELECT 1 FROM wordgame_el_versions WHERE version = ${players}) AS players, EXISTS (SELECT 1 FROM tenable_el_name_sets WHERE version = ${set.version}) AS names`;
    if (!versions.players || !versions.names) throw new Error('a Greek version checked before is gone; run pin again');
    if (playFingerprint(await inPlay(tx), ready, players, set.version) !== validated) {
      throw new Error('the lists in play on these releases changed since the check (a list was published, corrected or dealt); run pin again');
    }
    await tx`INSERT INTO tenable_el_releases (kind, release_id, players_version, names_version)
      SELECT x.kind, x.release, x.players_version, x.names_version
      FROM jsonb_to_recordset(${tx.json(ready.map((r) => ({ kind: r.kind, release: r.release, players_version: r.kind === 'player' ? players : null, names_version: r.kind === 'player' ? null : set.version })) as never)}::jsonb)
        AS x(kind text, release text, players_version text, names_version text)`;
  });
  console.log(`Pinned ${ready.length}. RESTART the production backend so every replica loads them (pins are read once per process).`);
}

export async function greekRecheck(prod: postgres.Sql): Promise<void> {
  if (!(await tablesThere(prod))) { console.log('production has no Greek Tenable tables yet: nothing to recheck'); return; }
  const { lists } = await inPlay(prod);
  const pins = await readOnly(prod, (tx) => tx<Array<{ kind: EntityKind; release_id: string; players_version: string | null; names_version: string | null }>>`SELECT kind, release_id, players_version, names_version FROM tenable_el_releases ORDER BY kind, release_id`);
  let bad = 0;
  for (const p of pins) {
    const problems = await judgeGreek(prod, p.kind, p.release_id, lists, p);
    if (problems.length) bad += 1;
    console.log(`  Greek ${p.kind}/${p.release_id} (${p.players_version ?? p.names_version}): ${problems.length ? `PROBLEMS\n    ${problems.slice(0, 30).join('\n    ')}` : 'clean'}`);
  }
  console.log(bad ? `${bad} Greek-pinned releases with problems` : 'all Greek-pinned production releases clean');
  if (bad) process.exitCode = 1;
}
