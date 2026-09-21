import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { z } from 'zod';
import { sql } from '../src/db/index.js';
import {
  canonicalFootballGridBoardChecksum,
  validateFootballGridRelease,
} from '../src/modules/football-grid/football-grid.content-validator.js';
import { normalizeFootballGridAnswer } from '../src/modules/football-grid/football-grid.answer-resolver.js';
import type { FootballGridBoardCandidate, FootballGridCriterionView } from '../src/modules/football-grid/football-grid.types.js';

const difficulty = z.enum(['easy', 'normal', 'hard']);
const criterionFamily = z.enum(['club', 'country', 'league', 'manager', 'teammate', 'trophy_award', 'wildcard']);
const sourceSchema = z.object({
  key: z.string().min(1),
  providerName: z.string().min(1),
  datasetVersion: z.string().min(1),
  permittedUse: z.string().min(1),
  databaseRightsStatus: z.literal('approved'),
  attributionRequirements: z.string().optional(),
  retentionRequirements: z.string().optional(),
  approvalOwner: z.string().min(1),
  approvedAt: z.string().datetime(),
});
const criterionSchema = z.object({
  key: z.string().min(1),
  family: criterionFamily,
  subtype: z.string().min(1),
  labelEn: z.string().min(1),
  labelKa: z.string().min(1),
  assetKey: z.string().nullable().optional(),
  metadata: z.record(z.unknown()).default({}),
  difficulty,
  familiarityScore: z.number().min(0).max(100),
});
const evidenceSchema = z.object({
  sourceKey: z.string().min(1),
  sourceLocator: z.string().min(1),
  capturedFact: z.string().min(1),
  effectiveFrom: z.string().date().nullable().optional(),
  effectiveTo: z.string().date().nullable().optional(),
  rightsClass: z.string().min(1),
  reviewedBy: z.string().min(1),
  reviewedAt: z.string().datetime(),
});
const membershipSchema = z.object({
  criterionKey: z.string().min(1),
  playerId: z.string().uuid(),
  relationshipSubtype: z.string().min(1),
  effectiveFrom: z.string().date().nullable().optional(),
  effectiveTo: z.string().date().nullable().optional(),
  verifiedBy: z.string().min(1),
  reviewedAt: z.string().datetime(),
  evidence: z.array(evidenceSchema).min(1),
});
const aliasSchema = z.object({
  playerId: z.string().uuid(),
  alias: z.string().min(1).max(160),
  normalizedAlias: z.string().min(1).max(160),
  locale: z.enum(['en', 'ka', 'translit']),
  aliasType: z.enum([
    'full_name', 'given_name', 'family_name', 'reordered', 'compound_surname',
    'mononym', 'nickname', 'accentless', 'georgian', 'transliteration', 'reviewed_misspelling',
  ]),
  acceptancePolicy: z.enum(['exact', 'unique_only', 'safe_typo']),
  reviewedBy: z.string().min(1),
  reviewedAt: z.string().datetime(),
});
const boardTheme = z.enum([
  'european', 'england', 'italy', 'spain', 'france', 'germany', 'georgia',
  'netherlands', 'brazil', 'turkey', 'argentina',
]);
const boardSchema = z.object({
  key: z.string().min(1),
  version: z.number().int().positive(),
  theme: boardTheme.default('european'),
  rowCriteria: z.tuple([z.string(), z.string(), z.string()]),
  columnCriteria: z.tuple([z.string(), z.string(), z.string()]),
  difficulty,
  familiarityScore: z.number().min(0).max(100),
  approvedBy: z.string().min(1),
  cells: z.array(z.object({
    // European-mix generation still targets ≥9 answers per cell; themed league
    // packs run with a ≥3 floor (small pools), so the schema floor is 3.
    playerIds: z.array(z.string().uuid()).min(3),
    recognizablePlayerIds: z.array(z.string().uuid()).min(2),
  })).length(9),
});
export const manifestSchema = z.object({
  release: z.object({
    version: z.number().int().positive(),
    aliasVersion: z.number().int().positive(),
    resolverPolicyVersion: z.number().int().positive(),
    relationshipSnapshot: z.record(z.unknown()),
    approvedBy: z.string().min(1),
    approvedAt: z.string().datetime(),
  }),
  sources: z.array(sourceSchema).min(1),
  assetCatalog: z.array(z.string().min(1)).default([]),
  players: z.array(z.object({
    id: z.string().uuid(),
    nameEn: z.string().min(1),
    nameKa: z.string().min(1),
    imageAssetKey: z.string().min(1),
  })).default([]),
  criteria: z.array(criterionSchema).min(6),
  memberships: z.array(membershipSchema).min(1),
  aliases: z.array(aliasSchema).min(1),
  boards: z.array(boardSchema).default([]),
});

export type Manifest = z.infer<typeof manifestSchema>;

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stable(nested)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function checksum(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex');
}

function toCriterionView(criterion: Manifest['criteria'][number], id: string): FootballGridCriterionView {
  return {
    id,
    key: criterion.key,
    family: criterion.family,
    labelEn: criterion.labelEn,
    labelKa: criterion.labelKa,
    assetKey: criterion.assetKey ?? null,
    difficulty: criterion.difficulty,
  };
}

export function validateManifest(manifest: Manifest, launch: boolean): { boards: FootballGridBoardCandidate[]; errors: string[] } {
  const errors: string[] = [];
  const criteria = new Map(manifest.criteria.map((criterion) => [criterion.key, criterion]));
  if (criteria.size !== manifest.criteria.length) errors.push('Criteria keys must be unique');
  const sourceKeys = new Set(manifest.sources.map((source) => source.key));
  if (sourceKeys.size !== manifest.sources.length) errors.push('Source keys must be unique');
  const assetKeys = new Set(manifest.assetCatalog);
  if (assetKeys.size !== manifest.assetCatalog.length) errors.push('Asset catalog keys must be unique');
  if (launch) {
    for (const criterion of manifest.criteria) {
      if (!criterion.assetKey) errors.push(`Criterion ${criterion.key} has no launch asset key`);
      else if (!assetKeys.has(criterion.assetKey)) errors.push(`Criterion ${criterion.key} references missing asset ${criterion.assetKey}`);
    }
    const playerAssets = new Map(manifest.players.map((player) => [player.id, player]));
    const usedPlayerIds = new Set(manifest.boards.flatMap((board) =>
      board.cells.flatMap((cell) => cell.playerIds)));
    for (const playerId of usedPlayerIds) {
      const player = playerAssets.get(playerId);
      if (!player) errors.push(`Launch player ${playerId} has no reviewed display/image record`);
      else if (!assetKeys.has(player.imageAssetKey)) {
        errors.push(`Launch player ${playerId} references missing image asset ${player.imageAssetKey}`);
      }
    }
  }
  const membership = new Map<string, Set<string>>();
  for (const row of manifest.memberships) {
    if (!criteria.has(row.criterionKey)) errors.push(`Membership references missing criterion ${row.criterionKey}`);
    for (const evidence of row.evidence) {
      if (!sourceKeys.has(evidence.sourceKey)) {
        errors.push(`Membership ${row.criterionKey}/${row.playerId} references missing source ${evidence.sourceKey}`);
      }
    }
    const players = membership.get(row.criterionKey) ?? new Set<string>();
    players.add(row.playerId);
    membership.set(row.criterionKey, players);
  }
  const boards: FootballGridBoardCandidate[] = manifest.boards.map((board) => {
    if (launch && board.approvedBy.trim().toUpperCase() === 'UNREVIEWED') {
      errors.push(`${board.key}: board is not explicitly approved`);
    }
    const rowCriteria = board.rowCriteria.map((key) => criteria.get(key));
    const columnCriteria = board.columnCriteria.map((key) => criteria.get(key));
    if (rowCriteria.some((criterion) => !criterion) || columnCriteria.some((criterion) => !criterion)) {
      errors.push(`${board.key}: references a missing criterion`);
    }
    board.cells.forEach((cell, index) => {
      const rowKey = board.rowCriteria[Math.floor(index / 3)];
      const columnKey = board.columnCriteria[index % 3];
      for (const playerId of cell.playerIds) {
        if (!membership.get(rowKey)?.has(playerId) || !membership.get(columnKey)?.has(playerId)) {
          errors.push(`${board.key} cell ${index}: ${playerId} lacks both criterion memberships`);
        }
      }
    });
    const rowViews = rowCriteria.map((criterion, index) => toCriterionView(
      criterion ?? manifest.criteria[0], `criterion:${board.rowCriteria[index]}`,
    )) as FootballGridBoardCandidate['rows'];
    const columnViews = columnCriteria.map((criterion, index) => toCriterionView(
      criterion ?? manifest.criteria[0], `criterion:${board.columnCriteria[index]}`,
    )) as FootballGridBoardCandidate['columns'];
    return {
      boardId: board.key,
      releaseId: String(manifest.release.version),
      version: board.version,
      checksum: canonicalFootballGridBoardChecksum(board.rowCriteria, board.columnCriteria),
      difficulty: board.difficulty,
      theme: board.theme ?? 'european',
      rows: rowViews,
      columns: columnViews,
      cells: board.cells,
    };
  });
  const exactEnglish = new Set(manifest.aliases.filter((alias) => alias.locale === 'en' && alias.acceptancePolicy === 'exact').map((alias) => alias.playerId));
  const exactGeorgian = new Set(manifest.aliases.filter((alias) => alias.locale === 'ka' && alias.acceptancePolicy === 'exact').map((alias) => alias.playerId));
  for (const alias of manifest.aliases) {
    if (normalizeFootballGridAnswer(alias.alias) !== alias.normalizedAlias) {
      errors.push(`Alias ${alias.alias}/${alias.playerId} has a non-canonical normalized value`);
    }
  }
  errors.push(...validateFootballGridRelease({ boards, exactEnglishPlayerIds: exactEnglish, exactGeorgianPlayerIds: exactGeorgian }).errors);
  if (launch && boards.length < 500) errors.push(`Launch release has ${boards.length} boards; at least 500 are required`);
  if (new Set(boards.map((board) => board.checksum)).size !== boards.length) errors.push('Release contains duplicate canonical board families');
  return { boards, errors: [...new Set(errors)] };
}

