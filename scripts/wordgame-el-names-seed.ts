#!/usr/bin/env npx tsx

// One version of the word games' Greek names (wordgame_el_versions / wordgame_el_names), from the translation artifact
// scripts/.snapshots/wordgame-names-el.json ("<name>|<game_name>" -> { full, short, alt[] }). Staging only. Mirrors
// scripts/wordgame-ru-names-seed.ts, plus up to four Greek alternative spellings per footballer (aliases_el).
//   npx tsx scripts/wordgame-el-names-seed.ts [--env-file=.env]                    # build + coverage report, nothing written
//   npx tsx scripts/wordgame-el-names-seed.ts --write [--env-file=.env]            # writes the version, inactive
//   npx tsx scripts/wordgame-el-names-seed.ts --activate=<version> [--env-file=.env]  # switches it on for new runs and rooms
// Corrections keyed like the artifact are read from scripts/.snapshots/wordgame-names-el-fixes.json when present (--fixes=<path>).
// A version covers every footballer of every word-game release (the newest release's name and fame for each id). It is
// refused unless every accepted answer of every daily and room pair, every Name Chain start candidate (fame >= 40) and at
// least 99% of each release can be named in Greek. Activate only after every replica runs code that reads it.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';
import { normalizeNameGreek } from '../src/modules/footballers/footballers.text.js';
import { START_MIN_FAME } from '../src/modules/room/games/name-chain/name-chain.core.js';
import { POOLER_SAFE, requireStagingTarget } from './staging-target.js';

const ARTIFACT = path.resolve('scripts/.snapshots/wordgame-names-el.json');
const FIXES = 'scripts/.snapshots/wordgame-names-el-fixes.json';
const MAX_ALIASES = 4;
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
requireStagingTarget(dbUrl);
const sql = postgres(dbUrl, { ...POOLER_SAFE, ssl: 'require', max: 1, connect_timeout: 20, idle_timeout: 30, onnotice: () => undefined });

type Entry = { full: string; short: string; alt?: string[] };
type Row = { pid: string; name_el: string; game_name_el: string; aliases_el: string[]; fame: number };
const usable = (t: string | undefined): t is string => !!t && t.length <= 80 && /[α-ω]/.test(normalizeNameGreek(t)) && !/\p{Script=Latin}|\p{Script=Cyrillic}/u.test(t);

/** Alternative spellings that read differently from the full and the known name, at most MAX_ALIASES. */
function aliasesOf(entry: Entry, full: string, short: string): string[] {
  const seen = new Set([normalizeNameGreek(full), normalizeNameGreek(short)]);
  const out: string[] = [];
  for (const raw of entry.alt ?? []) {
    const alt = raw.normalize('NFC').trim();
    const key = normalizeNameGreek(alt);
    if (!usable(alt) || seen.has(key) || out.length >= MAX_ALIASES) continue;
    seen.add(key);
    out.push(alt);
  }
  return out;
}

