#!/usr/bin/env npx tsx

// One version of the word games' Greek names (wordgame_el_versions / wordgame_el_names), from the translation artifact
// scripts/.snapshots/wordgame-names-el.json ("<name>|<game_name>" -> { full, short, alt[] }). Staging only. Mirrors
// scripts/wordgame-ru-names-seed.ts, plus up to four Greek alternative spellings per footballer (aliases_el).
//   npx tsx scripts/wordgame-el-names-seed.ts [--env-file=.env]                    # build + coverage report, nothing written
//   npx tsx scripts/wordgame-el-names-seed.ts --write [--env-file=.env]            # writes the version, inactive
//   npx tsx scripts/wordgame-el-names-seed.ts --activate=<version> [--env-file=.env]  # switches it on for new runs and rooms
// Corrections keyed like the artifact are read from scripts/.snapshots/wordgame-names-el-fixes.json when present (--fixes=<path>).
// Greek short forms: the last words of the Greek name where a Latin alias is the last words of the Latin one, then the
// Greek forms of the footballer's own Latin multi-word aliases from scripts/.snapshots/wordgame-names-el-latin-aliases-by-pid.json
// (--latin-aliases=<path>), minus any that is another footballer's Greek name or known name.
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
// Greek forms of the footballers' Latin multi-word aliases by footballer id: { pid: { latinAlias: greekAlias | "" } }.
const LATIN_ALIASES = 'scripts/.snapshots/wordgame-names-el-latin-aliases-by-pid.json';
const MAX_ALIASES = 4;
const MIN_RELEASE_COVERAGE = 0.99;
const PAGE = 10_000;

/** A dropped pooler connection (or one ended idle in its read on a loaded machine) is retried; reads only. */
async function withRetry<T>(read: () => Promise<T>, tries = 4): Promise<T> {
  for (let i = 1; ; i += 1) {
    try { return await read(); } catch (error) { if (i >= tries || !/CONNECTION_CLOSED|ECONNRESET|idle-in-transaction/.test(String(error))) throw error; }
  }
}
const opt = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const has = (name: string) => process.argv.includes(`--${name}`);
const dbUrl = readFileSync(opt('env-file') ?? '.env', 'utf8').match(/^DATABASE_URL\s*=\s*"?([^"\n]+)"?/m)?.[1] ?? '';
requireStagingTarget(dbUrl);
const sql = postgres(dbUrl, { ...POOLER_SAFE, ssl: 'require', max: 1, connect_timeout: 20, idle_timeout: 30, onnotice: () => undefined });
type Sql = typeof sql;
// postgres.js types TransactionSql via Omit<>, which loses the tagged-template call signature; at runtime it is one.
const txSql = (tx: postgres.TransactionSql): Sql => tx as unknown as Sql;

type Entry = { full: string; short: string; alt?: string[] };
type Row = { pid: string; name_el: string; game_name_el: string; aliases_el: string[]; fame: number };
const usable = (t: string | undefined): t is string => !!t && t.length <= 80 && /[α-ω]/.test(normalizeNameGreek(t)) && !/\p{Script=Latin}|\p{Script=Cyrillic}/u.test(t);

/**
 * Greek short forms of the Latin ones: a Latin alias that is the last words of the Latin name ("Boa Morte" of
 * "Luís Boa Morte") gives the same last words of the Greek name, when both names have as many words.
 */
function suffixAliases(latinName: string, latinAliases: readonly string[], greekFull: string): string[] {
  const latin = latinName.trim().split(/\s+/);
  const greek = greekFull.trim().split(/\s+/);
  if (latin.length !== greek.length || latin.length < 3) return [];
  const fold = (t: string) => t.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const out: string[] = [];
  for (const alias of latinAliases) {
    const words = alias.trim().split(/\s+/);
    // Two words or more, fewer than the name: the one-word surname is the known name already.
    if (words.length < 2 || words.length >= latin.length) continue;
    if (fold(latin.slice(-words.length).join(' ')) !== fold(words.join(' '))) continue;
    out.push(greek.slice(-words.length).join(' '));
  }
  return out;
}

