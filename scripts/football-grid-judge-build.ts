/**
 * Builds one Football Grid judge version: the shared eligibility store every board is judged against.
 *
 *   npx tsx scripts/football-grid-judge-build.ts --target staging --label compat-20261118 --compat-only --report-dir <private dir>
 *   npx tsx scripts/football-grid-judge-build.ts --target staging --label facts-v1-20261118 --facts <private facts dir> --wordgame-ka --report-dir <dir>
 *   npx tsx scripts/football-grid-judge-build.ts --target staging --activate facts-v1-20261118
 *
 * Sources: (a) compatibility — every reviewed membership and alias of the published releases, each release criterion
 * bound to a shared definition only when it provably means the same thing (football-grid-judge-builder.ts);
 * (b) curated facts (--facts: facts.jsonl, players.jsonl, identity.jsonl, manifest.json — private files, never in
 * this repository). The version is written while 'building', certified board by board, then sealed 'ready'.
 * Activation is a separate step. Nothing here contains or prints quiz content beyond counts.
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import postgres from 'postgres';
import { resolvePistasSeedTarget, SEED_TARGETS, type PistasSeedTarget } from '../src/modules/pistas/pistas.seed.js';
import { nameSuffixForms, normalizeFootballGridAnswer } from '../src/modules/football-grid/football-grid.answer-resolver.js';
import {
  certifyBoard,
  decideBindings,
  orderCell,
  factId,
  routeFact,
  type BindingOverride,
  type CriterionRow,
  type DefinitionSpec,
  type FactRecord,
} from '../src/modules/football-grid/football-grid-judge-builder.js';

export interface Args {
  target?: PistasSeedTarget;
  label?: string;
  activate?: string;
  discard?: string;
  facts?: string;
  compatOnly: boolean;
  wordgameKa: boolean;
  reportDir?: string;
  bindingOverrides?: string;
  /** Fact origins whose trophy facts were checked against the appearance rule (comma-separated). */
  appearanceOrigins?: string[];
  allowProduction: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { compatOnly: false, wordgameKa: false, allowProduction: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => (arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[++i]);
    if (arg.startsWith('--target')) {
      const target = value() as PistasSeedTarget;
      if (!SEED_TARGETS.includes(target)) throw new Error(`--target must be one of ${SEED_TARGETS.join(', ')}`);
      args.target = target;
    } else if (arg.startsWith('--label')) args.label = value();
    else if (arg.startsWith('--activate')) args.activate = value();
    else if (arg.startsWith('--discard')) args.discard = value();
    else if (arg.startsWith('--facts')) args.facts = value();
    else if (arg.startsWith('--report-dir')) args.reportDir = value();
    else if (arg.startsWith('--binding-overrides')) args.bindingOverrides = value();
    else if (arg.startsWith('--appearance-rule-origins')) args.appearanceOrigins = value().split(',').map((origin) => origin.trim()).filter(Boolean);
    else if (arg === '--compat-only') args.compatOnly = true;
    else if (arg === '--wordgame-ka') args.wordgameKa = true;
    else if (arg === '--allow-production') args.allowProduction = true;
    else throw new Error(`Unknown argument ${arg}`);
  }
  return args;
}