function combinations<T>(values: T[], count: number): T[][] {
  const result: T[][] = [];
  const visit = (start: number, chosen: T[]) => {
    if (chosen.length === count) {
      result.push([...chosen]);
      return;
    }
    for (let index = start; index <= values.length - (count - chosen.length); index += 1) {
      chosen.push(values[index]);
      visit(index + 1, chosen);
      chosen.pop();
    }
  };
  visit(0, []);
  return result;
}

function intersect(left: Set<string>, right: Set<string>): string[] {
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  return [...small].filter((value) => large.has(value)).sort((a, b) => a.localeCompare(b));
}

function generatedDifficulty(criteria: Manifest['criteria']): 'easy' | 'normal' | 'hard' {
  const hard = criteria.filter((criterion) => criterion.difficulty === 'hard').length;
  const normal = criteria.filter((criterion) => criterion.difficulty === 'normal').length;
  if (hard >= 2) return 'hard';
  if (hard === 1 || normal >= 3) return 'normal';
  return 'easy';
}

export function generateCandidateBoards(manifest: Manifest, limit: number, minAnswersPerCell = 9): Manifest['boards'] {
  const memberships = new Map<string, Set<string>>();
  for (const row of manifest.memberships) {
    const values = memberships.get(row.criterionKey) ?? new Set<string>();
    values.add(row.playerId);
    memberships.set(row.criterionKey, values);
  }
  const aliasCovered = new Set(
    manifest.aliases
      .filter((alias) => alias.acceptancePolicy === 'exact' && (alias.locale === 'en' || alias.locale === 'ka'))
      .map((alias) => playerLocaleKey(alias.playerId, alias.locale)),
  );
  const hasLaunchAliases = (playerId: string) =>
    aliasCovered.has(playerLocaleKey(playerId, 'en')) && aliasCovered.has(playerLocaleKey(playerId, 'ka'));
  const criteria = [...manifest.criteria].sort((a, b) => a.key.localeCompare(b.key));
  const byKey = new Map(criteria.map((criterion) => [criterion.key, criterion]));
  const neighbors = new Map<string, Set<string>>();
  for (const left of criteria) {
    const compatible = new Set<string>();
    for (const right of criteria) {
      if (left.key === right.key) continue;
      if (intersect(memberships.get(left.key) ?? new Set(), memberships.get(right.key) ?? new Set()).length >= minAnswersPerCell) {
        compatible.add(right.key);
      }
    }
    neighbors.set(left.key, compatible);
  }
  const buckets: Record<'easy' | 'normal' | 'hard', Manifest['boards']> = { easy: [], normal: [], hard: [] };
  const seen = new Set<string>();
  const maximumCandidates = Math.max(limit * 20, limit);
  outer: for (const rowCriteria of combinations(criteria, 3)) {
    if (rowCriteria.filter((criterion) => criterion.difficulty === 'hard').length > 1) continue;
    const columnKeys = criteria
      .map((criterion) => criterion.key)
      .filter((key) => !rowCriteria.some((criterion) => criterion.key === key))
      .filter((key) => rowCriteria.every((criterion) => neighbors.get(criterion.key)?.has(key)));
    for (const candidateColumnKeys of combinations(columnKeys, 3)) {
      const columnCriteria = candidateColumnKeys.map((key) => byKey.get(key)!);
      if (columnCriteria.filter((criterion) => criterion.difficulty === 'hard').length > 1) continue;
      const rowKeys = rowCriteria.map((criterion) => criterion.key) as [string, string, string];
      const columns = candidateColumnKeys as [string, string, string];
      const boardChecksum = canonicalFootballGridBoardChecksum(rowKeys, columns);
      if (seen.has(boardChecksum)) continue;
      const cells = rowKeys.flatMap((rowKey) => columns.map((columnKey) => {
        const playerIds = intersect(memberships.get(rowKey) ?? new Set(), memberships.get(columnKey) ?? new Set());
        return {
          playerIds,
          recognizablePlayerIds: playerIds.filter(hasLaunchAliases).slice(0, 2),
        };
      }));
      if (cells.some((cell) => cell.playerIds.length < minAnswersPerCell || cell.recognizablePlayerIds.length < 2)) continue;
      seen.add(boardChecksum);
      const allCriteria = [...rowCriteria, ...columnCriteria];
      const difficulty = generatedDifficulty(allCriteria);
      buckets[difficulty].push({
        key: `grid-${boardChecksum.slice(0, 16)}`,
        version: 1,
        rowCriteria: rowKeys,
        columnCriteria: columns,
        difficulty,
        familiarityScore: allCriteria.reduce((sum, criterion) => sum + criterion.familiarityScore, 0) / 6,
        approvedBy: 'UNREVIEWED',
        cells,
      });
      if (seen.size >= maximumCandidates) break outer;
    }
  }
  const target = {
    easy: Math.round(limit * 0.25),
    normal: Math.round(limit * 0.60),
    hard: limit - Math.round(limit * 0.25) - Math.round(limit * 0.60),
  };
  const selected = (Object.keys(target) as Array<keyof typeof target>)
    .flatMap((difficulty) => buckets[difficulty].slice(0, target[difficulty]));
  if (selected.length < limit) {
    const selectedKeys = new Set(selected.map((board) => board.key));
    const remainder = [...buckets.easy, ...buckets.normal, ...buckets.hard]
      .filter((board) => !selectedKeys.has(board.key))
      .slice(0, limit - selected.length);
    selected.push(...remainder);
  }
  return selected;
}

function playerLocaleKey(playerId: string, locale: 'en' | 'ka'): string {
  return `${playerId}:${locale}`;
}


// ---------------------------------------------------------------------------
// Teammate relabel (owner report 2026-09-20: "Played with X" reads as national
// team; the criterion is club-season overlap only). A label-only release is a
// TRANSFORM of a pinned served release, never a regeneration: memberships,
// evidence, aliases, boards, cells and samples must be byte-identical.
// ---------------------------------------------------------------------------
export const TEAMMATE_LABEL = {
  legacyEn: /^Played with (.+)$/,
  legacyKa: /^ითამაშა (.+)-სთან ერთად$/,
  en: (name: string) => `Club teammate of ${name}`,
  ka: (name: string) => `ერთ კლუბში ითამაშა ${name}-სთან`,
  es: (name: string) => `Compañero de club de ${name}`,
  tr: (name: string) => `${name} ile aynı kulüpte oynadı`,
} as const;

/** Everything in a manifest that must survive a label-only transform unchanged. */
export function manifestContentDigest(manifest: Manifest): string {
  return checksum({
    sources: manifest.sources,
    assetCatalog: manifest.assetCatalog,
    players: manifest.players,
    criteria: manifest.criteria.map(({ labelEn: _en, labelKa: _ka, ...rest }) => rest),
    memberships: manifest.memberships,
    aliases: manifest.aliases,
    boards: manifest.boards,
    aliasVersion: manifest.release.aliasVersion,
    resolverPolicyVersion: manifest.release.resolverPolicyVersion,
  });
}

export type AssetOriginRewrite = { from: string; to: string };

/** Rewrite the storage origin of every URL asset key (portrait mirror to another project). */
function rewriteAssetOrigin(manifest: Manifest, rewrite: AssetOriginRewrite): { manifest: Manifest; rewritten: number } {
  const from = rewrite.from.replace(/\/+$/, '');
  const to = rewrite.to.replace(/\/+$/, '');
  if (!/^https:\/\/[a-z]{20}\.supabase\.co$/.test(from) || !/^https:\/\/[a-z]{20}\.supabase\.co$/.test(to) || from === to) {
    throw new Error('Asset origin rewrite needs two different https://<ref>.supabase.co origins');
  }
  let rewritten = 0;
  const swap = (key: string) => {
    if (!key.startsWith(`${from}/`)) return key;
    rewritten += 1;
    return `${to}${key.slice(from.length)}`;
  };
  const next: Manifest = {
    ...manifest,
    assetCatalog: [...new Set(manifest.assetCatalog.map(swap))].sort(),
    players: manifest.players.map((player) => ({ ...player, imageAssetKey: swap(player.imageAssetKey) })),
    criteria: manifest.criteria.map((criterion) => (criterion.assetKey ? { ...criterion, assetKey: swap(criterion.assetKey) } : criterion)),
  };
  return { manifest: next, rewritten };
}