/** Greek short forms first, then alternative spellings, that read differently from the full and the known name, at most MAX_ALIASES. */
function aliasesOf(entry: Entry, full: string, short: string, derived: readonly string[] = []): string[] {
  const seen = new Set([normalizeNameGreek(full), normalizeNameGreek(short)]);
  const out: string[] = [];
  for (const raw of [...derived, ...(entry.alt ?? [])]) {
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
  const latinAliasesPath = path.resolve(opt('latin-aliases') ?? LATIN_ALIASES);
  // A path given on purpose must exist: the collision registry reads it.
  if (opt('latin-aliases') && !existsSync(latinAliasesPath)) throw new Error(`Missing ${latinAliasesPath}`);
  const fromLatin = existsSync(latinAliasesPath) ? (JSON.parse(readFileSync(latinAliasesPath, 'utf8')) as Record<string, Record<string, string>>) : {};
  // Only the Greek forms of this footballer's own Latin aliases (namesakes share a name, never an id).
  const greekOfLatin = (pid: string, aliases: readonly string[]): string[] => aliases.flatMap((a) => (fromLatin[pid]?.[a] ? [fromLatin[pid][a]] : []));
  console.log(`${Object.keys(fromLatin).length} footballers with Greek forms of their Latin aliases`);
  // Read in pages (like the app's footballers repo): one large result through the pooler drops the connection.
  const releases: Array<{ release_id: string; pid: string; name: string; game_name: string; aliases: string[] | null; fame: number; created_at: string }> = [];
  for (let after = { r: '', p: '' }; ;) {
    const from = after;
    const page = await withRetry(() => sql.begin('read only', (tx) => txSql(tx)<typeof releases>`
      SELECT w.release_id, w.pid, w.name, w.game_name, w.aliases, w.fame, r.created_at::text AS created_at
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
  const accepted = await withRetry(() => sql.begin('read only', (tx) => txSql(tx)<Array<{ pid: string }>>`
    SELECT DISTINCT pid FROM (
      SELECT jsonb_array_elements_text(pair->'accepted') AS pid FROM shared_player_days d, jsonb_array_elements(d.pairs->'pairs') pair
      UNION ALL
      SELECT jsonb_array_elements_text(payload->'accepted') FROM room_pool WHERE game = 'shared_player' AND enabled
    ) a`));
  // A Latin alias that is another footballer's Latin name, or that several footballers carry, cannot say whose it is
  // (often an alias copied onto a namesake): it gives no Greek form to anyone.
  const foldLatin = (t: string) => t.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
  const latinOwners = new Map<string, Set<string>>();
  for (const p of players) for (const t of [p.name, ...(p.aliases ?? [])]) {
    const key = foldLatin(t);
    latinOwners.set(key, (latinOwners.get(key) ?? new Set()).add(p.pid));
  }
  const ownAliases = (pid: string, aliases: readonly string[]) => aliases.filter((a) => !/["“”]/.test(a) && [...(latinOwners.get(foldLatin(a)) ?? [])].every((owner) => owner === pid));
  // Every Greek form any Latin alias would give, kept or not: a form two footballers' aliases give is nobody's.
  // Only forms cut from the footballer's own Greek name are given: a translated alias cannot be told from one the
  // Latin content copied off a namesake (Sir Alex Ferguson, Júlio César), even when it extends the own name.
  const formsOf = (p: (typeof players)[number], full: string, aliases: readonly string[]) => suffixAliases(p.name, aliases, full);
  const everyForm = new Map<string, string[]>();
  const rows: Row[] = [];
  for (const p of players) {
    const entry = names[`${p.name}|${p.game_name}`];
    const full = entry?.full.normalize('NFC');
    const short = entry?.short.normalize('NFC');
    if (!entry || !usable(full) || !usable(short)) continue;
    everyForm.set(p.pid, [...suffixAliases(p.name, p.aliases ?? [], full), ...greekOfLatin(p.pid, p.aliases ?? [])]);
    rows.push({ pid: p.pid, name_el: full, game_name_el: short, aliases_el: aliasesOf(entry, full, short, formsOf(p, full, ownAliases(p.pid, p.aliases ?? []))), fame: p.fame });
  }
  // A short form that is another footballer's Greek name, known name or short form (two Latin spellings can read the
  // same in Greek) would name more than one footballer only in Greek: dropped for everyone.
  const nameOwners = new Map<string, Set<string>>();
  for (const r of rows) for (const n of [r.name_el, r.game_name_el, ...r.aliases_el, ...(everyForm.get(r.pid) ?? []).filter(usable)]) {
    const key = normalizeNameGreek(n);
    nameOwners.set(key, (nameOwners.get(key) ?? new Set()).add(r.pid));
  }
  let dropped = 0;
  for (const r of rows) {
    const kept = r.aliases_el.filter((a) => [...(nameOwners.get(normalizeNameGreek(a)) ?? [])].every((pid) => pid === r.pid));
    dropped += r.aliases_el.length - kept.length;
    r.aliases_el = kept;
  }
  console.log(`${dropped} Greek short forms dropped: another footballer's Greek name, known name or short form`);
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
  await sql.begin(async (transaction) => {
    const tx = txSql(transaction);
    await tx`SET LOCAL statement_timeout = '120s'`;
    // Building each 2,000-row insert can outlast the role's idle-in-transaction limit on a busy machine.
    await tx`SET LOCAL idle_in_transaction_session_timeout = '120s'`;
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
  await sql.begin(async (transaction) => {
    const tx = txSql(transaction);
    const [row] = await tx<Array<{ version: string }>>`SELECT version FROM wordgame_el_versions WHERE version = ${version}`;
    if (!row) throw new Error(`No version ${version}`);
    await tx`UPDATE wordgame_el_versions SET active = false WHERE active AND version <> ${version}`;
    await tx`UPDATE wordgame_el_versions SET active = true WHERE version = ${version}`;
  });
  console.log(`Active: ${version}. New runs and rooms freeze it within a minute (replicas re-read the active version every 60 s).`);
}

const target = opt('activate');
(target ? activate(target) : write()).catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; }).finally(() => sql.end());
