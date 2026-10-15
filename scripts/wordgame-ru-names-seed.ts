#!/usr/bin/env npx tsx

// One version of the word games' Russian names (wordgame_ru_versions / wordgame_ru_names), from the translation artifact
// scripts/.snapshots/wordgame-names-ru.json (scripts/wordgame-names-ru.ts). Staging only.
//   npx tsx scripts/wordgame-ru-names-seed.ts [--env-file=.env]                    # build + coverage report, nothing written
//   npx tsx scripts/wordgame-ru-names-seed.ts --write [--env-file=.env]            # writes the version, inactive
//   npx tsx scripts/wordgame-ru-names-seed.ts --activate=<version> [--env-file=.env]  # switches it on for new runs and rooms
// A version covers every footballer of every word-game release (the newest release's name and fame for each id). It is
// refused unless every accepted answer of every daily and room pair, every Name Chain start candidate (fame >= 40) and at
// least 99% of each release can be named in Russian. Activate only after every replica runs code that reads it.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';
import { normalizeNameCyrillic } from '../src/modules/footballers/footballers.text.js';
import { START_MIN_FAME } from '../src/modules/room/games/name-chain/name-chain.core.js';

const STAGING_REF = 'nsdfiprfmhdqhbfxfwpv';
const PROD_REF = 'lfbwhxvwubzeqkztghok';
const ARTIFACT = path.resolve('scripts/.snapshots/wordgame-names-ru.json');
const MIN_RELEASE_COVERAGE = 0.99;
const PAGE = 10_000;

/** A dropped pooler connection is retried (the next query reconnects); reads only. */
async function withRetry<T>(read: () => Promise<T>, tries = 4): Promise<T> {
  for (let i = 1; ; i += 1) {
    try { return await read(); } catch (error) { if (i >= tries || !/CONNECTION_CLOSED|ECONNRESET/.test(String(error))) throw error; }
  }
}
const opt = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const has = (name: string) => process.argv.includes(`--${name}`);
const dbUrl = readFileSync(opt('env-file') ?? '.env', 'utf8').match(/^DATABASE_URL\s*=\s*"?([^"\n]+)"?/m)?.[1] ?? '';
if (!dbUrl.includes(STAGING_REF) || dbUrl.includes(PROD_REF)) { console.error(`ABORT: DATABASE_URL must be the staging project ${STAGING_REF}`); process.exit(1); }
const sql = postgres(dbUrl, { ssl: 'require', max: 1, connect_timeout: 20, idle_timeout: 30, onnotice: () => undefined });

type Entry = { full: string; short: string };
type Row = { pid: string; name_ru: string; game_name_ru: string; fame: number };
const usable = (t: string | undefined): t is string => !!t && t.length <= 80 && /[а-я]/.test(normalizeNameCyrillic(t)) && !/\p{Script=Latin}/u.test(t);