export function relabelTeammateCriteria(
  manifest: Manifest,
  release: { version: number; approvedBy: string; approvedAt: string; assetOrigin?: AssetOriginRewrite },
): { manifest: Manifest; relabelled: number; skipped: string[]; rewritten: number } {
  if (release.version <= manifest.release.version) {
    throw new Error(`New release version ${release.version} must exceed source ${manifest.release.version}`);
  }
  const skipped: string[] = [];
  let relabelled = 0;
  const criteria = manifest.criteria.map((criterion) => {
    if (criterion.family !== 'teammate') return criterion;
    const en = criterion.labelEn.match(TEAMMATE_LABEL.legacyEn);
    const ka = criterion.labelKa.match(TEAMMATE_LABEL.legacyKa);
    if (!en || !ka) {
      skipped.push(`${criterion.key} (${criterion.labelEn} / ${criterion.labelKa})`);
      return criterion;
    }
    relabelled += 1;
    return { ...criterion, labelEn: TEAMMATE_LABEL.en(en[1]), labelKa: TEAMMATE_LABEL.ka(ka[1]) };
  });
  const next: Manifest = {
    ...manifest,
    release: {
      ...manifest.release,
      version: release.version,
      approvedBy: release.approvedBy,
      approvedAt: release.approvedAt,
      relationshipSnapshot: {
        ...manifest.release.relationshipSnapshot,
        transformedFromVersion: manifest.release.version,
        transform: 'teammate-relabel-v1',
      },
    },
    criteria,
  };
  if (manifestContentDigest(next) !== manifestContentDigest(manifest)) {
    throw new Error('Label transform changed non-label content');
  }
  if (!release.assetOrigin) return { manifest: next, relabelled, skipped, rewritten: 0 };
  // The origin rewrite is the only content change allowed on top of the
  // relabel; it is recorded so the waiver can recompute it from the source.
  const moved = rewriteAssetOrigin(next, release.assetOrigin);
  moved.manifest.release.relationshipSnapshot = {
    ...moved.manifest.release.relationshipSnapshot,
    assetOriginRewrite: { from: release.assetOrigin.from.replace(/\/+$/, ''), to: release.assetOrigin.to.replace(/\/+$/, '') },
  };
  return { manifest: moved.manifest, relabelled, skipped, rewritten: moved.rewritten };
}

type ExportedRelease = {
  id: string; version: number; alias_version: number; resolver_policy_version: number;
  relationship_snapshot: Record<string, unknown>; approved_by: string; approved_at: string;
  manifest_checksum: string; status: string;
};

/**
 * Rebuild a manifest from a release already in the database. Board keys are
 * not stored, so they are derived from the canonical board checksum; every
 * other field round-trips from the tables `publish` wrote.
 */
type ExportedBoardRow = {
  id: string; version: number; difficulty: 'easy' | 'normal' | 'hard'; familiarity_score: string;
  canonical_checksum: string; approved_by: string; theme: string;
  rowCriteria: [string, string, string]; columnCriteria: [string, string, string];
};
export type ExportedAnswerRow = {
  board_id: string; cell_index: number; football_player_id: string; player_name_en: string | null;
  player_name_ka: string | null; image_asset_key: string | null; recognizable_rank: number | null; is_sample: boolean;
};

/** The generator writes second-precision UTC timestamps; keep that form so hashes reproduce. */
function isoSeconds(value: string): string {
  return new Date(value).toISOString().replace(/\.000Z$/, 'Z');
}

/**
 * Evidence exactly as `publish` will hash it. Releases were generated with
 * second-precision timestamps, but some rows of the 2026-08 themed packs were
 * hashed with milliseconds; the form that reproduces the stored checksum wins,
 * and no form reproducing it is an error.
 */
function projectEvidence(item: {
  sourceKey: string; source_locator: string; captured_fact: string; effective_from: string | null; effective_to: string | null;
  rights_class: string; reviewed_by: string; reviewed_at: string; evidence_checksum: string;
}): Manifest['memberships'][number]['evidence'][number] {
  const base = {
    sourceKey: item.sourceKey, sourceLocator: item.source_locator, capturedFact: item.captured_fact,
    effectiveFrom: item.effective_from, effectiveTo: item.effective_to,
    rightsClass: item.rights_class, reviewedBy: item.reviewed_by,
  };
  for (const reviewedAt of [isoSeconds(item.reviewed_at), new Date(item.reviewed_at).toISOString()]) {
    const projected = { ...base, reviewedAt };
    if (checksum(projected) === item.evidence_checksum) return projected;
  }
  throw new Error(`Evidence ${item.source_locator} does not reproduce stored checksum ${item.evidence_checksum}`);
}

/**
 * Turn stored boards + answer rows back into manifest boards and players.
 * The manifest holds one display record per player and contiguous sample
 * ranks per cell, so anything the stored rows encode beyond that is rejected
 * instead of being silently normalised away.
 */
export function projectExportedBoards(
  boardRows: ExportedBoardRow[],
  answerRows: ExportedAnswerRow[],
): { boards: Manifest['boards']; players: Manifest['players'] } {
  const answersByBoard = new Map<string, ExportedAnswerRow[]>();
  const players = new Map<string, Manifest['players'][number]>();
  for (const row of answerRows) {
    const list: ExportedAnswerRow[] = answersByBoard.get(row.board_id) ?? [];
    list.push(row);
    answersByBoard.set(row.board_id, list);
    if (row.is_sample !== (row.recognizable_rank !== null)) {
      throw new Error(`Board ${row.board_id} cell ${row.cell_index}: sample flag and recognizable rank disagree for ${row.football_player_id}`);
    }
    if (!row.player_name_en || !row.player_name_ka || !row.image_asset_key) {
      throw new Error(`Board ${row.board_id} cell ${row.cell_index}: ${row.football_player_id} has an incomplete display record`);
    }
    const display = { id: row.football_player_id, nameEn: row.player_name_en, nameKa: row.player_name_ka, imageAssetKey: row.image_asset_key };
    const known = players.get(row.football_player_id);
    if (known && (known.nameEn !== display.nameEn || known.nameKa !== display.nameKa || known.imageAssetKey !== display.imageAssetKey)) {
      throw new Error(`Player ${row.football_player_id}: answer rows carry different display records; the manifest cannot represent that`);
    }
    if (!known) players.set(row.football_player_id, display);
  }
  const boards: Manifest['boards'] = boardRows.map((row) => {
    const answers = answersByBoard.get(row.id) ?? [];
    const cells = Array.from({ length: 9 }, (_, cellIndex) => {
      const cellAnswers = answers.filter((answer) => answer.cell_index === cellIndex);
      const samples = cellAnswers.filter((answer) => answer.is_sample)
        .sort((a, b) => (a.recognizable_rank ?? 0) - (b.recognizable_rank ?? 0));
      samples.forEach((sample, index) => {
        if (sample.recognizable_rank !== index + 1) {
          throw new Error(`Board ${row.id} cell ${cellIndex}: sample ranks are not 1..${samples.length}`);
        }
      });
      return {
        playerIds: cellAnswers.map((answer) => answer.football_player_id),
        recognizablePlayerIds: samples.map((answer) => answer.football_player_id),
      };
    });
    return {
      key: `board:${row.canonical_checksum}`, version: row.version,
      theme: row.theme as Manifest['boards'][number]['theme'], rowCriteria: row.rowCriteria, columnCriteria: row.columnCriteria,
      difficulty: row.difficulty, familiarityScore: Number(row.familiarity_score), approvedBy: row.approved_by, cells,
    };
  });
  return { boards, players: [...players.values()].sort((a, b) => a.id.localeCompare(b.id)) };
}

type Db = typeof sql;
const EXPORT_BOARD_PAGE = 200;
const ASSET_FETCH_CONCURRENCY = 12;

export async function exportRelease(version: number): Promise<{ manifest: Manifest; release: ExportedRelease }> {
  // One snapshot for every read, so aliases, answers and boards cannot come
  // from different database states.
  // postgres.js types TransactionSql via Omit<>, which loses the tagged-template call signature.
  return sql.begin('isolation level repeatable read read only', (tx) => exportReleaseWithin(tx as unknown as typeof sql, version));
}