const readJsonl = <T>(path: string): T[] => readFileSync(path, 'utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line) as T);
const sha256File = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

interface PlayerRecord {
  player_id: string;
  name_en?: string | null;
  name_ka?: string | null;
  transfermarkt_id?: string | null;
  wikidata_id?: string | null;
  aliases?: Array<{ alias: string; locale: string; type?: string; policy?: string }>;
  excluded_aliases?: Array<string | { alias: string; locale?: string }>;
}
interface IdentityRecord { stub_player_id: string; identified_player_id: string }

const ALIAS_LOCALES = new Set(['en', 'ka', 'translit', 'es', 'tr', 'ru', 'pt', 'de', 'fr', 'el']);
const GEORGIAN = /[Ⴀ-ჿ]/;

function report(dir: string | undefined, name: string, header: string[], rows: Array<Array<string | number | null>>): void {
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  const clean = (value: string | number | null) => String(value ?? '').replace(/[\t\n]/g, ' ');
  writeFileSync(join(dir, name), [header.join('\t'), ...rows.map((row) => row.map(clean).join('\t'))].join('\n') + '\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const target = resolvePistasSeedTarget(process.env.DATABASE_URL, args.target);
  if (target.kind === 'production' && !args.allowProduction) throw new Error('Production builds need --allow-production (and the owner\'s go-ahead)');
  const sql = postgres(process.env.DATABASE_URL!, { prepare: false, max: 2, idle_timeout: 20, connect_timeout: 30, onnotice: () => {} });
  console.log(`Target: ${target.label}`);
  try {
    if (args.activate) {
      await activate(sql, args.activate);
      return;
    }
    if (args.discard) {
      await discard(sql, args.discard);
      return;
    }
    if (!args.label) throw new Error('--label is required');
    if (!args.compatOnly && !args.facts) throw new Error('Pass --facts <dir>, or --compat-only for the compatibility snapshot alone');
    await build(sql, args);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** Removes a build that never sealed (a failed run). A sealed version is never removed. */
export async function discard(sql: postgres.Sql, label: string): Promise<void> {
  await sql.begin(async (transaction) => {
    const tx = transaction as unknown as postgres.Sql;
    await tx`SET LOCAL statement_timeout = '600s'`;
    const [version] = await tx<Array<{ id: string; status: string }>>`SELECT id, status FROM football_grid_judge_versions WHERE label = ${label}`;
    if (!version) throw new Error(`No judge version ${label}`);
    if (version.status !== 'building') throw new Error(`Judge version ${label} is ${version.status}; only an unsealed build can be discarded`);
    for (const table of ['football_grid_board_certifications', 'football_grid_judge_namesakes', 'football_grid_judge_aliases',
      'football_grid_judge_players', 'football_grid_criterion_players', 'football_grid_criterion_bindings']) {
      await tx.unsafe(`DELETE FROM ${table} WHERE judge_version_id = $1`, [version.id]);
    }
    await tx`DELETE FROM football_grid_judge_versions WHERE id = ${version.id}`;
  });
  console.log(`Discarded the unsealed build ${label}.`);
}

export async function activate(sql: postgres.Sql, label: string): Promise<void> {
  await sql.begin(async (transaction) => {
    const tx = transaction as unknown as postgres.Sql;
    const [version] = await tx<Array<{ id: string; status: string }>>`SELECT id, status FROM football_grid_judge_versions WHERE label = ${label} FOR UPDATE`;
    if (!version) throw new Error(`No judge version ${label}`);
    if (version.status !== 'ready') throw new Error(`Judge version ${label} is ${version.status}; only a ready version can be activated`);
    await tx`UPDATE football_grid_judge_versions SET status = 'ready' WHERE status = 'active'`;
    await tx`UPDATE football_grid_judge_versions SET status = 'active', activated_at = now() WHERE id = ${version.id}`;
  });
  console.log(`Activated ${label}. New matches and runs pin it as the rollout percentages allow (football_grid_judge_rollout).`);
}

export async function build(sql: postgres.Sql, args: Args): Promise<string> {
  const started = Date.now();
  /** One heavy statement in its own transaction, with a timeout of its own (the role's default is short). */
  const heavy = async <T>(statement: (tx: postgres.Sql) => Promise<T>): Promise<T> => sql.begin(async (transaction) => {
    const tx = transaction as unknown as postgres.Sql;
    await tx`SET LOCAL statement_timeout = '900s'`;
    return statement(tx);
  }) as Promise<T>;
  const log = (message: string) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${message}`);
  let gitSha = process.env.BUILDER_SHA ?? 'unknown';
  try { gitSha = execSync('git rev-parse HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* a copy, not a checkout: BUILDER_SHA */ }

  const releases = await sql<Array<{ id: string; version: number; manifest_checksum: string }>>`
    SELECT id, version, manifest_checksum FROM football_grid_content_releases WHERE status = 'published' ORDER BY version
  `;
  const factFiles = args.facts && !args.compatOnly
    ? Object.fromEntries(['facts.jsonl', 'players.jsonl', 'identity.jsonl', 'manifest.json'].map((file) => [file, sha256File(join(args.facts!, file))]))
    : null;
  const [version] = await sql<Array<{ id: string }>>`
    INSERT INTO football_grid_judge_versions (label, source)
    VALUES (${args.label!}, ${sql.json({
      kind: args.compatOnly ? 'compatibility' : 'compatibility+facts',
      releases: releases.map((release) => ({ version: release.version, manifest: release.manifest_checksum })),
      facts: factFiles,
      wordgameKa: args.wordgameKa,
      builder: gitSha,
      resolver: 'football-grid.answer-resolver@' + gitSha.slice(0, 12),
    })})
    RETURNING id
  `;
  const versionId = version.id;
  log(`Version ${args.label} (${versionId}) building`);

  // 1. Bindings: every criterion of a published release, plus those of boards a daily day still plays.
  const criteria = await heavy((tx) => tx<Array<{ id: string; criterion_key: string; family: string; subtype: string; label_en: string; release_version: number; overlap: string }>>`
    WITH pc AS (
      SELECT c.id, c.criterion_key, c.family, c.subtype, c.label_en, r.version AS release_version, r.status
        FROM football_grid_criteria c JOIN football_grid_content_releases r ON r.id = c.release_id
       WHERE r.status = 'published'
          OR c.id IN (
            SELECT unnest(b.row_criteria || b.column_criteria) FROM football_grid_boards b
             WHERE b.id::text IN (SELECT g.board->>'boardId' FROM grid_daily_days g)
          )
    ),
    latest AS (
      SELECT DISTINCT ON (criterion_key) criterion_key, id AS latest_id FROM pc WHERE status = 'published'
       ORDER BY criterion_key, release_version DESC
    ),
    sizes AS (SELECT criterion_id, count(*) AS n FROM football_grid_criterion_memberships WHERE criterion_id IN (SELECT id FROM pc) GROUP BY criterion_id),
    shared AS (
      SELECT pc.id, count(*) AS inter
        FROM pc JOIN latest l USING (criterion_key)
        JOIN football_grid_criterion_memberships m ON m.criterion_id = pc.id
        JOIN football_grid_criterion_memberships ml ON ml.criterion_id = l.latest_id AND ml.football_player_id = m.football_player_id
       GROUP BY pc.id
    )
    SELECT pc.id, pc.criterion_key, pc.family, pc.subtype, pc.label_en, pc.release_version,
           CASE WHEN l.latest_id IS NULL THEN 0
                WHEN pc.id = l.latest_id THEN 1
                ELSE coalesce(shared.inter, 0)::numeric / greatest(1, least(coalesce(s.n, 0), coalesce(sl.n, 0))) END AS overlap
      FROM pc
      LEFT JOIN latest l USING (criterion_key)
      LEFT JOIN sizes s ON s.criterion_id = pc.id
      LEFT JOIN sizes sl ON sl.criterion_id = l.latest_id
      LEFT JOIN shared ON shared.id = pc.id
  `);
  const overrides: BindingOverride[] = args.bindingOverrides ? readJsonl<BindingOverride>(args.bindingOverrides) : [];
  const rows: CriterionRow[] = criteria.map((row) => ({
    id: row.id, key: row.criterion_key, family: row.family, subtype: row.subtype, labelEn: row.label_en,
    releaseVersion: row.release_version, overlap: Number(row.overlap),
  }));
  const { decisions, definitions } = decideBindings(rows, overrides);
  const definitionIds = await upsertDefinitions(sql, definitions);
  for (let i = 0; i < decisions.length; i += 2000) {
    const chunk = decisions.slice(i, i + 2000).map((decision) => ({
      judge_version_id: versionId,
      criterion_id: decision.criterionId,
      definition_id: decision.definitionKey ? definitionIds.get(decision.definitionKey)! : null,
      status: decision.status,
      reason: decision.reason.slice(0, 300),
    }));
    await sql`INSERT INTO football_grid_criterion_bindings ${sql(chunk)}`;
  }
  const ambiguous = decisions.filter((decision) => decision.status === 'ambiguous');
  const rowById = new Map(rows.map((row) => [row.id, row]));
  report(args.reportDir, 'bindings-ambiguous.tsv', ['criterion_id', 'criterion_key', 'release', 'reason'],
    ambiguous.map((decision) => [decision.criterionId, rowById.get(decision.criterionId)!.key, rowById.get(decision.criterionId)!.releaseVersion, decision.reason]));
  log(`Bindings: ${decisions.length - ambiguous.length} bound, ${ambiguous.length} ambiguous, ${definitions.length} definitions`);

  // 2. Compatibility memberships: the union of reviewed memberships of the bound criteria of published releases.
  const compat = await heavy((tx) => tx`
    INSERT INTO football_grid_criterion_players (judge_version_id, definition_id, football_player_id, proof_ref)
    SELECT DISTINCT ON (b.definition_id, m.football_player_id)
           ${versionId}::uuid, b.definition_id, m.football_player_id, 'm:' || r.version
      FROM football_grid_criterion_bindings b
      JOIN football_grid_criteria c ON c.id = b.criterion_id
      JOIN football_grid_content_releases r ON r.id = c.release_id AND r.status = 'published'
      JOIN football_grid_criterion_memberships m ON m.criterion_id = c.id
     WHERE b.judge_version_id = ${versionId} AND b.status = 'bound'
     ORDER BY b.definition_id, m.football_player_id, r.version DESC
  `);
  log(`Compatibility memberships: ${compat.count}`);
  const retracted = await heavy((tx) => tx<Array<{ criterion_key: string; football_player_id: string; last_version: number }>>`
    WITH latest AS (
      SELECT DISTINCT ON (c.criterion_key) c.criterion_key, c.id FROM football_grid_criteria c
        JOIN football_grid_content_releases r ON r.id = c.release_id AND r.status = 'published'
       ORDER BY c.criterion_key, r.version DESC
    )
    SELECT c.criterion_key, m.football_player_id, max(r.version) AS last_version
      FROM football_grid_criteria c
      JOIN football_grid_content_releases r ON r.id = c.release_id AND r.status = 'published'
      JOIN football_grid_criterion_memberships m ON m.criterion_id = c.id
      JOIN latest l ON l.criterion_key = c.criterion_key
     WHERE NOT EXISTS (SELECT 1 FROM football_grid_criterion_memberships x WHERE x.criterion_id = l.id AND x.football_player_id = m.football_player_id)
     GROUP BY c.criterion_key, m.football_player_id
  `);
  report(args.reportDir, 'retracted-in-latest.tsv', ['criterion_key', 'football_player_id', 'last_release_with_it'],
    retracted.map((row) => [row.criterion_key, row.football_player_id, row.last_version]));
  log(`Kept in the union but absent from the newest release of their key: ${retracted.length} (retract them with op:"retract" facts)`);

  // 3. Curated facts.
  const playerOverrides = new Map<string, PlayerRecord>();
  if (factFiles) {
    const facts = readJsonl<FactRecord>(join(args.facts!, 'facts.jsonl'));
    const players = readJsonl<PlayerRecord>(join(args.facts!, 'players.jsonl'));
    const identities = readJsonl<IdentityRecord>(join(args.facts!, 'identity.jsonl'));
    for (const player of players) playerOverrides.set(player.player_id, player);
    const known = new Set((await sql<Array<{ id: string }>>`
      SELECT id::text FROM football_players WHERE id = ANY(${[...new Set([...facts.map((f) => f.player_id), ...players.map((p) => p.player_id), ...identities.flatMap((i) => [i.stub_player_id, i.identified_player_id])])]}::uuid[])
    `).map((row) => row.id));
    const definitionKeyByCriterionKey = new Map<string, string>();
    for (const decision of decisions) {
      if (decision.definitionKey) definitionKeyByCriterionKey.set(rowById.get(decision.criterionId)!.key, decision.definitionKey);
    }
    // A stub record of the same footballer holds the same facts until the records are merged.
    const twins = new Map<string, string[]>();
    for (const identity of identities) {
      twins.set(identity.identified_player_id, [...(twins.get(identity.identified_player_id) ?? []), identity.stub_player_id]);
      twins.set(identity.stub_player_id, [...(twins.get(identity.stub_player_id) ?? []), identity.identified_player_id]);
    }
    const asserts: Array<{ definitionKey: string; playerId: string; proof: string }> = [];
    const retracts: Array<{ definitionKey: string; playerId: string }> = [];
    const routing: Array<Array<string | number | null>> = [];
    const squadDefinitions = new Map<string, DefinitionSpec>();
    for (const fact of facts) {
      const routed = routeFact(fact, definitionKeyByCriterionKey, new Set(args.appearanceOrigins ?? []));
      const playerIds = [fact.player_id, ...(twins.get(fact.player_id) ?? [])].filter((id) => known.has(id));
      if (routed.kind === 'unknown-criterion' || playerIds.length === 0) {
        routing.push([factId(fact), fact.criterion_key, fact.player_id, routed.kind === 'unknown-criterion' ? 'skipped: criterion not bound' : 'skipped: unknown player']);
        continue;
      }
      if (fact.op === 'retract') {
        // A retraction removes the footballer from every definition the key can mean, the compatibility one included.
        const keys = [definitionKeyByCriterionKey.get(fact.criterion_key)!, ...(routed.kind === 'squad-rule' ? [routed.definition.definitionKey] : [])];
        if (routed.kind === 'squad-rule') squadDefinitions.set(routed.definition.definitionKey, routed.definition);
        for (const key of keys) for (const playerId of playerIds) retracts.push({ definitionKey: key, playerId });
        continue;
      }
      let definitionKey: string;
      if (routed.kind === 'squad-rule') {
        squadDefinitions.set(routed.definition.definitionKey, routed.definition);
        definitionKey = routed.definition.definitionKey;
        routing.push([factId(fact), fact.criterion_key, fact.player_id, 'squad-rule definition (not on current boards)']);
      } else {
        definitionKey = routed.definitionKey;
      }
      for (const playerId of playerIds) asserts.push({ definitionKey, playerId, proof: `f:${factId(fact)}` });
    }
    for (const [key, id] of await upsertDefinitions(sql, [...squadDefinitions.values()])) definitionIds.set(key, id);
    let added = 0;
    for (let i = 0; i < asserts.length; i += 2000) {
      const chunk = asserts.slice(i, i + 2000).map((row) => ({
        judge_version_id: versionId, definition_id: definitionIds.get(row.definitionKey)!, football_player_id: row.playerId, proof_ref: row.proof,
      }));
      added += (await sql`INSERT INTO football_grid_criterion_players ${sql(chunk)} ON CONFLICT DO NOTHING`).count;
    }
    let removed = 0;
    for (const row of retracts) {
      removed += (await sql`
        DELETE FROM football_grid_criterion_players
         WHERE judge_version_id = ${versionId} AND definition_id = ${definitionIds.get(row.definitionKey)!} AND football_player_id = ${row.playerId}
      `).count;
    }
    report(args.reportDir, 'fact-routing.tsv', ['fact_id', 'criterion_key', 'player_id', 'routing'], routing);
    log(`Facts: ${facts.length} read, ${added} memberships added, ${removed} retracted, ${routing.length} not on current definitions`);
  }

  // 4. Players: everyone the version can credit. Rank frozen now; names as the releases (or the fact file) give them.
  await heavy((tx) => tx`
    INSERT INTO football_grid_judge_players (judge_version_id, football_player_id, rank_score, name_en, name_ka, name_ru, name_el)
    SELECT ${versionId}::uuid, p.football_player_id, coalesce(fp.fame_score, 0),
           coalesce(nullif(fp.name, ''), p.football_player_id::text),
           (SELECT a.alias FROM football_grid_player_aliases a JOIN football_grid_content_releases r ON r.id = a.release_id AND r.status = 'published'
             WHERE a.football_player_id = p.football_player_id AND a.locale = 'ka' AND a.acceptance_policy = 'exact'
             ORDER BY (a.alias_type = 'georgian') DESC, r.version DESC, a.reviewed_at DESC, a.alias LIMIT 1),
           (SELECT a.alias FROM football_grid_player_aliases a JOIN football_grid_content_releases r ON r.id = a.release_id AND r.status = 'published'
             WHERE a.football_player_id = p.football_player_id AND a.locale = 'ru' AND a.alias_type = 'transliteration' AND a.acceptance_policy = 'exact'
             ORDER BY r.version DESC, a.reviewed_at DESC, a.alias LIMIT 1),
           (SELECT a.alias FROM football_grid_player_aliases a JOIN football_grid_content_releases r ON r.id = a.release_id AND r.status = 'published'
             WHERE a.football_player_id = p.football_player_id AND a.locale = 'el' AND a.alias_type = 'transliteration' AND a.acceptance_policy = 'exact'
             ORDER BY r.version DESC, a.reviewed_at DESC, a.alias LIMIT 1)
      FROM (SELECT DISTINCT football_player_id FROM football_grid_criterion_players WHERE judge_version_id = ${versionId}) p
      JOIN football_players fp ON fp.id = p.football_player_id
  `);
  for (const player of playerOverrides.values()) {
    await sql`
      UPDATE football_grid_judge_players
         SET name_en = coalesce(nullif(${player.name_en ?? null}::text, ''), name_en), name_ka = coalesce(nullif(${player.name_ka ?? null}::text, ''), name_ka)
       WHERE judge_version_id = ${versionId} AND football_player_id = ${player.player_id}
    `;
  }

  // 5. Aliases: every published release's, one per (player, spelling, locale, policy), newest release first.
  const releaseAliases = await heavy((tx) => tx`
    INSERT INTO football_grid_judge_aliases (judge_version_id, football_player_id, alias, normalized_alias, locale, alias_type, acceptance_policy, source_ref)
    SELECT DISTINCT ON (a.football_player_id, a.normalized_alias, a.locale, a.acceptance_policy)
           ${versionId}::uuid, a.football_player_id, a.alias, a.normalized_alias, a.locale, a.alias_type, a.acceptance_policy, 'r:' || r.version
      FROM football_grid_player_aliases a
      JOIN football_grid_content_releases r ON r.id = a.release_id AND r.status = 'published'
      JOIN football_grid_judge_players jp ON jp.judge_version_id = ${versionId} AND jp.football_player_id = a.football_player_id
     ORDER BY a.football_player_id, a.normalized_alias, a.locale, a.acceptance_policy, r.version DESC
  `);
  let factAliases = 0;
  let excluded = 0;
  const excludedButNameForm: Array<Array<string>> = [];
  for (const player of playerOverrides.values()) {
    const rowsToAdd = (player.aliases ?? []).filter((alias) => ALIAS_LOCALES.has(alias.locale)).map((alias) => ({
      judge_version_id: versionId,
      football_player_id: player.player_id,
      alias: alias.alias.slice(0, 160),
      normalized_alias: normalizeFootballGridAnswer(alias.alias).slice(0, 160),
      locale: alias.locale,
      alias_type: (alias.type ?? 'full_name').slice(0, 40),
      acceptance_policy: alias.policy === 'safe_typo' || alias.policy === 'unique_only' ? alias.policy : 'exact',
      source_ref: 'facts:players',
    })).filter((row) => row.normalized_alias);
    if (rowsToAdd.length > 0) {
      factAliases += (await sql`INSERT INTO football_grid_judge_aliases ${sql(rowsToAdd)} ON CONFLICT DO NOTHING`.catch((error: Error) => {
        if (/foreign key/i.test(error.message)) return { count: 0 };
        throw error;
      })).count;
    }
    for (const entry of player.excluded_aliases ?? []) {
      const text = typeof entry === 'string' ? entry : entry.alias;
      // Name forms (every word suffix of a footballer's names) are read by the resolver itself: an excluded spelling
      // that is one of them is still accepted. Reported, so the fact file fixes the name instead.
      const forms = [player.name_en ?? '', player.name_ka ?? ''].flatMap((name) => nameSuffixForms(name));
      if (forms.includes(normalizeFootballGridAnswer(text))) excludedButNameForm.push([player.player_id, normalizeFootballGridAnswer(text)]);
      excluded += (await sql`
        DELETE FROM football_grid_judge_aliases
         WHERE judge_version_id = ${versionId} AND football_player_id = ${player.player_id}
           AND normalized_alias = ${normalizeFootballGridAnswer(text)}
      `).count;
    }
  }
  let wordgameKa = 0;
  if (args.wordgameKa) {
    // Georgian spellings for footballers no release gives one: eligibility never waits for a Georgian name.
    const missing = await sql<Array<{ football_player_id: string; aliases: string[] }>>`
      SELECT jp.football_player_id, w.aliases
        FROM football_grid_judge_players jp
        JOIN wordgame_players w ON w.pid = jp.football_player_id::text
         AND w.release_id = (SELECT id FROM wordgame_releases ORDER BY created_at DESC LIMIT 1)
       WHERE jp.judge_version_id = ${versionId}
         AND NOT EXISTS (SELECT 1 FROM football_grid_judge_aliases a WHERE a.judge_version_id = ${versionId}
                          AND a.football_player_id = jp.football_player_id AND a.locale = 'ka')
    `;
    const kaRows = missing.flatMap((row) => row.aliases.filter((alias) => GEORGIAN.test(alias)).map((alias) => ({
      judge_version_id: versionId, football_player_id: row.football_player_id, alias: alias.slice(0, 160),
      normalized_alias: normalizeFootballGridAnswer(alias).slice(0, 160), locale: 'ka', alias_type: 'georgian',
      acceptance_policy: 'exact', source_ref: 'wordgame',
    }))).filter((row) => row.normalized_alias);
    for (let i = 0; i < kaRows.length; i += 2000) {
      wordgameKa += (await sql`INSERT INTO football_grid_judge_aliases ${sql(kaRows.slice(i, i + 2000))} ON CONFLICT DO NOTHING`).count;
    }
    await sql`
      UPDATE football_grid_judge_players jp SET name_ka = sub.alias
        FROM (SELECT DISTINCT ON (football_player_id) football_player_id, alias FROM football_grid_judge_aliases
               WHERE judge_version_id = ${versionId} AND locale = 'ka' AND source_ref = 'wordgame'
               ORDER BY football_player_id, alias) sub
       WHERE jp.judge_version_id = ${versionId} AND jp.football_player_id = sub.football_player_id AND jp.name_ka IS NULL
    `;
  }
  report(args.reportDir, 'excluded-aliases-still-name-forms.tsv', ['player_id', 'normalized'], excludedButNameForm);
  log(`Aliases: ${releaseAliases.count} from releases, ${factAliases} from the fact file, ${wordgameKa} Georgian from the word games, ${excluded} excluded`);

  // 6. The typo-veto universe: every footballer's name, normalised as the resolver reads it.
  let namesakes = 0;
  for (let after: string | null = null; ;) {
    const page: Array<{ id: string; name: string }> = await sql<Array<{ id: string; name: string }>>`
      SELECT id::text, name FROM football_players WHERE name <> '' AND (${after}::uuid IS NULL OR id > ${after}::uuid) ORDER BY id LIMIT 20000
    `;
    const chunk = page.map((row) => ({ judge_version_id: versionId, football_player_id: row.id, normalized_name: normalizeFootballGridAnswer(row.name).slice(0, 200) }))
      .filter((row) => row.normalized_name);
    for (let i = 0; i < chunk.length; i += 5000) {
      namesakes += (await sql`INSERT INTO football_grid_judge_namesakes ${sql(chunk.slice(i, i + 5000))} ON CONFLICT DO NOTHING`).count;
    }
    if (page.length < 20000) break;
    after = page[page.length - 1].id;
  }
  log(`Namesakes: ${namesakes}`);

  // 7. Certification of every dealable board (published releases, and the boards daily days play).
  const certification = await certifyBoards(sql, versionId, args.reportDir, log);

  // 8. Seal: wait for every writer (share locks on the version row), then checksum what is there and mark it ready.
  await sql.begin(async (transaction) => {
    const tx = transaction as unknown as postgres.Sql;
    await tx`SET LOCAL statement_timeout = '600s'`;
    await tx`SELECT 1 FROM football_grid_judge_versions WHERE id = ${versionId} FOR UPDATE`;
    const [sums] = await tx<Array<Record<string, string>>>`
      SELECT
        (SELECT md5(coalesce(string_agg(criterion_id || ':' || coalesce(definition_id::text, '-') || ':' || status, ',' ORDER BY criterion_id), '')) FROM football_grid_criterion_bindings WHERE judge_version_id = ${versionId}) AS bindings,
        (SELECT md5(coalesce(string_agg(definition_id || ':' || football_player_id, ',' ORDER BY definition_id, football_player_id), '')) FROM football_grid_criterion_players WHERE judge_version_id = ${versionId}) AS memberships,
        (SELECT md5(coalesce(string_agg(football_player_id || ':' || rank_score || ':' || name_en || ':' || coalesce(name_ka, '') || ':' || coalesce(name_ru, '') || ':' || coalesce(name_el, ''), ',' ORDER BY football_player_id), '')) FROM football_grid_judge_players WHERE judge_version_id = ${versionId}) AS players,
        (SELECT md5(coalesce(string_agg(football_player_id || ':' || normalized_alias || ':' || locale || ':' || acceptance_policy, ',' ORDER BY football_player_id, normalized_alias, locale, acceptance_policy), '')) FROM football_grid_judge_aliases WHERE judge_version_id = ${versionId}) AS aliases,
        (SELECT md5(coalesce(string_agg(football_player_id || ':' || normalized_name, ',' ORDER BY football_player_id, normalized_name), '')) FROM football_grid_judge_namesakes WHERE judge_version_id = ${versionId}) AS namesakes,
        (SELECT md5(coalesce(string_agg(board_id || ':' || status || ':' || metrics::text, ',' ORDER BY board_id), '')) FROM football_grid_board_certifications WHERE judge_version_id = ${versionId}) AS certifications
    `;
    const [counts] = await tx<Array<Record<string, number>>>`
      SELECT
        (SELECT count(*)::int FROM football_grid_criterion_bindings WHERE judge_version_id = ${versionId} AND status = 'bound') AS bound,
        (SELECT count(*)::int FROM football_grid_criterion_bindings WHERE judge_version_id = ${versionId} AND status = 'ambiguous') AS ambiguous,
        (SELECT count(*)::int FROM football_grid_criterion_players WHERE judge_version_id = ${versionId}) AS memberships,
        (SELECT count(*)::int FROM football_grid_judge_players WHERE judge_version_id = ${versionId}) AS players,
        (SELECT count(*)::int FROM football_grid_judge_aliases WHERE judge_version_id = ${versionId}) AS aliases,
        (SELECT count(*)::int FROM football_grid_judge_namesakes WHERE judge_version_id = ${versionId}) AS namesakes
    `;
    await tx`
      UPDATE football_grid_judge_versions
         SET status = 'ready', ready_at = now(), checksums = ${tx.json(sums)}, counts = ${tx.json({ ...counts, ...certification })}
       WHERE id = ${versionId}
    `;
  });
  log(`Sealed ${args.label}: ready. Activate with --activate ${args.label}`);
  return versionId;
}

async function upsertDefinitions(sql: postgres.Sql, definitions: DefinitionSpec[]): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (let i = 0; i < definitions.length; i += 1000) {
    const chunk = definitions.slice(i, i + 1000).map((d) => ({
      definition_key: d.definitionKey, family: d.family, subtype: d.subtype, entity_ref: d.entityRef,
      semantic_version: d.semanticVersion, predicate: d.predicate,
    }));
    await sql`INSERT INTO football_grid_criterion_definitions ${sql(chunk)} ON CONFLICT (definition_key) DO NOTHING`;
    const rows = await sql<Array<{ id: string; definition_key: string }>>`
      SELECT id, definition_key FROM football_grid_criterion_definitions WHERE definition_key = ANY(${chunk.map((d) => d.definition_key)})
    `;
    for (const row of rows) ids.set(row.definition_key, row.id);
  }
  return ids;
}

async function certifyBoards(sql: postgres.Sql, versionId: string, reportDir: string | undefined, log: (message: string) => void): Promise<Record<string, number>> {
  const members = new Map<string, string[]>();
  for (const row of await sql<Array<{ definition_id: string; football_player_id: string }>>`
    SELECT definition_id, football_player_id FROM football_grid_criterion_players WHERE judge_version_id = ${versionId}
  `) {
    const list = members.get(row.definition_id);
    if (list) list.push(row.football_player_id);
    else members.set(row.definition_id, [row.football_player_id]);
  }
  const players = new Map<string, { nameEn: string; nameKa: string | null; nameRu: string | null; nameEl: string | null; rank: number }>();
  for (const row of await sql<Array<{ football_player_id: string; name_en: string; name_ka: string | null; name_ru: string | null; name_el: string | null; rank_score: string }>>`
    SELECT football_player_id, name_en, name_ka, name_ru, name_el, rank_score FROM football_grid_judge_players WHERE judge_version_id = ${versionId}
  `) players.set(row.football_player_id, { nameEn: row.name_en, nameKa: row.name_ka, nameRu: row.name_ru, nameEl: row.name_el, rank: Number(row.rank_score) });
  const bindings = new Map((await sql<Array<{ criterion_id: string; definition_id: string | null }>>`
    SELECT criterion_id, definition_id FROM football_grid_criterion_bindings WHERE judge_version_id = ${versionId}
  `).map((row) => [row.criterion_id, row.definition_id]));
  const boards = await sql<Array<{ id: string; theme: string; canonical_checksum: string; row_criteria: string[]; column_criteria: string[] }>>`
    SELECT b.id, b.theme, b.canonical_checksum, b.row_criteria, b.column_criteria
      FROM football_grid_boards b JOIN football_grid_content_releases r ON r.id = b.release_id
     WHERE r.status = 'published' OR b.id::text IN (SELECT g.board->>'boardId' FROM grid_daily_days g)
  `;
  const criteria = new Map((await sql<Array<{ id: string; criterion_key: string; difficulty: 'easy' | 'normal' | 'hard' }>>`
    SELECT id, criterion_key, difficulty FROM football_grid_criteria WHERE id = ANY(${[...bindings.keys()]}::uuid[])
  `).map((row) => [row.id, row]));
  log(`Certifying ${boards.length} boards`);
  const counts = { certified: 0, rejected: 0, unbound: 0, choiceOk: 0 };
  const failures: Array<Array<string | number | null>> = [];
  const cellCache = new Map<string, string[]>();
  const cellOf = (rowDef: string, colDef: string): string[] => {
    const key = `${rowDef}:${colDef}`;
    let cell = cellCache.get(key);
    if (!cell) {
      const column = new Set(members.get(colDef) ?? []);
      cell = (members.get(rowDef) ?? []).filter((playerId) => column.has(playerId));
      cellCache.set(key, cell);
    }
    return cell;
  };
  for (let i = 0; i < boards.length; i += 500) {
    const batch = boards.slice(i, i + 500);
    const hints = await sql<Array<{ board_id: string; cell_index: number; football_player_id: string; is_sample: boolean; recognizable_rank: number | null }>>`
      SELECT board_id, cell_index, football_player_id, is_sample, recognizable_rank FROM football_grid_board_answers
       WHERE board_id = ANY(${batch.map((board) => board.id)}::uuid[]) AND (is_sample OR recognizable_rank IS NOT NULL)
    `;
    const hintsByBoard = new Map<string, Array<(typeof hints)[number]>>();
    for (const hint of hints) {
      const list = hintsByBoard.get(hint.board_id);
      if (list) list.push(hint);
      else hintsByBoard.set(hint.board_id, [hint]);
    }
    const rowsToInsert: Array<{ judge_version_id: string; board_id: string; status: string; metrics: postgres.JSONValue }> = [];
    for (const board of batch) {
      const rowDefs = board.row_criteria.map((id) => bindings.get(id) ?? null);
      const colDefs = board.column_criteria.map((id) => bindings.get(id) ?? null);
      if ([...rowDefs, ...colDefs].some((definition) => !definition)) {
        counts.unbound += 1;
        rowsToInsert.push({ judge_version_id: versionId, board_id: board.id, status: 'unbound', metrics: {} });
        continue;
      }
      const boardHints = hintsByBoard.get(board.id) ?? [];
      const cells: string[][] = [];
      const recognizable: string[][] = [];
      for (let cellIndex = 0; cellIndex < 9; cellIndex += 1) {
        const cell = cellOf(rowDefs[Math.floor(cellIndex / 3)]!, colDefs[cellIndex % 3]!);
        const cellHints = boardHints.filter((hint) => hint.cell_index === cellIndex);
        const hinted = new Map(cellHints.map((hint) => [hint.football_player_id, { sample: hint.is_sample, rank: hint.recognizable_rank }]));
        cells.push(orderCell(cell, hinted, (playerId) => players.get(playerId)?.rank ?? 0));
        recognizable.push(cellHints.filter((hint) => hint.recognizable_rank !== null).map((hint) => hint.football_player_id));
      }
      const view = (id: string) => ({ id, key: criteria.get(id)!.criterion_key, difficulty: criteria.get(id)!.difficulty });
      const result = certifyBoard({
        boardId: board.id, theme: board.theme, checksum: board.canonical_checksum,
        rows: board.row_criteria.map(view), columns: board.column_criteria.map(view), cells, recognizable, names: players,
      });
      counts[result.status] += 1;
      if (result.metrics.choiceOk) counts.choiceOk += 1;
      if (result.status !== 'certified') failures.push([board.id, board.theme, (result.metrics.errors as string[]).join('; ')]);
      rowsToInsert.push({ judge_version_id: versionId, board_id: board.id, status: result.status, metrics: result.metrics as postgres.JSONValue });
    }
    await sql`INSERT INTO football_grid_board_certifications ${sql(rowsToInsert.map((row) => ({ ...row, metrics: sql.json(row.metrics) })) as never)}`;
  }
  report(reportDir, 'certification-failures.tsv', ['board_id', 'theme', 'errors'], failures);
  log(`Certification: ${counts.certified} certified (${counts.choiceOk} choice-ready), ${counts.rejected} rejected, ${counts.unbound} unbound`);
  return { boardsCertified: counts.certified, boardsRejected: counts.rejected, boardsUnbound: counts.unbound, boardsChoiceOk: counts.choiceOk };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