async function build(): Promise<{ version: string; fingerprint: string; rows: Row[] }> {
  if (!existsSync(ARTIFACT)) throw new Error(`Missing ${ARTIFACT}: run scripts/wordgame-names-ru.ts first`);
  const names = JSON.parse(readFileSync(ARTIFACT, 'utf8')) as Record<string, Entry>;
  // Read in pages (like the app's footballers repo): one large result through the pooler drops the connection.
  const releases: Array<{ release_id: string; pid: string; name: string; game_name: string; fame: number; created_at: string }> = [];
  for (let after = { r: '', p: '' }; ;) {
    const from = after;
    const page = await withRetry(() => sql.begin('read only', (tx) => tx<typeof releases>`
      SELECT w.release_id, w.pid, w.name, w.game_name, w.fame, r.created_at::text AS created_at
        FROM wordgame_players w JOIN wordgame_releases r ON r.id = w.release_id
       WHERE (w.release_id, w.pid) > (${from.r}, ${from.p}) ORDER BY w.release_id, w.pid LIMIT ${PAGE}`));
    releases.push(...page);
    if (page.length < PAGE) break;
    after = { r: page[page.length - 1].release_id, p: page[page.length - 1].pid };
  }
  // The newest release's name and fame per footballer id.
  const newest = new Map<string, (typeof releases)[number]>();
  for (const r of releases) { const seen = newest.get(r.pid); if (!seen || r.created_at > seen.created_at) newest.set(r.pid, r); }
  const players = [...newest.values()];
  const accepted = await withRetry(() => sql.begin('read only', (tx) => tx<Array<{ pid: string }>>`
    SELECT DISTINCT pid FROM (
      SELECT jsonb_array_elements_text(pair->'accepted') AS pid FROM shared_player_days d, jsonb_array_elements(d.pairs->'pairs') pair
      UNION ALL
      SELECT jsonb_array_elements_text(payload->'accepted') FROM room_pool WHERE game = 'shared_player' AND enabled
    ) a`));
  const rows: Row[] = [];
  for (const p of players) {
    const entry = names[`${p.name}|${p.game_name}`];
    const full = entry?.full.normalize('NFC');
    const short = entry?.short.normalize('NFC');
    if (usable(full) && usable(short)) rows.push({ pid: p.pid, name_ru: full, game_name_ru: short, fame: p.fame });
  }
  const covered = new Set(rows.map((r) => r.pid));
  const problems: string[] = [];
  const byRelease = new Map<string, { all: number; ru: number }>();
  const starters = new Set<string>();
  for (const r of releases) {
    const c = byRelease.get(r.release_id) ?? { all: 0, ru: 0 };
    c.all += 1; if (covered.has(r.pid)) c.ru += 1;
    byRelease.set(r.release_id, c);
    if (r.fame >= START_MIN_FAME) starters.add(r.pid);
  }
  for (const [release, c] of byRelease) {
    const share = c.ru / c.all;
    console.log(`release ${release}: ${c.ru}/${c.all} footballers have a Russian name (${(share * 100).toFixed(2)}%)`);
    if (share < MIN_RELEASE_COVERAGE) problems.push(`release ${release} below ${MIN_RELEASE_COVERAGE * 100}%`);
  }
  const acceptedMissing = accepted.filter((a) => !covered.has(a.pid)).map((a) => a.pid);
  const startersMissing = [...starters].filter((pid) => !covered.has(pid));
  console.log(`accepted answers of daily and room pairs: ${accepted.length - acceptedMissing.length}/${accepted.length}; Name Chain starters: ${starters.size - startersMissing.length}/${starters.size}`);
  if (acceptedMissing.length) problems.push(`${acceptedMissing.length} accepted answers without a Russian name (ids: ${acceptedMissing.slice(0, 10).join(', ')})`);
  if (startersMissing.length) problems.push(`${startersMissing.length} Name Chain starters without a Russian name (ids: ${startersMissing.slice(0, 10).join(', ')})`);
  if (problems.length) throw new Error(`Coverage refused:\n- ${problems.join('\n- ')}\nTranslate the rest (scripts/wordgame-names-ru.ts) and run again.`);
  const canonical = [...rows].sort((a, b) => (a.pid < b.pid ? -1 : 1)).map((r) => [r.pid, r.name_ru, r.game_name_ru, r.fame]);
  const fingerprint = createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 32);
  return { version: `ru-${new Date().toISOString().slice(0, 10)}-${fingerprint.slice(0, 8)}`, fingerprint, rows };
}

async function write(): Promise<void> {
  const { version, fingerprint, rows } = await build();
  console.log(`version ${version}: ${rows.length} Russian names`);
  if (!has('write')) { console.log('Dry run: nothing written (add --write).'); return; }
  await sql.begin(async (tx) => {
    await tx`SET LOCAL statement_timeout = '120s'`;
    const [existing] = await tx<Array<{ fingerprint: string }>>`SELECT fingerprint FROM wordgame_ru_versions WHERE version = ${version}`;
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error(`Version ${version} exists with different content`);
      console.log('Already there with the same content; nothing to do.');
      return;
    }
    await tx`INSERT INTO wordgame_ru_versions (version, fingerprint, players) VALUES (${version}, ${fingerprint}, ${rows.length})`;
    for (let i = 0; i < rows.length; i += 2_000) {
      await tx`INSERT INTO wordgame_ru_names ${tx(rows.slice(i, i + 2_000).map((r) => ({ version, ...r })), 'version', 'pid', 'name_ru', 'game_name_ru', 'fame')}`;
    }
    console.log(`Written: ${version} (inactive). Switch it on with --activate=${version} once every replica runs the reading code.`);
  });
}

async function activate(version: string): Promise<void> {
  await sql.begin(async (tx) => {
    const [row] = await tx<Array<{ version: string }>>`SELECT version FROM wordgame_ru_versions WHERE version = ${version}`;
    if (!row) throw new Error(`No version ${version}`);
    await tx`UPDATE wordgame_ru_versions SET active = false WHERE active AND version <> ${version}`;
    await tx`UPDATE wordgame_ru_versions SET active = true WHERE version = ${version}`;
  });
  console.log(`Active: ${version}. New runs and rooms freeze it within a minute (replicas re-read the active version every 60 s).`);
}

const target = opt('activate');
(target ? activate(target) : write()).catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; }).finally(() => sql.end());