async function exportReleaseWithin(sql: Db, version: number): Promise<{ manifest: Manifest; release: ExportedRelease }> {
  const releases = await sql<ExportedRelease[]>`
    SELECT id, version, alias_version, resolver_policy_version, relationship_snapshot,
           approved_by, approved_at::text AS approved_at, manifest_checksum, status
      FROM football_grid_content_releases WHERE version = ${version}`;
  const release = releases[0];
  if (!release) throw new Error(`Release ${version} not found`);
  const criteriaRows = await sql<Array<{
    id: string; criterion_key: string; family: Manifest['criteria'][number]['family']; subtype: string;
    label_en: string; label_ka: string; asset_key: string | null; metadata: Record<string, unknown>;
    difficulty: 'easy' | 'normal' | 'hard'; familiarity_score: string;
  }>>`SELECT id, criterion_key, family, subtype, label_en, label_ka, asset_key, metadata, difficulty, familiarity_score
        FROM football_grid_criteria WHERE release_id = ${release.id} ORDER BY criterion_key`;
  const keyById = new Map(criteriaRows.map((row) => [row.id, row.criterion_key]));
  const sourceRows = await sql<Array<{
    id: string; source_key: string; provider_name: string; dataset_version: string; permitted_use: string;
    attribution_requirements: string | null; retention_requirements: string | null; approval_owner: string; approved_at: string;
  }>>`SELECT DISTINCT s.id, s.source_key, s.provider_name, s.dataset_version, s.permitted_use,
             s.attribution_requirements, s.retention_requirements, s.approval_owner, s.approved_at::text AS approved_at
        FROM football_grid_data_sources s
        JOIN football_grid_membership_evidence e ON e.source_id = s.id
        JOIN football_grid_criterion_memberships m ON m.id = e.membership_id
       WHERE m.release_id = ${release.id} ORDER BY s.source_key`;
  const sourceKeyById = new Map(sourceRows.map((row) => [row.id, row.source_key]));
  const membershipRows = await sql<Array<{
    id: string; criterion_id: string; football_player_id: string; relationship_subtype: string;
    effective_from: string | null; effective_to: string | null; verified_by: string; reviewed_at: string;
  }>>`SELECT id, criterion_id, football_player_id, relationship_subtype, effective_from::text AS effective_from,
             effective_to::text AS effective_to, verified_by, reviewed_at::text AS reviewed_at
        FROM football_grid_criterion_memberships WHERE release_id = ${release.id}
       ORDER BY criterion_id, football_player_id`;
  type EvidenceRow = {
    membership_id: string; source_id: string; source_locator: string; captured_fact: string;
    effective_from: string | null; effective_to: string | null; rights_class: string; reviewed_by: string; reviewed_at: string;
    evidence_checksum: string;
  };
  const evidenceRows = await sql<EvidenceRow[]>`
      SELECT e.membership_id, e.source_id, e.source_locator, e.captured_fact, e.effective_from::text AS effective_from,
             e.effective_to::text AS effective_to, e.rights_class, e.reviewed_by, e.reviewed_at::text AS reviewed_at, e.evidence_checksum
        FROM football_grid_membership_evidence e
        JOIN football_grid_criterion_memberships m ON m.id = e.membership_id
       WHERE m.release_id = ${release.id} ORDER BY e.membership_id, e.source_locator`;
  const evidenceByMembership = new Map<string, EvidenceRow[]>();
  for (const row of evidenceRows) {
    const list: EvidenceRow[] = evidenceByMembership.get(row.membership_id) ?? [];
    list.push(row);
    evidenceByMembership.set(row.membership_id, list);
  }
  const aliasRows = await sql<Array<{
    football_player_id: string; alias: string; normalized_alias: string; locale: 'en' | 'ka' | 'translit';
    alias_type: Manifest['aliases'][number]['aliasType']; acceptance_policy: 'exact' | 'unique_only' | 'safe_typo';
    reviewed_by: string; reviewed_at: string;
  }>>`SELECT football_player_id, alias, normalized_alias, locale, alias_type, acceptance_policy, reviewed_by, reviewed_at::text AS reviewed_at
        FROM football_grid_player_aliases WHERE release_id = ${release.id}
       ORDER BY football_player_id, locale, alias`;
  const boardRows = await sql<Array<{
    id: string; version: number; row_criteria: string[]; column_criteria: string[]; difficulty: 'easy' | 'normal' | 'hard';
    familiarity_score: string; canonical_checksum: string; approved_by: string; theme: string;
  }>>`SELECT id, version, row_criteria, column_criteria, difficulty, familiarity_score, canonical_checksum, approved_by, theme
        FROM football_grid_boards WHERE release_id = ${release.id} ORDER BY canonical_checksum`;
  // Paged per board chunk: the whole answer set (~400k rows) does not reliably
  // finish inside the pool's 30 s statement timeout.
  const answerRows: ExportedAnswerRow[] = [];
  for (let offset = 0; offset < boardRows.length; offset += EXPORT_BOARD_PAGE) {
    const boardIds = boardRows.slice(offset, offset + EXPORT_BOARD_PAGE).map((row) => row.id);
    answerRows.push(...await sql<ExportedAnswerRow[]>`
      SELECT board_id, cell_index, football_player_id, player_name_en, player_name_ka, image_asset_key, recognizable_rank, is_sample
        FROM football_grid_board_answers
       WHERE release_id = ${release.id} AND board_id = ANY(${boardIds}::uuid[])
       ORDER BY board_id, cell_index, recognizable_rank NULLS LAST, football_player_id`);
  }
  const criteria: Manifest['criteria'] = criteriaRows.map((row) => ({
    key: row.criterion_key, family: row.family, subtype: row.subtype, labelEn: row.label_en, labelKa: row.label_ka,
    assetKey: row.asset_key, metadata: row.metadata ?? {}, difficulty: row.difficulty, familiarityScore: Number(row.familiarity_score),
  }));
  let evidenceTotal = 0;
  const memberships: Manifest['memberships'] = membershipRows.map((row) => {
    const evidence = (evidenceByMembership.get(row.id) ?? []).map((item) => {
      evidenceTotal += 1;
      try {
        return projectEvidence({ ...item, sourceKey: sourceKeyById.get(item.source_id) ?? '' });
      } catch (error) {
        throw new Error(`Membership ${row.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    if (evidence.length === 0) throw new Error(`Membership ${row.id} has no evidence rows`);
    // publish re-derives evidence_checksum from the projected object; two stored
    // rows that collapse onto one projection would violate the uniqueness key.
    const seen = new Set<string>();
    for (const item of evidence) {
      const key = `${item.sourceKey}:${checksum(item)}`;
      if (seen.has(key)) throw new Error(`Membership ${row.id}: evidence rows collapse onto one checksum after export`);
      seen.add(key);
    }
    return {
      criterionKey: keyById.get(row.criterion_id) ?? '', playerId: row.football_player_id,
      relationshipSubtype: row.relationship_subtype, effectiveFrom: row.effective_from, effectiveTo: row.effective_to,
      verifiedBy: row.verified_by, reviewedAt: isoSeconds(row.reviewed_at), evidence,
    };
  });
  const { boards, players } = projectExportedBoards(
    boardRows.map((row) => ({
      ...row,
      rowCriteria: row.row_criteria.map((id) => keyById.get(id) ?? '') as [string, string, string],
      columnCriteria: row.column_criteria.map((id) => keyById.get(id) ?? '') as [string, string, string],
    })),
    answerRows,
  );
  const assetCatalog = [...new Set([
    ...criteria.map((criterion) => criterion.assetKey).filter((key): key is string => Boolean(key)),
    ...[...players.values()].map((player) => player.imageAssetKey),
  ])].sort();
  const manifest = manifestSchema.parse({
    release: {
      version: release.version, aliasVersion: release.alias_version, resolverPolicyVersion: release.resolver_policy_version,
      relationshipSnapshot: release.relationship_snapshot ?? {}, approvedBy: release.approved_by,
      approvedAt: isoSeconds(release.approved_at),
    },
    sources: sourceRows.map((row) => ({
      key: row.source_key, providerName: row.provider_name, datasetVersion: row.dataset_version, permittedUse: row.permitted_use,
      databaseRightsStatus: 'approved', attributionRequirements: row.attribution_requirements ?? undefined,
      retentionRequirements: row.retention_requirements ?? undefined, approvalOwner: row.approval_owner,
      approvedAt: isoSeconds(row.approved_at),
    })),
    assetCatalog,
    players,
    criteria, memberships,
    aliases: aliasRows.map((row) => ({
      playerId: row.football_player_id, alias: row.alias, normalizedAlias: row.normalized_alias, locale: row.locale,
      aliasType: row.alias_type, acceptancePolicy: row.acceptance_policy, reviewedBy: row.reviewed_by,
      reviewedAt: isoSeconds(row.reviewed_at),
    })),
    boards,
  });
  // Round-trip guards: the export must describe exactly what the database serves.
  const counts = { criteria: criteriaRows.length, memberships: membershipRows.length, aliases: aliasRows.length, boards: boardRows.length };
  if (manifest.criteria.length !== counts.criteria || manifest.memberships.length !== counts.memberships
    || manifest.aliases.length !== counts.aliases || manifest.boards.length !== counts.boards) {
    throw new Error(`Export count mismatch: ${JSON.stringify(counts)}`);
  }
  for (const [index, board] of manifest.boards.entries()) {
    const expected = boardRows[index].canonical_checksum;
    const actual = canonicalFootballGridBoardChecksum(board.rowCriteria, board.columnCriteria);
    if (expected !== actual) throw new Error(`Board ${board.key}: canonical checksum drifted (${actual})`);
    if (board.cells.some((cell) => cell.playerIds.length === 0)) throw new Error(`Board ${board.key}: empty cell in export`);
  }
  process.stdout.write(`Evidence checksums reproduced: ${evidenceTotal}/${evidenceTotal}\n`);
  return { manifest, release };
}

/**
 * Build the asset registry `activate` needs. Served releases carry three kinds
 * of asset keys: full storage URLs (player portraits mirrored to the project
 * bucket), club/league slugs (SVG crests in the web checkout) and
 * `/assets/football-grid/players/<uuid>.webp` (teammate-anchor portraits from
 * the launch pool). `activate` only checks that every key maps to a file on
 * disk, so URL keys are fetched once into `assetCache` (HEAD-then-GET, reused
 * when present) and the cached path is registered. Fails loudly on anything
 * missing so activation can never proceed with a broken catalogue.
 */
export async function buildAssetRegistry(
  manifest: Manifest,
  options: {
    assetRoot: string; assetCache?: string; playerPool?: string; fetchUrls?: boolean;
    /** Grid CDN base the web resolves `/assets/football-grid/<rel>` against (…/imgs/football-grid/v1). */
    cdnBase?: string;
    /** Registered for keys with no source anywhere; the runtime renders these through its fallback chain today. */
    fallbackFile?: string;
    /** The only keys allowed to take the fallback file; any other unresolved key still fails. */
    fallbackKeys?: Iterable<string>;
  },
): Promise<{ registry: Record<string, string>; fallbacks: string[] }> {
  const registry: Record<string, string> = {};
  const missing: string[] = [];
  const fallbacks: string[] = [];
  const fallbackAllowed = new Set(options.fallbackKeys ?? []);
  const existing = async (file: string) => ((await stat(file).catch(() => null))?.isFile() ? file : null);
  const fetchToCache = async (url: string) => {
    if (!options.assetCache) return null;
    const cached = path.join(options.assetCache, createHash('sha256').update(url).digest('hex').slice(0, 24) + path.extname(new URL(url).pathname));
    const hit = await existing(cached);
    if (hit || options.fetchUrls === false) return hit;
    // A transient network error must not read as "asset missing": only a
    // definite 4xx does; exhausted retries abort the registry build.
    let response: Response | null = null;
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= 4 && !response; attempt += 1) {
      try {
        const candidate = await fetch(url);
        if (candidate.status < 500 && candidate.status !== 429) response = candidate;
        else lastError = new Error(`HTTP ${candidate.status}`);
      } catch (error) {
        lastError = error;
      }
      if (!response) await new Promise((resolve) => setTimeout(resolve, 500 * attempt * attempt));
    }
    if (!response) throw new Error(`Could not fetch ${url} after retries: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
    if (!response.ok) return null;
    await mkdir(options.assetCache, { recursive: true });
    await writeFile(cached, Buffer.from(await response.arrayBuffer()));
    return cached;
  };
  // Slug keys (clubs, leagues, flags, competitions, managers, wildcards) map to
  // `<assetRoot>/assets/football-grid/<folder>/<slug>[-fallback].<ext>`; the
  // real image wins over its fallback when both exist.
  let slugIndexPromise: Promise<Record<string, string>> | null = null;
  const slugIndex = () => (slugIndexPromise ??= buildSlugIndex());
  const buildSlugIndex = async () => {
    const slugs: Record<string, string> = {};
    const base = path.join(options.assetRoot, 'assets', 'football-grid');
    for (const entry of await readdir(base, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue;
      for (const file of (await readdir(path.join(base, entry.name))).sort()) {
        const stem = path.parse(file).name;
        const isFallback = stem.endsWith('-fallback');
        const slug = isFallback ? stem.slice(0, -'-fallback'.length) : stem;
        const current = slugs[slug];
        if (!current || (path.parse(current).name.endsWith('-fallback') && !isFallback)) slugs[slug] = path.join(base, entry.name, file);
      }
    }
    return slugs;
  };
  const resolve = async (key: string) => {
    let found: string | null = null;
    if (/^https?:\/\//.test(key)) {
      if (!options.assetCache) { missing.push(`${key} (URL key; pass --asset-cache)`); return; }
      found = await fetchToCache(key);
    } else if (key.startsWith('/') || key.includes('/')) {
      // `/assets/football-grid/<rel>` and bucket-relative `<rel>` (e.g.
      // `players/unknown.webp`) both resolve to `<cdn-base>/<rel>` at runtime.
      const relative = key.startsWith('/assets/football-grid/') ? key.slice('/assets/football-grid/'.length) : key.startsWith('/') ? null : key;
      const candidates = [key.startsWith('/') ? path.join(options.assetRoot, key) : path.join(options.assetRoot, 'assets', 'football-grid', key)];
      if (options.playerPool) candidates.push(path.join(options.playerPool, path.basename(key)));
      for (const candidate of candidates) { found = await existing(candidate); if (found) break; }
      if (!found && relative && options.cdnBase) found = await fetchToCache(`${options.cdnBase.replace(/\/$/, '')}/${relative}`);
    } else {
      found = (await slugIndex())[key] ?? null;
    }
    if (!found && options.fallbackFile && fallbackAllowed.has(key)) { found = options.fallbackFile; fallbacks.push(key); }
    if (found) registry[key] = found; else missing.push(key);
  };
  // URL keys are fetched with bounded parallelism; local keys are cheap.
  const queue = [...manifest.assetCatalog];
  await Promise.all(Array.from({ length: ASSET_FETCH_CONCURRENCY }, async () => {
    for (let key = queue.shift(); key !== undefined; key = queue.shift()) await resolve(key);
  }));
  if (missing.length > 0) {
    missing.sort();
    throw new Error(`Asset registry incomplete: ${missing.length} of ${manifest.assetCatalog.length} keys unresolved\n${missing.slice(0, 20).join('\n')}`);
  }
  fallbacks.sort();
  return { registry, fallbacks };
}

/**
 * Storage object path (bucket `imgs`) a served asset key resolves to at
 * runtime, or null for keys bundled with the web (slugs) and fallbacks.
 */
export function storageObjectPathForAssetKey(key: string): string | null {
  if (/^https?:\/\//.test(key)) {
    // Object name comes from the pathname only; query/fragment are not part of it.
    const parsed = new URL(key);
    const inBucket = /^[a-z]{20}\.supabase\.co$/.test(parsed.hostname) && parsed.pathname.match(/^\/storage\/v1\/object\/public\/imgs\/(.+)$/);
    return inBucket ? decodeURIComponent(inBucket[1]) : null;
  }
  if (key.startsWith('/assets/football-grid/')) return `football-grid/v1/${key.slice('/assets/football-grid/'.length)}`;
  if (!key.startsWith('/') && key.includes('/')) return `football-grid/v1/${key}`;
  return null;
}

async function readFallbackKeys(file: string | undefined): Promise<string[]> {
  if (!file) return [];
  return (await readFile(file, 'utf8')).split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
}

async function loadManifest(file: string): Promise<Manifest> {
  return manifestSchema.parse(JSON.parse(await readFile(file, 'utf8')));
}

async function loadAndVerifyAssetRegistry(
  manifest: Manifest,
  registryPath: string,
): Promise<Record<string, string>> {
  const registry = z.record(z.string().min(1)).parse(JSON.parse(await readFile(registryPath, 'utf8')));
  const missing: string[] = [];
  for (const assetKey of manifest.assetCatalog) {
    const configuredPath = registry[assetKey];
    if (!configuredPath) {
      missing.push(`${assetKey} (not in registry)`);
      continue;
    }
    const absolutePath = path.isAbsolute(configuredPath)
      ? configuredPath
      : path.resolve(path.dirname(registryPath), configuredPath);
    const file = await stat(absolutePath).catch(() => null);
    if (!file?.isFile()) missing.push(`${assetKey} (${absolutePath} is not a file)`);
  }
  if (missing.length > 0) {
    throw new Error(`Asset verification failed:\n${missing.join('\n')}`);
  }
  return registry;
}

async function publish(manifest: Manifest, transformedFrom: number | null = null): Promise<void> {
  // Publishing is a staging operation. Feasibility content is intentionally
  // invisible to runtime board selection until an independent launch-grade
  // validation and explicit activation succeeds.
  const validation = validateManifest(manifest, false);
  let errors = validation.errors;
  if (transformedFrom !== null) errors = await withoutInheritedFindings(manifest, errors, transformedFrom, false);
  if (errors.length > 0) throw new Error(`Content validation failed:\n${errors.join('\n')}`);
  const manifestChecksum = checksum(manifest);
  await sql.begin(async (tx) => {
    const releaseRows = await tx.unsafe<Array<{ id: string }>>(
      `INSERT INTO football_grid_content_releases (
         version, status, relationship_snapshot, alias_version,
         resolver_policy_version, manifest_checksum, approved_by, approved_at
       ) VALUES ($1,'draft',$2::jsonb,$3,$4,$5,$6,$7)
       RETURNING id`,
      [
        manifest.release.version,
        sql.json(manifest.release.relationshipSnapshot),
        manifest.release.aliasVersion,
        manifest.release.resolverPolicyVersion,
        manifestChecksum,
        manifest.release.approvedBy,
        manifest.release.approvedAt,
      ],
    );
    const releaseId = releaseRows[0].id;
    const sourceIds = new Map<string, string>();
    for (const source of manifest.sources) {
      const rows = await tx.unsafe<Array<{ id: string }>>(
        `INSERT INTO football_grid_data_sources (
           source_key, provider_name, dataset_version, permitted_use,
           database_rights_status, attribution_requirements,
           retention_requirements, approval_owner, approved_at
         ) VALUES ($1,$2,$3,$4,'approved',$5,$6,$7,$8)
         ON CONFLICT (source_key, dataset_version) DO NOTHING
         RETURNING id`,
        [
          source.key, source.providerName, source.datasetVersion, source.permittedUse,
          source.attributionRequirements ?? null, source.retentionRequirements ?? null,
          source.approvalOwner, source.approvedAt,
        ],
      );
      const sourceId = rows[0]?.id ?? (await tx.unsafe<Array<{ id: string }>>(
        `SELECT id FROM football_grid_data_sources
          WHERE source_key = $1 AND dataset_version = $2
            AND provider_name IS NOT DISTINCT FROM $3
            AND permitted_use IS NOT DISTINCT FROM $4
            AND database_rights_status = 'approved'
            AND attribution_requirements IS NOT DISTINCT FROM $5
            AND retention_requirements IS NOT DISTINCT FROM $6
            AND approval_owner IS NOT DISTINCT FROM $7
            AND approved_at IS NOT DISTINCT FROM $8::timestamptz`,
        [
          source.key, source.datasetVersion, source.providerName, source.permittedUse,
          source.attributionRequirements ?? null, source.retentionRequirements ?? null,
          source.approvalOwner, source.approvedAt,
        ],
      ))[0]?.id;
      if (!sourceId) {
        throw new Error(`Provenance conflict for ${source.key}/${source.datasetVersion}`);
      }
      sourceIds.set(source.key, sourceId);
    }
    const criterionIds = new Map<string, string>();
    for (const criterion of manifest.criteria) {
      const rows = await tx.unsafe<Array<{ id: string }>>(
        `INSERT INTO football_grid_criteria (
           release_id, criterion_key, family, subtype, label_en, label_ka,
           asset_key, metadata, difficulty, familiarity_score
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10) RETURNING id`,
        [
          releaseId, criterion.key, criterion.family, criterion.subtype,
          criterion.labelEn, criterion.labelKa, criterion.assetKey ?? null,
          sql.json(criterion.metadata), criterion.difficulty, criterion.familiarityScore,
        ],
      );
      criterionIds.set(criterion.key, rows[0].id);
    }
    // Batched: publishing row-by-row over the pooler took hours for ~120k
    // rows; unnest batches land the same content in seconds. Evidence rows
    // are joined back to memberships via the (criterion, player) natural key
    // rather than RETURNING order, which is not contractual.
    const membershipIdByKey = new Map<string, string>();
    const CHUNK = 1_000;
    for (let offset = 0; offset < manifest.memberships.length; offset += CHUNK) {
      const chunk = manifest.memberships.slice(offset, offset + CHUNK);
      const inserted = await tx.unsafe<Array<{ id: string; criterion_id: string; football_player_id: string }>>(
        `INSERT INTO football_grid_criterion_memberships (
           release_id, criterion_id, football_player_id, relationship_subtype,
           effective_from, effective_to, verified_by, reviewed_at
         )
         SELECT $1, * FROM unnest(
           $2::uuid[], $3::uuid[], $4::text[], $5::date[], $6::date[], $7::text[], $8::timestamptz[]
         )
         RETURNING id, criterion_id, football_player_id`,
        [
          releaseId,
          chunk.map((membership) => criterionIds.get(membership.criterionKey)),
          chunk.map((membership) => membership.playerId),
          chunk.map((membership) => membership.relationshipSubtype),
          chunk.map((membership) => membership.effectiveFrom ?? null),
          chunk.map((membership) => membership.effectiveTo ?? null),
          chunk.map((membership) => membership.verifiedBy),
          chunk.map((membership) => membership.reviewedAt),
        ],
      );
      const criterionKeyById = new Map([...criterionIds.entries()].map(([key, id]) => [id, key]));
      for (const row of inserted) {
        membershipIdByKey.set(`${criterionKeyById.get(row.criterion_id)}::${row.football_player_id}`, row.id);
      }
    }
    const evidenceRows = manifest.memberships.flatMap((membership) => membership.evidence.map((evidence) => ({
      membershipId: membershipIdByKey.get(`${membership.criterionKey}::${membership.playerId}`)!,
      evidence,
    })));
    for (let offset = 0; offset < evidenceRows.length; offset += CHUNK) {
      const chunk = evidenceRows.slice(offset, offset + CHUNK);
      await tx.unsafe(
        `INSERT INTO football_grid_membership_evidence (
           membership_id, source_id, source_locator, captured_fact,
           effective_from, effective_to, rights_class, evidence_checksum,
           reviewed_by, reviewed_at
         )
         SELECT * FROM unnest(
           $1::uuid[], $2::uuid[], $3::text[], $4::text[], $5::date[], $6::date[],
           $7::text[], $8::text[], $9::text[], $10::timestamptz[]
         )`,
        [
          chunk.map((row) => row.membershipId),
          chunk.map((row) => sourceIds.get(row.evidence.sourceKey)),
          chunk.map((row) => row.evidence.sourceLocator),
          chunk.map((row) => row.evidence.capturedFact),
          chunk.map((row) => row.evidence.effectiveFrom ?? null),
          chunk.map((row) => row.evidence.effectiveTo ?? null),
          chunk.map((row) => row.evidence.rightsClass),
          chunk.map((row) => checksum(row.evidence)),
          chunk.map((row) => row.evidence.reviewedBy),
          chunk.map((row) => row.evidence.reviewedAt),
        ],
      );
    }
    for (let offset = 0; offset < manifest.aliases.length; offset += CHUNK) {
      const chunk = manifest.aliases.slice(offset, offset + CHUNK);
      await tx.unsafe(
        `INSERT INTO football_grid_player_aliases (
           release_id, football_player_id, alias, normalized_alias, locale,
           alias_type, acceptance_policy, reviewed_by, reviewed_at
         )
         SELECT $1, * FROM unnest(
           $2::uuid[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::timestamptz[]
         )`,
        [
          releaseId,
          chunk.map((alias) => alias.playerId),
          chunk.map((alias) => alias.alias),
          chunk.map((alias) => alias.normalizedAlias),
          chunk.map((alias) => alias.locale),
          chunk.map((alias) => alias.aliasType),
          chunk.map((alias) => alias.acceptancePolicy),
          chunk.map((alias) => alias.reviewedBy),
          chunk.map((alias) => alias.reviewedAt),
        ],
      );
    }
    const playerById = new Map(manifest.players.map((player) => [player.id, player]));
    for (let boardIndex = 0; boardIndex < manifest.boards.length; boardIndex += 1) {
      const board = manifest.boards[boardIndex];
      const candidate = validation.boards[boardIndex];
      const rows = await tx.unsafe<Array<{ id: string }>>(
        `INSERT INTO football_grid_boards (
           release_id, version, row_criteria, column_criteria, difficulty,
           familiarity_score, canonical_checksum, approved_by, published_at, theme
         ) VALUES ($1,$2,$3::uuid[],$4::uuid[],$5,$6,$7,$8,$9,$10) RETURNING id`,
        [
          releaseId, board.version, board.rowCriteria.map((key) => criterionIds.get(key)),
          board.columnCriteria.map((key) => criterionIds.get(key)), board.difficulty,
          board.familiarityScore, candidate.checksum, board.approvedBy, manifest.release.approvedAt,
          board.theme ?? 'european',
        ],
      );
      const answerRows = board.cells.flatMap((cell, cellIndex) => cell.playerIds.map((playerId) => {
        const sampleIndex = cell.recognizablePlayerIds.indexOf(playerId);
        const player = playerById.get(playerId);
        return {
          cellIndex, playerId,
          nameEn: player?.nameEn ?? null, nameKa: player?.nameKa ?? null,
          imageAssetKey: player?.imageAssetKey ?? null,
          rank: sampleIndex >= 0 ? sampleIndex + 1 : null,
          isSample: sampleIndex >= 0,
        };
      }));
      await tx.unsafe(
        `INSERT INTO football_grid_board_answers (
           board_id, release_id, cell_index, football_player_id,
           player_name_en, player_name_ka, image_asset_key,
           recognizable_rank, is_sample
         )
         SELECT $1, $2, u.cell_index, u.player_id, u.name_en, u.name_ka,
                u.image_asset_key, u.rank, u.is_sample::boolean
         FROM unnest(
           $3::int[], $4::uuid[], $5::text[], $6::text[], $7::text[], $8::int[], $9::text[]
         ) AS u(cell_index, player_id, name_en, name_ka, image_asset_key, rank, is_sample)`,
        [
          rows[0].id, releaseId,
          answerRows.map((row) => row.cellIndex),
          answerRows.map((row) => row.playerId),
          answerRows.map((row) => row.nameEn),
          answerRows.map((row) => row.nameKa),
          answerRows.map((row) => row.imageAssetKey),
          answerRows.map((row) => row.rank),
          // postgres.js mis-types JS boolean arrays; send text and let the
          // assignment cast handle it.
          answerRows.map((row) => String(row.isSample)),
        ],
      );
    }
    await tx.unsafe(
      `UPDATE football_grid_content_releases
          SET status = 'feasibility'
        WHERE id = $1 AND status = 'draft'`,
      [releaseId],
    );
  });
  process.stdout.write(`Staged Football Grid release ${manifest.release.version} (${manifest.boards.length} boards, ${manifestChecksum})\n`);
}

/**
 * A label-only transform of served content may carry validator findings its
 * source already has (the 2026-08 themed packs predate the board-distribution
 * rule). Prove the manifest is byte-for-byte the content the source release
 * serves right now, then drop exactly the findings the source produces under
 * the same validator mode. Everything else still blocks.
 */
async function withoutInheritedFindings(manifest: Manifest, errors: string[], transformedFrom: number, launch: boolean): Promise<string[]> {
  const snapshot = manifest.release.relationshipSnapshot as { transformedFromVersion?: number; transform?: string };
  if (snapshot.transformedFromVersion !== transformedFrom || snapshot.transform !== 'teammate-relabel-v1') {
    throw new Error(`Manifest is not a teammate-relabel transform of release ${transformedFrom}`);
  }
  const source = await exportRelease(transformedFrom);
  if (source.release.status !== 'published') throw new Error(`Source release ${transformedFrom} is ${source.release.status}, not published`);
  const sourceManifest = manifestSchema.parse(JSON.parse(JSON.stringify(source.manifest)));
  // Require the manifest to be exactly what transform-labels produces from the
  // served source right now (same version/approval and, if recorded, the same
  // asset-origin rewrite). This covers content, labels and metadata at once.
  const rewrite = (snapshot as { assetOriginRewrite?: AssetOriginRewrite }).assetOriginRewrite;
  const expected = relabelTeammateCriteria(sourceManifest, {
    version: manifest.release.version, approvedBy: manifest.release.approvedBy, approvedAt: manifest.release.approvedAt,
    ...(rewrite ? { assetOrigin: rewrite } : {}),
  });
  if (expected.skipped.length > 0 || checksum(expected.manifest) !== checksum(manifest)) {
    throw new Error(`Manifest is not the teammate relabel of served release ${transformedFrom}: content, labels or metadata differ from the prescribed transform`);
  }
  if (rewrite) process.stdout.write(`Asset origin rewrite verified: ${rewrite.from} -> ${rewrite.to}\n`);
  const inherited = new Set(validateManifest(sourceManifest, launch).errors);
  const waived = errors.filter((error) => inherited.has(error));
  if (waived.length > 0) {
    process.stdout.write(`WARNING: waived ${waived.length} findings already present in served release ${transformedFrom} (--transformed-from)\n`);
  }
  return errors.filter((error) => !inherited.has(error));
}

async function activate(
  manifest: Manifest,
  assetRegistryPath: string,
  allowFallbackAssets = false,
  transformedFrom: number | null = null,
): Promise<void> {
  const validation = validateManifest(manifest, true);
  let errors = validation.errors;
  if (transformedFrom !== null) errors = await withoutInheritedFindings(manifest, errors, transformedFrom, true);
  if (allowFallbackAssets) {
    // Incremental releases add criteria/players whose art intentionally rides
    // the runtime fallback chain (monogram crests, silhouette portraits).
    // Owner-authorized: downgrade ONLY asset-presence findings to warnings;
    // every other launch invariant still blocks.
    const assetError = /references missing (image )?asset|has no launch asset key/;
    const waived = errors.filter((error) => assetError.test(error));
    errors = errors.filter((error) => !assetError.test(error));
    if (waived.length > 0) {
      process.stdout.write(`WARNING: waived ${waived.length} missing-asset findings (--allow-fallback-assets)\n`);
    }
  }
  if (errors.length > 0) throw new Error(`Content activation failed:\n${errors.join('\n')}`);
  await loadAndVerifyAssetRegistry(manifest, assetRegistryPath);
  const manifestChecksum = checksum(manifest);
  const rows = await sql<Array<{ id: string }>>`
    UPDATE football_grid_content_releases
       SET status = 'published', published_at = now()
     WHERE version = ${manifest.release.version}
       AND manifest_checksum = ${manifestChecksum}
       AND status = 'feasibility'
    RETURNING id
  `;
  if (!rows[0]) throw new Error('Matching staged release was not found or is not activatable');
  process.stdout.write(`Activated Football Grid release ${manifest.release.version}\n`);
}

/**
 * Retire a published release whose original manifest file is no longer at
 * hand (the served 2026-08/09 releases). All three identifiers must match the
 * stored row, so a typo cannot retire the wrong release.
 */
async function retireRelease(version: number, releaseId: string, manifestChecksum: string): Promise<void> {
  const rows = await sql<Array<{ id: string }>>`
    UPDATE football_grid_content_releases
       SET status = 'retired'
     WHERE version = ${version}
       AND id = ${releaseId}
       AND manifest_checksum = ${manifestChecksum}
       AND status = 'published'
    RETURNING id
  `;
  if (!rows[0]) throw new Error('No published release matches that version, id and manifest checksum');
  process.stdout.write(`Retired Football Grid release ${version} (${releaseId})\n`);
}

/**
 * A transformed release gets new board ids, so the board-level quarantine
 * state of the source release (e.g. the 494 superseded European boards of
 * v2026082610) must be carried across by canonical checksum or those boards
 * would serve again. Only the *effective* state is copied, using the runtime's
 * own precedence (a disable counts unless a newer enable for the same board
 * exists, and expired rows are ignored); release-level rows are the cutover
 * mechanism and are deliberately not carried. Idempotent: a target board that
 * is already effectively disabled is skipped.
 */
async function transferQuarantines(fromVersion: number, toVersion: number): Promise<void> {
  const rows = await sql<Array<{ id: string }>>`
    WITH effective AS (
      SELECT q.board_id, q.action, q.reason, q.actor, q.expires_at
        FROM football_grid_content_quarantines q
        JOIN football_grid_content_releases sr ON sr.id = q.release_id AND sr.version = ${fromVersion}
       WHERE q.board_id IS NOT NULL
         AND q.action = 'disable'
         AND (q.expires_at IS NULL OR q.expires_at > now())
         AND NOT EXISTS (
           SELECT 1 FROM football_grid_content_quarantines newer
            WHERE newer.release_id = q.release_id
              AND newer.board_id = q.board_id
              AND newer.action = 'enable'
              AND (newer.created_at, newer.id) > (q.created_at, q.id)
         )
    )
    INSERT INTO football_grid_content_quarantines (release_id, board_id, action, reason, actor, expires_at)
    SELECT target.release_id, target.id, 'disable',
           effective.reason || ' (carried from release ' || ${fromVersion}::text || ')', effective.actor, effective.expires_at
      FROM effective
      JOIN football_grid_boards source ON source.id = effective.board_id
      JOIN football_grid_content_releases tr ON tr.version = ${toVersion}
      JOIN football_grid_boards target ON target.release_id = tr.id AND target.canonical_checksum = source.canonical_checksum
     WHERE NOT EXISTS (
       SELECT 1 FROM football_grid_content_quarantines existing
        WHERE existing.release_id = target.release_id
          AND existing.board_id = target.id
          AND existing.action = 'disable'
          AND (existing.expires_at IS NULL OR existing.expires_at > now())
          AND NOT EXISTS (
            SELECT 1 FROM football_grid_content_quarantines newer
             WHERE newer.release_id = existing.release_id
               AND newer.board_id = existing.board_id
               AND newer.action = 'enable'
               AND (newer.created_at, newer.id) > (existing.created_at, existing.id)
          )
     )
    RETURNING id
  `;
  process.stdout.write(`Carried ${rows.length} effective board-level disables from ${fromVersion} to ${toVersion}\n`);
}

async function retire(manifest: Manifest): Promise<void> {
  const rows = await sql<Array<{ id: string }>>`
    UPDATE football_grid_content_releases
       SET status = 'retired'
     WHERE version = ${manifest.release.version}
       AND manifest_checksum = ${checksum(manifest)}
       AND status = 'published'
    RETURNING id
  `;
  if (!rows[0]) throw new Error('Matching active release was not found');
  process.stdout.write(`Retired Football Grid release ${manifest.release.version}\n`);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

async function writeReviewPack(
  manifest: Manifest,
  outputDir: string,
  assetRegistryPath?: string,
): Promise<void> {
  const validation = validateManifest(manifest, false);
  const assetRegistry = assetRegistryPath
    ? await loadAndVerifyAssetRegistry(manifest, assetRegistryPath)
    : {};
  const playerById = new Map(manifest.players.map((player) => [player.id, player]));
  const membershipByCriterionPlayer = new Map(manifest.memberships.map((membership) => [
    `${membership.criterionKey}:${membership.playerId}`,
    membership,
  ]));
  const assetUrl = (assetKey: string): string | null => {
    const configuredPath = assetRegistry[assetKey];
    if (!configuredPath || !assetRegistryPath) return null;
    const absolutePath = path.isAbsolute(configuredPath)
      ? configuredPath
      : path.resolve(path.dirname(assetRegistryPath), configuredPath);
    return pathToFileURL(absolutePath).href;
  };
  await mkdir(outputDir, { recursive: true });
  const csv = ['board_key,difficulty,row_criteria,column_criteria,minimum_answers,valid'];
  const provenanceCsv = [
    'source_key,provider,dataset_version,rights_status,permitted_use,approval_owner,approved_at,attribution,retention',
    ...manifest.sources.map((source) => [
      source.key, source.providerName, source.datasetVersion, source.databaseRightsStatus,
      source.permittedUse, source.approvalOwner, source.approvedAt,
      source.attributionRequirements ?? '', source.retentionRequirements ?? '',
    ].map((value) => `"${String(value).replaceAll('"', '""')}"`).join(',')),
  ];
  for (let index = 0; index < manifest.boards.length; index += 1) {
    const board = manifest.boards[index];
    const errors = validation.errors.filter((error) => error.startsWith(`${board.key}:`));
    csv.push([
      board.key,
      board.difficulty,
      board.rowCriteria.join('|'),
      board.columnCriteria.join('|'),
      Math.min(...board.cells.map((cell) => new Set(cell.playerIds).size)),
      errors.length === 0 ? 'yes' : 'no',
    ].map((value) => `"${String(value).replaceAll('"', '""')}"`).join(','));
  }
  const html = `<!doctype html><meta charset="utf-8"><title>Football Grid review pack</title>
  <style>body{font:14px system-ui;margin:32px;color:#17202a}article{border:1px solid #ccd6dd;border-radius:12px;padding:16px;margin:16px 0}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}.cell{background:#f3f6f8;padding:10px;min-height:150px}.sample{display:flex;gap:8px;align-items:center;margin:8px 0}.sample img{width:42px;height:42px;object-fit:cover;border-radius:50%}.evidence{font-size:11px;color:#475467}.error{color:#b42318}</style>
  <h1>Football Grid release ${manifest.release.version}</h1><p>${manifest.boards.length} boards · manifest ${checksum(manifest)}</p>
  ${validation.errors.length ? `<div class="error"><h2>Validation errors</h2><ul>${validation.errors.map((error) => `<li>${escapeHtml(error)}</li>`).join('')}</ul></div>` : '<p>Validation passed.</p>'}
  ${manifest.boards.map((board) => `<article><h2>${escapeHtml(board.key)} · ${board.difficulty}</h2><p>Rows: ${board.rowCriteria.map(escapeHtml).join(', ')}<br>Columns: ${board.columnCriteria.map(escapeHtml).join(', ')}</p><div class="grid">${board.cells.map((cell, index) => {
    const rowKey = board.rowCriteria[Math.floor(index / 3)];
    const columnKey = board.columnCriteria[index % 3];
    const samples = cell.recognizablePlayerIds.slice(0, 5).map((playerId) => {
      const player = playerById.get(playerId);
      const rowEvidence = membershipByCriterionPlayer.get(`${rowKey}:${playerId}`)?.evidence ?? [];
      const columnEvidence = membershipByCriterionPlayer.get(`${columnKey}:${playerId}`)?.evidence ?? [];
      const imageUrl = player ? assetUrl(player.imageAssetKey) : null;
      return `<div class="sample">${imageUrl ? `<img src="${escapeHtml(imageUrl)}" alt="">` : ''}<div><strong>${escapeHtml(player?.nameEn ?? playerId)}</strong><br><span>${escapeHtml(player?.nameKa ?? 'Missing KA name')}</span><div class="evidence">${[...rowEvidence, ...columnEvidence].map((evidence) => `${escapeHtml(evidence.sourceKey)} · ${escapeHtml(evidence.sourceLocator)} · ${escapeHtml(evidence.capturedFact)}`).join('<br>') || 'Missing cell evidence'}</div></div></div>`;
    }).join('');
    return `<div class="cell"><strong>Cell ${index + 1}: ${escapeHtml(rowKey)} × ${escapeHtml(columnKey)}</strong><br>${cell.playerIds.length} accepted answers · ${cell.recognizablePlayerIds.length} reviewed samples${samples}</div>`;
  }).join('')}</div></article>`).join('')}`;
  await Promise.all([
    writeFile(path.join(outputDir, 'boards.csv'), `${csv.join('\n')}\n`),
    writeFile(path.join(outputDir, 'provenance-rights.csv'), `${provenanceCsv.join('\n')}\n`),
    writeFile(path.join(outputDir, 'index.html'), html),
  ]);
  process.stdout.write(`Review pack written to ${outputDir}\n`);
}

export function optionValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

async function main(): Promise<void> {
  const [command, manifestPath, ...args] = process.argv.slice(2);
  if (!command || !manifestPath) throw new Error('Usage: football-grid-content <generate|validate|review|publish|activate|retire|retire-release|transfer-quarantines|export|transform-labels|build-registry> <manifest.json> [--limit N|--feasibility|--out PATH|--asset-registry PATH]');
  if (command === 'transfer-quarantines') {
    // Usage: transfer-quarantines <from-version> --to <version>
    const fromVersion = Number(manifestPath);
    const toVersion = Number(optionValue(args, '--to'));
    if (!Number.isInteger(fromVersion) || !Number.isInteger(toVersion) || fromVersion <= 0 || toVersion <= fromVersion) {
      throw new Error('transfer-quarantines requires <from-version> --to <newer version>');
    }
    await transferQuarantines(fromVersion, toVersion);
    return;
  }
  if (command === 'retire-release') {
    // Usage: retire-release <version> --release-id <uuid> --manifest-checksum <hex>
    const version = Number(manifestPath);
    if (!Number.isInteger(version) || version <= 0) throw new Error('retire-release requires a positive release version');
    const releaseId = optionValue(args, '--release-id');
    const manifestChecksum = optionValue(args, '--manifest-checksum');
    if (!releaseId || !manifestChecksum) throw new Error('retire-release requires --release-id and --manifest-checksum');
    await retireRelease(version, releaseId, manifestChecksum);
    return;
  }
  if (command === 'export') {
    // Usage: export <version> --out manifest.json [--asset-root <web public dir> --asset-cache <dir> --player-pool <dir>
    //          --cdn-base <…/imgs/football-grid/v1> --fallback-file <svg> --fallback-keys <one key per line> --registry-out asset-registry.json]
    const version = Number(manifestPath);
    if (!Number.isInteger(version) || version <= 0) throw new Error('export requires a positive release version');
    const outputPath = optionValue(args, '--out') ?? `football-grid-release-${version}.json`;
    const { manifest, release } = await exportRelease(version);
    await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
    // Digest of the file as later commands will read it (JSON drops undefined fields).
    const digest = manifestContentDigest(await loadManifest(outputPath));
    process.stdout.write(`Exported release ${version} (${release.status}, ${manifest.criteria.length} criteria, ${manifest.memberships.length} memberships, ${manifest.boards.length} boards, content digest ${digest}) to ${outputPath}\n`);
    const assetRoot = optionValue(args, '--asset-root');
    if (!assetRoot && optionValue(args, '--registry-out')) throw new Error('--registry-out requires --asset-root');
    if (assetRoot) {
      const { registry, fallbacks } = await buildAssetRegistry(manifest, {
        assetRoot,
        assetCache: optionValue(args, '--asset-cache'),
        playerPool: optionValue(args, '--player-pool'),
        cdnBase: optionValue(args, '--cdn-base'),
        fallbackFile: optionValue(args, '--fallback-file'),
        fallbackKeys: await readFallbackKeys(optionValue(args, '--fallback-keys')),
        fetchUrls: !args.includes('--no-fetch'),
      });
      const registryPath = optionValue(args, '--registry-out') ?? `football-grid-release-${version}-assets.json`;
      await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
      process.stdout.write(`Asset registry with ${Object.keys(registry).length} entries at ${registryPath}\n`);
      if (fallbacks.length > 0) {
        process.stdout.write(`WARNING: ${fallbacks.length} allow-listed keys have no source anywhere and were registered to the fallback file:\n${fallbacks.join('\n')}\n`);
      }
    }
    return;
  }
  const manifest = await loadManifest(manifestPath);
  if (command === 'build-registry') {
    // Usage: build-registry <manifest.json> --asset-root DIR [--asset-cache DIR --player-pool DIR --cdn-base URL --fallback-file F --fallback-keys F] --registry-out F
    const assetRoot = optionValue(args, '--asset-root');
    const registryPath = optionValue(args, '--registry-out');
    if (!assetRoot || !registryPath) throw new Error('build-registry requires --asset-root and --registry-out');
    const { registry, fallbacks } = await buildAssetRegistry(manifest, {
      assetRoot,
      assetCache: optionValue(args, '--asset-cache'),
      playerPool: optionValue(args, '--player-pool'),
      cdnBase: optionValue(args, '--cdn-base'),
      fallbackFile: optionValue(args, '--fallback-file'),
      fallbackKeys: await readFallbackKeys(optionValue(args, '--fallback-keys')),
      fetchUrls: !args.includes('--no-fetch'),
    });
    await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
    process.stdout.write(`Asset registry with ${Object.keys(registry).length} entries at ${registryPath}\n`);
    if (fallbacks.length > 0) {
      process.stdout.write(`WARNING: ${fallbacks.length} allow-listed keys have no source anywhere and were registered to the fallback file:\n${fallbacks.join('\n')}\n`);
    }
    return;
  }
  if (command === 'transform-labels') {
    const version = Number(optionValue(args, '--version'));
    if (!Number.isInteger(version) || version <= 0) throw new Error('transform-labels requires --version <new release version>');
    const approvedBy = optionValue(args, '--approved-by');
    if (!approvedBy) throw new Error('transform-labels requires --approved-by <reviewer>');
    const outputPath = optionValue(args, '--out') ?? `football-grid-release-${version}.json`;
    const originFrom = optionValue(args, '--asset-origin-from');
    const originTo = optionValue(args, '--asset-origin-to');
    if (Boolean(originFrom) !== Boolean(originTo)) throw new Error('--asset-origin-from and --asset-origin-to go together');
    const result = relabelTeammateCriteria(manifest, {
      version, approvedBy, approvedAt: new Date().toISOString(),
      ...(originFrom && originTo ? { assetOrigin: { from: originFrom, to: originTo } } : {}),
    });
    if (result.skipped.length > 0) {
      throw new Error(`Refusing: ${result.skipped.length} teammate criteria do not match the legacy label pattern:\n${result.skipped.join('\n')}`);
    }
    await writeFile(outputPath, `${JSON.stringify(result.manifest, null, 2)}\n`);
    process.stdout.write(result.rewritten > 0
      ? `Relabelled ${result.relabelled} teammate criteria and rewrote ${result.rewritten} asset keys to ${result.manifest.release.relationshipSnapshot.assetOriginRewrite && (result.manifest.release.relationshipSnapshot.assetOriginRewrite as AssetOriginRewrite).to}; content digest ${manifestContentDigest(result.manifest)} (source ${manifestContentDigest(manifest)}); wrote ${outputPath}\n`
      : `Relabelled ${result.relabelled} teammate criteria; content digest ${manifestContentDigest(result.manifest)} unchanged from source; wrote ${outputPath}\n`);
    return;
  }
  if (command === 'generate') {
    const limitIndex = args.indexOf('--limit');
    const limit = limitIndex >= 0 ? Number(args[limitIndex + 1]) : 1_000;
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) throw new Error('--limit must be an integer from 1 to 10000');
    const generated = { ...manifest, boards: generateCandidateBoards(manifest, limit) };
    const outputPath = optionValue(args, '--out') ?? 'football-grid-generated-manifest.json';
    await writeFile(outputPath, `${JSON.stringify(generated, null, 2)}\n`);
    process.stdout.write(`Generated ${generated.boards.length} review-required candidate boards at ${outputPath}\n`);
    return;
  }
  if (command === 'validate') {
    const validation = validateManifest(manifest, !args.includes('--feasibility'));
    if (validation.errors.length > 0) throw new Error(validation.errors.join('\n'));
    process.stdout.write(`Football Grid content is valid (${manifest.boards.length} boards)\n`);
    return;
  }
  if (command === 'review') {
    await writeReviewPack(
      manifest,
      optionValue(args, '--out') ?? 'football-grid-review-pack',
      optionValue(args, '--asset-registry'),
    );
    return;
  }
  if (command === 'publish') {
    if (args.includes('--feasibility')) {
      throw new Error('The publish command is always non-playable staging; remove --feasibility');
    }
    const transformedFrom = optionValue(args, '--transformed-from');
    await publish(manifest, transformedFrom ? Number(transformedFrom) : null);
    return;
  }
  if (command === 'activate') {
    const assetRegistry = optionValue(args, '--asset-registry');
    if (!assetRegistry) {
      throw new Error('activate requires --asset-registry PATH so every launch asset is verified on disk');
    }
    const transformedFrom = optionValue(args, '--transformed-from');
    await activate(manifest, assetRegistry, args.includes('--allow-fallback-assets'), transformedFrom ? Number(transformedFrom) : null);
    return;
  }
  if (command === 'retire') {
    await retire(manifest);
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main()
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    })
    .finally(async () => {
      await sql.end({ timeout: 1 }).catch(() => {});
    });
}