async function build(): Promise<{ version: string; fingerprint: string; rows: Row[] }> {
  if (!existsSync(ARTIFACT)) throw new Error(`Missing ${ARTIFACT}`);
  const names = JSON.parse(readFileSync(ARTIFACT, 'utf8')) as Record<string, Entry>;
  // Reviewed corrections (same keys) win over the artifact: entries it lacks or wrote with letters of another script.
  const fixesPath = path.resolve(opt('fixes') ?? FIXES);
  if (existsSync(fixesPath)) {
    const fixes = JSON.parse(readFileSync(fixesPath, 'utf8')) as Record<string, Entry>;
    Object.assign(names, fixes);
    console.log(`${Object.keys(fixes).length} corrections from ${path.relative(process.cwd(), fixesPath)}`);
  }
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
    if (entry && usable(full) && usable(short)) rows.push({ pid: p.pid, name_el: full, game_name_el: short, aliases_el: aliasesOf(entry, full, short), fame: p.fame });
  }
  const covered = new Set(rows.map((r) => r.pid));
  const problems: string[] = [];
  const byRelease = new Map<string, { all: number; el: number }>();
  const starters = new Set<string>();
  for (const r of releases) {
    const c = byRelease.get(r.release_id) ?? { all: 0, el: 0 };
    c.all += 1; if (covered.has(r.pid)) c.el += 1;
    byRelease.set(r.release_id, c);
    if (r.fame >= START_MIN_FAME) starters.add(r.pid);
  }
  for (const [release, c] of byRelease) {
    const share = c.el / c.all;
    console.log(`release ${release}: ${c.el}/${c.all} footballers have a Greek name (${(share * 100).toFixed(2)}%)`);
    if (share < MIN_RELEASE_COVERAGE) problems.push(`release ${release} below ${MIN_RELEASE_COVERAGE * 100}%`);
  }
  const acceptedMissing = accepted.filter((a) => !covered.has(a.pid)).map((a) => a.pid);
  const startersMissing = [...starters].filter((pid) => !covered.has(pid));
  console.log(`accepted answers of daily and room pairs: ${accepted.length - acceptedMissing.length}/${accepted.length}; Name Chain starters: ${starters.size - startersMissing.length}/${starters.size}`);
  if (acceptedMissing.length) problems.push(`${acceptedMissing.length} accepted answers without a Greek name (ids: ${acceptedMissing.slice(0, 10).join(', ')})`);
  if (startersMissing.length) problems.push(`${startersMissing.length} Name Chain starters without a Greek name (ids: ${startersMissing.slice(0, 10).join(', ')})`);
  console.log(`Greek alternative spellings: ${rows.reduce((n, r) => n + r.aliases_el.length, 0)} on ${rows.filter((r) => r.aliases_el.length).length} footballers`);
  if (problems.length) throw new Error(`Coverage refused:\n- ${problems.join('\n- ')}\nTranslate the rest and run again.`);
  const canonical = [...rows].sort((a, b) => (a.pid < b.pid ? -1 : 1)).map((r) => [r.pid, r.name_el, r.game_name_el, r.aliases_el, r.fame]);
  const fingerprint = createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 32);
  return { version: `el-${new Date().toISOString().slice(0, 10)}-${fingerprint.slice(0, 8)}`, fingerprint, rows };
}

async function write(): Promise<void> {
  const { version, fingerprint, rows } = await build();
  console.log(`version ${version}: ${rows.length} Greek names`);
  if (!has('write')) { console.log('Dry run: nothing written (add --write).'); return; }
  await sql.begin(async (tx) => {
    await tx`SET LOCAL statement_timeout = '120s'`;
    const [existing] = await tx<Array<{ fingerprint: string }>>`SELECT fingerprint FROM wordgame_el_versions WHERE version = ${version}`;
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error(`Version ${version} exists with different content`);
      console.log('Already there with the same content; nothing to do.');
      return;
    }
    await tx`INSERT INTO wordgame_el_versions (version, fingerprint, players) VALUES (${version}, ${fingerprint}, ${rows.length})`;
    for (let i = 0; i < rows.length; i += 2_000) {
      await tx`INSERT INTO wordgame_el_names ${tx(rows.slice(i, i + 2_000).map((r) => ({ version, ...r })), 'version', 'pid', 'name_el', 'game_name_el', 'aliases_el', 'fame')}`;
    }
    console.log(`Written: ${version} (inactive). Switch it on with --activate=${version} once every replica runs the reading code.`);
  });
}

async function activate(version: string): Promise<void> {
  await sql.begin(async (tx) => {
    const [row] = await tx<Array<{ version: string }>>`SELECT version FROM wordgame_el_versions WHERE version = ${version}`;
    if (!row) throw new Error(`No version ${version}`);
    await tx`UPDATE wordgame_el_versions SET active = false WHERE active AND version <> ${version}`;
    await tx`UPDATE wordgame_el_versions SET active = true WHERE version = ${version}`;
  });
  console.log(`Active: ${version}. New runs and rooms freeze it within a minute (replicas re-read the active version every 60 s).`);
}

const target = opt('activate');
(target ? activate(target) : write()).catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; }).finally(() => sql.end());
