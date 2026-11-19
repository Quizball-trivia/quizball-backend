/**
 * Offline replay of recent Football Grid attempts: each typed or picked answer is judged again, on the footballers
 * used before it (bot claims included), by
 *   - legacy-now: today's legacy judge (the board's frozen answer list, its release's aliases, today's namesakes);
 *   - shared:     a compatibility judge version assembled in memory exactly as scripts/football-grid-judge-build.ts
 *                 binds and unions it (no database writes: this runs against production read-only),
 * and both are compared with the verdict that was recorded. Every difference gets one cause class.
 *
 *   READ_DATABASE_URL=… npx tsx scripts/football-grid-judge-replay.ts --days 7 --out <private dir>
 *
 * Every statement runs in its own short BEGIN READ ONLY … ROLLBACK. Output (private, never committed): diffs.tsv
 * (one row per difference, ids only) and summary.json.
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import {
  footballGridAddNames,
  footballGridNameUniverse,
  normalizeFootballGridAnswer,
  type FootballGridNameIndex,
  type FootballGridNameUniverse,
} from '../src/modules/football-grid/football-grid.answer-resolver.js';
import { certifyBoard, decideBindings, orderCell, routeFact, type BindingOverride, type CellHint, type CriterionRow, type FactRecord } from '../src/modules/football-grid/football-grid-judge-builder.js';
import { footballGridJudgeAnswer } from '../src/modules/football-grid/football-grid-judge.service.js';
import type { FootballGridAliasRecord, FootballGridResolvedAnswer } from '../src/modules/football-grid/football-grid.types.js';

function append<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

type Names = { nameEn: string; nameKa: string | null; nameRu: string | null; nameEl: string | null };
type Content = {
  aliases: FootballGridAliasRecord[];
  validPlayerIdsByCell: Map<number, string[]>;
  boardPlayerIds: string[];
  playerNamesById: Map<string, Names>;
  boardPlayerNames: Array<{ playerId: string } & Names>;
  universe: FootballGridNameUniverse;
  canonicalOf?: ReadonlyMap<string, string>;
};

interface ReplayArgs { days: number; out: string; limit: number; bindingOverrides: string | null; facts: string | null; appearanceOrigins: string[]; wordgameKa: boolean }

function parseArgs(argv: string[]): ReplayArgs {
  let days = 7;
  let out = '';
  let limit = 500_000;
  let bindingOverrides: string | null = null;
  let facts: string | null = null;
  let appearanceOrigins: string[] = [];
  let wordgameKa = false;
  for (let i = 0; i < argv.length; i += 1) {
    const operand = (): string => {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) throw new Error(`${argv[i - 1]} needs a value`);
      return value;
    };
    if (argv[i] === '--days') days = Number(operand());
    else if (argv[i] === '--out') out = operand();
    else if (argv[i] === '--limit') limit = Number(operand());
    // The same reviewed overrides the build used, so the replay binds criteria exactly as the version does.
    else if (argv[i] === '--binding-overrides') bindingOverrides = operand();
    // A fact-file version, applied in memory exactly as the builder applies it (--facts, origins, word-game ka).
    else if (argv[i] === '--facts') facts = operand();
    else if (argv[i] === '--appearance-rule-origins') appearanceOrigins = operand().split(',').map((origin) => origin.trim()).filter(Boolean);
    else if (argv[i] === '--wordgame-ka') wordgameKa = true;
    else throw new Error(`Unknown argument ${argv[i]}`);
  }
  if (!out) throw new Error('--out <private dir> is required');
  if (!Number.isFinite(days) || days <= 0 || days > 31) throw new Error('--days must be 1..31');
  return { days, out, limit, bindingOverrides, facts, appearanceOrigins, wordgameKa };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.READ_DATABASE_URL;
  if (!url) throw new Error('READ_DATABASE_URL is required (read-only use)');
  const sql = postgres(url, { prepare: false, max: 1, idle_timeout: 20, connect_timeout: 30, max_lifetime: 60 * 30, onnotice: () => {} });
  const started = Date.now();
  const log = (message: string) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${message}`);
  /** One statement, read-only, rolled back. Never a session-level SET (transaction pooler). */
  const read = async <T extends readonly object[]>(query: (tx: postgres.Sql) => Promise<T>): Promise<T> => {
    let result: T | undefined;
    await sql.begin('READ ONLY', async (transaction) => {
      const tx = transaction as unknown as postgres.Sql;
      await tx`SET LOCAL statement_timeout = '300s'`;
      await tx`SET LOCAL idle_in_transaction_session_timeout = '60s'`;
      result = await query(tx);
      throw Object.assign(new Error('rollback'), { rollback: true });
    }).catch((error: { rollback?: boolean }) => { if (!error.rollback) throw error; });
    return result!;
  };

  try {
    // 1. The attempts and everything their verdicts read.
    const attempts = await read((tx) => tx<Array<{
      id: string; inbox_id: string; match_id: string; turn_number: number; cell_index: number; submitted_text: string;
      outcome: string; resolved_player_id: string | null; board_id: string; alias_release_id: string; answer_mode: string | null;
      option_player_id: string | null; actor_is_bot: boolean;
    }>>`
      SELECT a.id, a.inbox_id, a.match_id, a.turn_number, a.cell_index, a.submitted_text, a.outcome, a.resolved_player_id,
             gm.board_id, gm.alias_release_id, gm.settings->>'answerMode' AS answer_mode, i.option_player_id,
             (gm.bot_user_id IS NOT DISTINCT FROM a.actor_user_id) AS actor_is_bot
        FROM football_grid_attempts a
        JOIN football_grid_matches gm ON gm.match_id = a.match_id
        LEFT JOIN football_grid_command_inbox i ON i.id = a.inbox_id
       WHERE a.resolved_at >= now() - make_interval(days => ${args.days})
         AND a.outcome IN ('correct', 'wrong', 'ambiguous', 'already_used')
       ORDER BY a.resolved_at
       LIMIT ${args.limit}
    `);
    log(`Attempts: ${attempts.length}`);
    const matchIds = [...new Set(attempts.map((attempt) => attempt.match_id))];
    const claims = new Map<string, Array<{ turn: number; playerId: string }>>();
    for (let i = 0; i < matchIds.length; i += 5000) {
      const rows = await read((tx) => tx<Array<{ match_id: string; turn_number: number; football_player_id: string }>>`
        SELECT match_id, turn_number, football_player_id FROM football_grid_claims WHERE match_id = ANY(${matchIds.slice(i, i + 5000)}::uuid[])
      `);
      for (const row of rows) append(claims, row.match_id, { turn: row.turn_number, playerId: row.football_player_id });
    }
    const boardIds = [...new Set(attempts.map((attempt) => attempt.board_id))];
    const boards = new Map((await read((tx) => tx<Array<{ id: string; row_criteria: string[]; column_criteria: string[]; theme: string; canonical_checksum: string }>>`
      SELECT id, row_criteria, column_criteria, theme, canonical_checksum FROM football_grid_boards WHERE id = ANY(${boardIds}::uuid[])
    `)).map((row) => [row.id, row]));
    const legacyNames = new Map<string, string>();
    const boardAnswers = new Map<string, Array<{ cell: number; playerId: string; nameKa: string | null; sample: boolean; rank: number | null }>>();
    for (let i = 0; i < boardIds.length; i += 200) {
      const rows = await read((tx) => tx<Array<{ board_id: string; cell_index: number; football_player_id: string; player_name_ka: string | null; is_sample: boolean; recognizable_rank: number | null }>>`
        SELECT board_id, cell_index, football_player_id, player_name_ka, is_sample, recognizable_rank
          FROM football_grid_board_answers WHERE board_id = ANY(${boardIds.slice(i, i + 200)}::uuid[])
      `);
      for (const row of rows) {
        append(boardAnswers, row.board_id, {
          cell: row.cell_index, playerId: row.football_player_id, nameKa: row.player_name_ka, sample: row.is_sample, rank: row.recognizable_rank,
        });
      }
    }
    log(`Boards: ${boardIds.length}`);
    // The legacy order reads live fame for every board player (getBoardAnswerContext), not only the version's.
    const legacyFame = new Map<string, number>();
    const boardPlayers = [...new Set([...boardAnswers.values()].flat().map((row) => row.playerId))];
    for (let i = 0; i < boardPlayers.length; i += 5000) {
      for (const row of await read((tx) => tx<Array<{ id: string; fame: string | null; name: string }>>`
        SELECT id::text, fame_score AS fame, coalesce(nullif(name, ''), id::text) AS name FROM football_players WHERE id = ANY(${boardPlayers.slice(i, i + 5000)}::uuid[])
      `)) {
        // NULLS LAST, as the runtime's ORDER BY fame_score DESC NULLS LAST.
        legacyFame.set(row.id, row.fame === null ? -Infinity : Number(row.fame));
        legacyNames.set(row.id, row.name);
      }
    }

    // 2. The compatibility version, as the builder makes it.
    const criteria = await read((tx) => tx<Array<{ id: string; criterion_key: string; family: string; subtype: string; label_en: string; release_version: number; overlap: string; difficulty: 'easy' | 'normal' | 'hard' }>>`
      WITH pc AS (
        SELECT c.id, c.criterion_key, c.family, c.subtype, c.label_en, c.difficulty, r.version AS release_version, r.status
          FROM football_grid_criteria c JOIN football_grid_content_releases r ON r.id = c.release_id
         WHERE r.status = 'published' OR c.id IN (SELECT unnest(b.row_criteria || b.column_criteria) FROM football_grid_boards b WHERE b.id = ANY(${boardIds}::uuid[]))
      ),
      latest AS (SELECT DISTINCT ON (criterion_key) criterion_key, id AS latest_id FROM pc WHERE status = 'published' ORDER BY criterion_key, release_version DESC),
      sizes AS (SELECT criterion_id, count(*) AS n FROM football_grid_criterion_memberships WHERE criterion_id IN (SELECT id FROM pc) GROUP BY criterion_id),
      shared AS (
        SELECT pc.id, count(*) AS inter FROM pc JOIN latest l USING (criterion_key)
          JOIN football_grid_criterion_memberships m ON m.criterion_id = pc.id
          JOIN football_grid_criterion_memberships ml ON ml.criterion_id = l.latest_id AND ml.football_player_id = m.football_player_id
         GROUP BY pc.id
      )
      SELECT pc.id, pc.criterion_key, pc.family, pc.subtype, pc.label_en, pc.release_version, pc.difficulty,
             CASE WHEN l.latest_id IS NULL THEN 0 WHEN pc.id = l.latest_id THEN 1
                  ELSE coalesce(shared.inter, 0)::numeric / greatest(1, least(coalesce(s.n, 0), coalesce(sl.n, 0))) END AS overlap
        FROM pc LEFT JOIN latest l USING (criterion_key) LEFT JOIN sizes s ON s.criterion_id = pc.id
        LEFT JOIN sizes sl ON sl.criterion_id = l.latest_id LEFT JOIN shared ON shared.id = pc.id
    `);
    const rows: CriterionRow[] = criteria.map((row) => ({ id: row.id, key: row.criterion_key, family: row.family, subtype: row.subtype, labelEn: row.label_en, releaseVersion: row.release_version, overlap: Number(row.overlap) }));
    const overrides: BindingOverride[] = args.bindingOverrides
      ? readFileSync(args.bindingOverrides, 'utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line) as BindingOverride)
      : [];
    const { decisions } = decideBindings(rows, overrides);
    const definitionOf = new Map(decisions.map((decision) => [decision.criterionId, decision.definitionKey]));
    const keyOf = new Map(rows.map((row) => [row.id, row.key]));
    const difficultyOf = new Map(criteria.map((row) => [row.id, row.difficulty]));
    const bound = decisions.filter((decision) => decision.definitionKey).map((decision) => decision.criterionId);
    const members = new Map<string, Set<string>>();
    const unionRows = await read((tx) => tx<Array<{ criterion_key: string; football_player_id: string }>>`
      SELECT DISTINCT c.criterion_key, m.football_player_id
        FROM football_grid_criteria c
        JOIN football_grid_content_releases r ON r.id = c.release_id AND r.status = 'published'
        JOIN football_grid_criterion_memberships m ON m.criterion_id = c.id
       WHERE c.id = ANY(${bound}::uuid[])
    `);
    // Every bound row of a key binds to the same definition (key + family + subtype), so the union is by key.
    for (const row of unionRows) {
      const set = members.get(row.criterion_key) ?? new Set<string>();
      set.add(row.football_player_id);
      members.set(row.criterion_key, set);
    }
    const newest = new Map<string, Set<string>>();
    for (const row of await read((tx) => tx<Array<{ criterion_key: string; football_player_id: string }>>`
      WITH latest AS (
        SELECT DISTINCT ON (c.criterion_key) c.criterion_key, c.id FROM football_grid_criteria c
          JOIN football_grid_content_releases r ON r.id = c.release_id AND r.status = 'published'
         ORDER BY c.criterion_key, r.version DESC
      )
      SELECT latest.criterion_key, m.football_player_id FROM latest JOIN football_grid_criterion_memberships m ON m.criterion_id = latest.id
    `)) {
      const set = newest.get(row.criterion_key) ?? new Set<string>();
      set.add(row.football_player_id);
      newest.set(row.criterion_key, set);
    }
    // Curated facts: routed and expanded to identity twins as the builder does; squad-rule trophies stay off boards.
    const factMembers = new Set<string>();
    /** As the builder: retractions apply after the identity fold, to canonical ids. */
    const pendingRetracts: Array<{ key: string; playerId: string }> = [];
    /** Duplicate records folded as the builder folds them (stub -> canonical record). */
    const canonicalOf = new Map<string, string>();
    type FactPlayer = { player_id: string; name_en?: string | null; name_ka?: string | null; aliases?: Array<{ alias: string; locale: string; type?: string; policy?: string }>; excluded_aliases?: Array<string | { alias: string }> };
    const factPlayers = new Map<string, FactPlayer>();
    if (args.facts) {
      const jsonl = <T>(file: string): T[] => readFileSync(`${args.facts}/${file}`, 'utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line) as T);
      const twins = new Map<string, string[]>();
      const identities = jsonl<{ stub_player_id: string; identified_player_id: string }>('identity.jsonl');
      // Only pairs whose two records exist, as the builder takes them.
      const existing = new Set((await read((tx) => tx<Array<{ id: string }>>`
        SELECT id::text FROM football_players WHERE id = ANY(${[...new Set(identities.flatMap((i) => [i.stub_player_id, i.identified_player_id]))]}::uuid[])
      `)).map((row) => row.id));
      for (const identity of identities) {
        append(twins, identity.identified_player_id, identity.stub_player_id);
        append(twins, identity.stub_player_id, identity.identified_player_id);
        if (existing.has(identity.stub_player_id) && existing.has(identity.identified_player_id)) {
          canonicalOf.set(identity.stub_player_id, identity.identified_player_id);
        }
      }
      for (const player of jsonl<FactPlayer>('players.jsonl')) factPlayers.set(player.player_id, player);
      const boundKeys = new Map([...members.keys()].map((key) => [key, key]));
      const origins = new Set(args.appearanceOrigins);
      let added = 0;
      for (const fact of jsonl<FactRecord>('facts.jsonl')) {
        const routed = routeFact(fact, boundKeys, origins);
        if (routed.kind !== 'definition') continue;
        for (const playerId of [fact.player_id, ...(twins.get(fact.player_id) ?? [])]) {
          const set = members.get(fact.criterion_key)!;
          if (fact.op === 'retract') { pendingRetracts.push({ key: fact.criterion_key, playerId }); continue; }
          if (!set.has(playerId)) { set.add(playerId); factMembers.add(`${fact.criterion_key}|${playerId}`); added += 1; }
        }
      }
      log(`Facts applied: ${added} memberships added`);
    }
    // Fold: a stub's memberships belong to its canonical record, and the stub leaves the version (the builder's rule).
    for (const [key, set] of members) {
      for (const [stub, real] of canonicalOf) if (set.delete(stub)) set.add(real);
      if (key.startsWith('teammate:')) {
        const anchor = key.slice('teammate:'.length);
        set.delete(canonicalOf.get(anchor) ?? anchor);
      }
    }
    for (const row of pendingRetracts) members.get(row.key)?.delete(canonicalOf.get(row.playerId) ?? row.playerId);
    const allPlayers = [...new Set([...members.values()].flatMap((set) => [...set]))];
    log(`Bindings: ${bound.length}/${decisions.length} bound; union ${unionRows.length} memberships over ${allPlayers.length} players`);

    const players = new Map<string, Names & { rank: number }>();
    for (let i = 0; i < allPlayers.length; i += 5000) {
      for (const row of await read((tx) => tx<Array<{ id: string; name: string; fame: string | null; ka: string | null; ru: string | null; el: string | null }>>`
        SELECT fp.id::text, coalesce(nullif(fp.name, ''), fp.id::text) AS name, fp.fame_score AS fame,
          (SELECT a.alias FROM football_grid_player_aliases a JOIN football_grid_content_releases r ON r.id = a.release_id AND r.status = 'published'
            WHERE a.football_player_id = fp.id AND a.locale = 'ka' AND a.acceptance_policy = 'exact'
            ORDER BY (a.alias_type = 'georgian') DESC, r.version DESC, a.reviewed_at DESC, a.alias LIMIT 1) AS ka,
          (SELECT a.alias FROM football_grid_player_aliases a JOIN football_grid_content_releases r ON r.id = a.release_id AND r.status = 'published'
            WHERE a.football_player_id = fp.id AND a.locale = 'ru' AND a.alias_type = 'transliteration' AND a.acceptance_policy = 'exact'
            ORDER BY r.version DESC, a.reviewed_at DESC, a.alias LIMIT 1) AS ru,
          (SELECT a.alias FROM football_grid_player_aliases a JOIN football_grid_content_releases r ON r.id = a.release_id AND r.status = 'published'
            WHERE a.football_player_id = fp.id AND a.locale = 'el' AND a.alias_type = 'transliteration' AND a.acceptance_policy = 'exact'
            ORDER BY r.version DESC, a.reviewed_at DESC, a.alias LIMIT 1) AS el
          FROM football_players fp WHERE fp.id = ANY(${allPlayers.slice(i, i + 5000)}::uuid[])
      `)) players.set(row.id, { nameEn: row.name, nameKa: row.ka, nameRu: row.ru, nameEl: row.el, rank: Number(row.fame ?? 0) });
    }
    const sharedAliases = new Map<string, FootballGridAliasRecord[]>();
    for (let i = 0; i < allPlayers.length; i += 5000) {
      for (const row of await read((tx) => tx<Array<{ football_player_id: string; alias: string; normalized_alias: string; locale: FootballGridAliasRecord['locale']; acceptance_policy: FootballGridAliasRecord['acceptancePolicy']; version: number }>>`
        SELECT DISTINCT ON (a.football_player_id, a.normalized_alias, a.locale, a.acceptance_policy)
               a.football_player_id, a.alias, a.normalized_alias, a.locale, a.acceptance_policy, r.version
          FROM football_grid_player_aliases a JOIN football_grid_content_releases r ON r.id = a.release_id AND r.status = 'published'
         WHERE a.football_player_id = ANY(${allPlayers.slice(i, i + 5000)}::uuid[])
         ORDER BY a.football_player_id, a.normalized_alias, a.locale, a.acceptance_policy, r.version DESC
      `)) {
        const alias: FootballGridAliasRecord = { id: `shared:${row.football_player_id}:${row.normalized_alias}:${row.locale}`, playerId: row.football_player_id, alias: row.alias, normalizedAlias: row.normalized_alias, locale: row.locale, acceptancePolicy: row.acceptance_policy };
        append(sharedAliases, row.football_player_id, alias);
      }
    }
    // A folded stub's spellings name its canonical record.
    if (canonicalOf.size > 0) {
      for (let i = 0; i < [...canonicalOf.keys()].length; i += 5000) {
        const stubs = [...canonicalOf.keys()].slice(i, i + 5000);
        for (const row of await read((tx) => tx<Array<{ football_player_id: string; alias: string; normalized_alias: string; locale: FootballGridAliasRecord['locale']; acceptance_policy: FootballGridAliasRecord['acceptancePolicy'] }>>`
          SELECT DISTINCT ON (a.football_player_id, a.normalized_alias, a.locale, a.acceptance_policy)
                 a.football_player_id, a.alias, a.normalized_alias, a.locale, a.acceptance_policy
            FROM football_grid_player_aliases a JOIN football_grid_content_releases r ON r.id = a.release_id AND r.status = 'published'
           WHERE a.football_player_id = ANY(${stubs}::uuid[])
           ORDER BY a.football_player_id, a.normalized_alias, a.locale, a.acceptance_policy, r.version DESC
        `)) {
          const real = canonicalOf.get(row.football_player_id)!;
          const list = sharedAliases.get(real) ?? [];
          if (list.some((a) => a.normalizedAlias === row.normalized_alias && a.locale === row.locale && a.acceptancePolicy === row.acceptance_policy)) continue;
          append(sharedAliases, real, { id: `twin:${real}:${row.normalized_alias}:${row.locale}`, playerId: real, alias: row.alias, normalizedAlias: row.normalized_alias, locale: row.locale, acceptancePolicy: row.acceptance_policy });
        }
      }
    }
    // The builder's order: release aliases, a folded stub's spellings, then curated aliases and exclusions, all on the
    // canonical record (a stub's display name never replaces its record's).
    const excludedFor = new Map<string, Set<string>>();
    for (const player of factPlayers.values()) {
      const target = canonicalOf.get(player.player_id) ?? player.player_id;
      const current = players.get(player.player_id);
      if (current && target === player.player_id) players.set(player.player_id, { ...current, nameEn: player.name_en || current.nameEn, nameKa: player.name_ka || current.nameKa });
      for (const alias of player.aliases ?? []) {
        const normalized = normalizeFootballGridAnswer(alias.alias);
        if (!normalized || !['en', 'ka', 'translit', 'es', 'tr', 'ru', 'pt', 'de', 'fr', 'el'].includes(alias.locale)) continue;
        const list = sharedAliases.get(target) ?? [];
        const policy = (alias.policy === 'safe_typo' || alias.policy === 'unique_only' ? alias.policy : 'exact') as FootballGridAliasRecord['acceptancePolicy'];
        if (list.some((a) => a.normalizedAlias === normalized && a.locale === alias.locale && a.acceptancePolicy === policy)) continue;
        append(sharedAliases, target, { id: `fact:${target}:${normalized}:${alias.locale}`, playerId: target, alias: alias.alias,
          normalizedAlias: normalized, locale: alias.locale as FootballGridAliasRecord['locale'], acceptancePolicy: policy });
      }
      const excluded = excludedFor.get(target) ?? new Set<string>();
      for (const entry of player.excluded_aliases ?? []) excluded.add(normalizeFootballGridAnswer(typeof entry === 'string' ? entry : entry.alias));
      excludedFor.set(target, excluded);
      if (excluded.size > 0) sharedAliases.set(target, (sharedAliases.get(target) ?? []).filter((alias) => !excluded.has(alias.normalizedAlias)));
    }
    if (args.wordgameKa) {
      const withoutKa = allPlayers.filter((id) => !(sharedAliases.get(id) ?? []).some((alias) => alias.locale === 'ka'));
      for (let i = 0; i < withoutKa.length; i += 5000) {
        for (const row of await read((tx) => tx<Array<{ pid: string; aliases: string[] }>>`
          SELECT pid, aliases FROM wordgame_players
           WHERE release_id = (SELECT id FROM wordgame_releases ORDER BY created_at DESC LIMIT 1) AND pid = ANY(${withoutKa.slice(i, i + 5000)}::text[])
        `)) {
          const excluded = excludedFor.get(row.pid) ?? new Set<string>();
          const ka = row.aliases.filter((alias) => /[\u10A0-\u10FF]/.test(alias) && !excluded.has(normalizeFootballGridAnswer(alias)));
          for (const alias of ka) append(sharedAliases, row.pid, { id: `wordgame:${row.pid}:${alias}`, playerId: row.pid, alias, normalizedAlias: normalizeFootballGridAnswer(alias), locale: 'ka', acceptancePolicy: 'exact' });
          const current = players.get(row.pid);
          if (current && !current.nameKa && ka[0]) players.set(row.pid, { ...current, nameKa: [...ka].sort()[0] });
        }
      }
    }
    const namesakeIndex: FootballGridNameIndex = new Map();
    const rawNamesakeIndex: FootballGridNameIndex = new Map();
    for (let after: string | null = null; ;) {
      const page: Array<{ id: string; name: string }> = await read((tx) => tx<Array<{ id: string; name: string }>>`
        SELECT id::text, name FROM football_players WHERE name <> '' AND (${after}::uuid IS NULL OR id > ${after}::uuid) ORDER BY id LIMIT 20000
      `);
      // The shared side reads the version's index (stubs name their canonical record); legacy reads raw ids, as runtime.
      footballGridAddNames(namesakeIndex, page.map((row) => ({ playerId: canonicalOf.get(row.id) ?? row.id, normalized: normalizeFootballGridAnswer(row.name) })));
      if (canonicalOf.size > 0) footballGridAddNames(rawNamesakeIndex, page.map((row) => ({ playerId: row.id, normalized: normalizeFootballGridAnswer(row.name) })));
      if (page.length < 20000) break;
      after = page[page.length - 1].id;
    }
    const namesakes: FootballGridNameUniverse = { holders: (key) => namesakeIndex.get(key) ?? [], pending: () => false };
    const legacyNamesakes: FootballGridNameUniverse = canonicalOf.size > 0
      ? { holders: (key) => rawNamesakeIndex.get(key) ?? [], pending: () => false }
      : namesakes;
    const sharedUniverse = footballGridNameUniverse([sharedAliases], namesakes);
    log(`Shared version assembled: ${players.size} players, ${sharedAliases.size} with aliases, ${namesakeIndex.size} names`);

    // 3. Legacy-now inputs: each match's alias release, read as the runtime reads it.
    type ReleaseAliases = { byPlayer: Map<string, FootballGridAliasRecord[]>; ru: Map<string, string>; el: Map<string, string> };
    const releaseAliasCache = new Map<string, ReleaseAliases>();
    const releaseAliases = async (releaseId: string): Promise<ReleaseAliases> => {
      let cached = releaseAliasCache.get(releaseId);
      if (!cached) {
        cached = { byPlayer: new Map(), ru: new Map(), el: new Map() };
        const rows = await read((tx) => tx<Array<{ id: string; football_player_id: string; alias: string; normalized_alias: string; locale: FootballGridAliasRecord['locale']; acceptance_policy: FootballGridAliasRecord['acceptancePolicy']; alias_type: string }>>`
          SELECT id, football_player_id, alias, normalized_alias, locale, acceptance_policy, alias_type
            FROM football_grid_player_aliases WHERE release_id = ${releaseId} ORDER BY reviewed_at DESC, alias
        `);
        for (const row of rows) {
          append(cached.byPlayer, row.football_player_id, { id: row.id, playerId: row.football_player_id, alias: row.alias, normalizedAlias: row.normalized_alias, locale: row.locale, acceptancePolicy: row.acceptance_policy });
          // The runtime's display names: the newest reviewed exact transliteration (getBoardAnswerContext).
          if (row.alias_type === 'transliteration' && row.acceptance_policy === 'exact' && (row.locale === 'ru' || row.locale === 'el')) {
            const names = cached[row.locale];
            if (!names.has(row.football_player_id)) names.set(row.football_player_id, row.alias);
          }
        }
        releaseAliasCache.set(releaseId, cached);
      }
      return cached;
    };

    const legacyCache = new Map<string, Content>();
    const sharedCache = new Map<string, Content | null>();
    const unavailableReason = new Map<string, string>();
    const order = (boardId: string, cell: number, ids: string[], fame: (id: string) => number): string[] => {
      const hints = new Map((boardAnswers.get(boardId) ?? []).filter((row) => row.cell === cell).map((row) => [row.playerId, row]));
      return ids.sort((a, b) => {
        const ha = hints.get(a);
        const hb = hints.get(b);
        if (!!ha !== !!hb) return ha ? -1 : 1;
        if (ha && hb && ha.sample !== hb.sample) return ha.sample ? -1 : 1;
        const ra = ha?.rank ?? Infinity;
        const rb = hb?.rank ?? Infinity;
        if (ra !== rb) return ra - rb;
        return fame(b) - fame(a) || (a < b ? -1 : a > b ? 1 : 0);
      });
    };
    const contentOf = (cells: Map<number, string[]>, names: Map<string, Names>, aliasesOf: (id: string) => FootballGridAliasRecord[], universe: FootballGridNameUniverse): Content => {
      const boardPlayerIds = [...new Set([...cells.values()].flat())];
      return {
        aliases: boardPlayerIds.flatMap(aliasesOf),
        validPlayerIdsByCell: cells,
        boardPlayerIds,
        playerNamesById: names,
        boardPlayerNames: boardPlayerIds.map((playerId) => ({ playerId, ...(names.get(playerId) ?? { nameEn: playerId, nameKa: null, nameRu: null, nameEl: null }) })),
        universe,
      };
    };
    const legacyContent = async (attempt: (typeof attempts)[number]): Promise<Content> => {
      const cacheKey = `${attempt.board_id}:${attempt.alias_release_id}`;
      let content = legacyCache.get(cacheKey);
      if (!content) {
        const release = await releaseAliases(attempt.alias_release_id);
        const byPlayer = release.byPlayer;
        const cells = new Map<number, string[]>();
        const names = new Map<string, Names>();
        for (const row of boardAnswers.get(attempt.board_id) ?? []) append(cells, row.cell, row.playerId);
        for (const [cell, ids] of cells) cells.set(cell, order(attempt.board_id, cell, ids, (id) => legacyFame.get(id) ?? 0));
        for (const row of boardAnswers.get(attempt.board_id) ?? []) {
          names.set(row.playerId, { nameEn: legacyNames.get(row.playerId) ?? row.playerId, nameKa: row.nameKa, nameRu: release.ru.get(row.playerId) ?? null, nameEl: release.el.get(row.playerId) ?? null });
        }
        content = contentOf(cells, names, (id) => byPlayer.get(id) ?? [], footballGridNameUniverse([byPlayer], legacyNamesakes));
        legacyCache.set(cacheKey, content);
      }
      return content;
    };
    const sharedContent = (boardId: string): Content | null => {
      if (sharedCache.has(boardId)) return sharedCache.get(boardId)!;
      const board = boards.get(boardId);
      const defs = board ? [...board.row_criteria, ...board.column_criteria].map((id) => (definitionOf.get(id) ? keyOf.get(id)! : null)) : [];
      if (!board || defs.some((key) => key === null)) {
        sharedCache.set(boardId, null);
        unavailableReason.set(boardId, board ? 'criterion not bound' : 'board not found');
        return null;
      }
      const cells = new Map<number, string[]>();
      for (let cell = 0; cell < 9; cell += 1) {
        const column = members.get(defs[3 + (cell % 3)]!) ?? new Set();
        const ids = [...(members.get(defs[Math.floor(cell / 3)]!) ?? [])].filter((id) => column.has(id));
        const hints = new Map<string, CellHint>();
        for (const row of (boardAnswers.get(boardId) ?? []).filter((r) => r.cell === cell && (r.sample || r.rank !== null))) {
          const id = canonicalOf.get(row.playerId) ?? row.playerId;      // a stub's hint is its canonical record's
          const prior = hints.get(id);
          hints.set(id, { sample: (prior?.sample ?? false) || row.sample, rank: [prior?.rank, row.rank].filter((r): r is number => r !== null && r !== undefined).sort((x, y) => x - y)[0] ?? null });
        }
        if (ids.length > 0) cells.set(cell, orderCell(ids, hints, (id) => players.get(id)?.rank ?? 0));
      }
      // The runtime judges only a board the version certified.
      const certification = certifyBoard({
        boardId, theme: board.theme, checksum: board.canonical_checksum,
        rows: board.row_criteria.map((id) => ({ id, key: keyOf.get(id)!, difficulty: difficultyOf.get(id) ?? 'normal' })),
        columns: board.column_criteria.map((id) => ({ id, key: keyOf.get(id)!, difficulty: difficultyOf.get(id) ?? 'normal' })),
        cells: Array.from({ length: 9 }, (_, cell) => cells.get(cell) ?? []),
        recognizable: Array.from({ length: 9 }, (_, cell) => [...new Set((boardAnswers.get(boardId) ?? []).filter((row) => row.cell === cell && row.rank !== null).map((row) => canonicalOf.get(row.playerId) ?? row.playerId))]),
        names: players,
      });
      if (certification.status !== 'certified') {
        sharedCache.set(boardId, null);
        unavailableReason.set(boardId, `not certified: ${((certification.metrics.errors as string[]) ?? []).slice(0, 2).join('; ')}`);
        return null;
      }
      const names = new Map([...new Set([...cells.values()].flat())].map((id) => [id, players.get(id)!]));
      const content = { ...contentOf(cells, names, (id) => sharedAliases.get(id) ?? [], sharedUniverse), canonicalOf };
      sharedCache.set(boardId, content);
      return content;
    };

    // 4. Judge and classify.
    const counts: Record<string, number> = {};
    const bump = (key: string) => { counts[key] = (counts[key] ?? 0) + 1; };
    const diffs: string[] = ['attempt_id\tboard_id\tcell\tkind\trecorded\tlegacy_now\tshared\tcause'];
    const verdict = (r: { outcome: string; playerId: string | null }) => `${r.outcome}:${r.playerId ?? '-'}`;
    // Board by board: a board's assembled content (and the resolver's indexes on it) is dropped before the next.
    const byBoard = [...attempts].sort((a, b) => (a.board_id < b.board_id ? -1 : a.board_id > b.board_id ? 1 : 0));
    let currentBoard = '';
    for (const attempt of byBoard) {
      if (attempt.board_id !== currentBoard) {
        currentBoard = attempt.board_id;
        legacyCache.clear();
        sharedCache.clear();
      }
      if (attempt.actor_is_bot) { bump('skipped:bot'); continue; }
      const used = (claims.get(attempt.match_id) ?? []).filter((claim) => claim.turn < attempt.turn_number).map((claim) => claim.playerId);
      const picked = attempt.answer_mode === 'choice' ? attempt.option_player_id : null;
      const judge = (content: Content): Promise<FootballGridResolvedAnswer> =>
        footballGridJudgeAnswer(content, attempt.cell_index, attempt.submitted_text, picked, async () => used);
      const recorded = { outcome: attempt.outcome, playerId: attempt.resolved_player_id };
      const legacy = await judge(await legacyContent(attempt));
      const shared = sharedContent(attempt.board_id);
      bump('attempts');
      const legacyDrift = verdict(legacy) !== verdict(recorded);
      if (legacyDrift) bump('legacy_now_differs_from_recorded');
      if (!shared) {
        bump('board_not_judgeable_by_version');
        // Every such attempt is listed (the board stays on legacy judging), with why the version cannot judge it.
        diffs.push([attempt.id, attempt.board_id, attempt.cell_index, picked ? 'picked' : 'typed', verdict(recorded), verdict(legacy), '-',
          `board_stays_legacy: ${unavailableReason.get(attempt.board_id) ?? 'unavailable'}${legacyDrift ? '; legacy_context_drift' : ''}`].join('\t'));
        continue;
      }
      const next = await judge(shared);
      if (verdict(next) === verdict(legacy)) {
        bump(legacyDrift ? 'same_as_legacy_now' : 'same');
        // Recorded and today's legacy disagree (aliases, names or fame changed since): kept, so nothing is hidden.
        if (legacyDrift) diffs.push([attempt.id, attempt.board_id, attempt.cell_index, picked ? 'picked' : 'typed', verdict(recorded), verdict(legacy), verdict(next), 'legacy_context_drift'].join('\t'));
        continue;
      }
      const legacyCell = (await legacyContent(attempt)).validPlayerIdsByCell.get(attempt.cell_index) ?? [];
      const sharedCell = shared.validPlayerIdsByCell.get(attempt.cell_index) ?? [];
      let cause: string;
      if (next.outcome === 'correct' && legacy.outcome !== 'correct' && next.playerId && !legacyCell.includes(next.playerId)) {
        const board = boards.get(attempt.board_id)!;
        const rowKey = keyOf.get(board.row_criteria[Math.floor(attempt.cell_index / 3)])!;
        const colKey = keyOf.get(board.column_criteria[attempt.cell_index % 3])!;
        const inNewest = newest.get(rowKey)?.has(next.playerId) && newest.get(colKey)?.has(next.playerId);
        const byFact = factMembers.has(`${rowKey}|${next.playerId}`) || factMembers.has(`${colKey}|${next.playerId}`);
        cause = byFact ? 'accepted:fact_file' : inNewest ? 'accepted:membership_in_newest_release' : 'accepted:membership_only_in_older_release';
      }
      else if (legacy.outcome === 'correct' && legacy.playerId && !sharedCell.includes(legacy.playerId)) cause = 'refused:membership_missing_from_version';
      else if (legacy.outcome === 'correct' && next.outcome === 'correct') cause = 'credited_player:ranking_or_names';
      else if (next.outcome === 'ambiguous' || legacy.outcome === 'ambiguous') cause = 'ambiguity:more_board_names_compete';
      else if (picked) cause = 'choice:cell_set_changed';
      else cause = 'names:alias_or_universe';
      bump(`diff:${cause}`);
      diffs.push([attempt.id, attempt.board_id, attempt.cell_index, picked ? 'picked' : 'typed', verdict(recorded), verdict(legacy), verdict(next), cause].join('\t'));
    }
    mkdirSync(args.out, { recursive: true });
    writeFileSync(join(args.out, 'diffs.tsv'), diffs.join('\n') + '\n');
    const fileHash = (path: string | null) => (path ? { path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') } : null);
    writeFileSync(join(args.out, 'summary.json'), JSON.stringify({
      days: args.days, generatedAt: new Date().toISOString(), counts,
      inputs: { bindingOverrides: fileHash(args.bindingOverrides), facts: args.facts ? Object.fromEntries(['facts.jsonl', 'players.jsonl', 'identity.jsonl']
        .map((file) => [file, fileHash(`${args.facts}/${file}`)])) : null, appearanceOrigins: args.appearanceOrigins, wordgameKa: args.wordgameKa },
    }, null, 2));
    log(`Done: ${JSON.stringify(counts)}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
