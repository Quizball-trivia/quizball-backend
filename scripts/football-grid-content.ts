import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
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
const boardSchema = z.object({
  key: z.string().min(1),
  version: z.number().int().positive(),
  rowCriteria: z.tuple([z.string(), z.string(), z.string()]),
  columnCriteria: z.tuple([z.string(), z.string(), z.string()]),
  difficulty,
  familiarityScore: z.number().min(0).max(100),
  approvedBy: z.string().min(1),
  cells: z.array(z.object({
    playerIds: z.array(z.string().uuid()).min(9),
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

function checksum(value: unknown): string {
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

export function generateCandidateBoards(manifest: Manifest, limit: number): Manifest['boards'] {
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
      if (intersect(memberships.get(left.key) ?? new Set(), memberships.get(right.key) ?? new Set()).length >= 9) {
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
      if (cells.some((cell) => cell.playerIds.length < 9 || cell.recognizablePlayerIds.length < 2)) continue;
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

async function publish(manifest: Manifest): Promise<void> {
  // Publishing is a staging operation. Feasibility content is intentionally
  // invisible to runtime board selection until an independent launch-grade
  // validation and explicit activation succeeds.
  const validation = validateManifest(manifest, false);
  if (validation.errors.length > 0) throw new Error(`Content validation failed:\n${validation.errors.join('\n')}`);
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
    for (const membership of manifest.memberships) {
      const rows = await tx.unsafe<Array<{ id: string }>>(
        `INSERT INTO football_grid_criterion_memberships (
           release_id, criterion_id, football_player_id, relationship_subtype,
           effective_from, effective_to, verified_by, reviewed_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [
          releaseId, criterionIds.get(membership.criterionKey), membership.playerId,
          membership.relationshipSubtype, membership.effectiveFrom ?? null,
          membership.effectiveTo ?? null, membership.verifiedBy, membership.reviewedAt,
        ],
      );
      for (const evidence of membership.evidence) {
        await tx.unsafe(
          `INSERT INTO football_grid_membership_evidence (
             membership_id, source_id, source_locator, captured_fact,
             effective_from, effective_to, rights_class, evidence_checksum,
             reviewed_by, reviewed_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            rows[0].id, sourceIds.get(evidence.sourceKey), evidence.sourceLocator,
            evidence.capturedFact, evidence.effectiveFrom ?? null, evidence.effectiveTo ?? null,
            evidence.rightsClass, checksum(evidence), evidence.reviewedBy, evidence.reviewedAt,
          ],
        );
      }
    }
    for (const alias of manifest.aliases) {
      await tx.unsafe(
        `INSERT INTO football_grid_player_aliases (
           release_id, football_player_id, alias, normalized_alias, locale,
           alias_type, acceptance_policy, reviewed_by, reviewed_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          releaseId, alias.playerId, alias.alias, alias.normalizedAlias, alias.locale,
          alias.aliasType, alias.acceptancePolicy, alias.reviewedBy, alias.reviewedAt,
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
           familiarity_score, canonical_checksum, approved_by, published_at
         ) VALUES ($1,$2,$3::uuid[],$4::uuid[],$5,$6,$7,$8,$9) RETURNING id`,
        [
          releaseId, board.version, board.rowCriteria.map((key) => criterionIds.get(key)),
          board.columnCriteria.map((key) => criterionIds.get(key)), board.difficulty,
          board.familiarityScore, candidate.checksum, board.approvedBy, manifest.release.approvedAt,
        ],
      );
      for (let cellIndex = 0; cellIndex < board.cells.length; cellIndex += 1) {
        const cell = board.cells[cellIndex];
        for (const playerId of cell.playerIds) {
          const sampleIndex = cell.recognizablePlayerIds.indexOf(playerId);
          const player = playerById.get(playerId);
          await tx.unsafe(
            `INSERT INTO football_grid_board_answers (
               board_id, release_id, cell_index, football_player_id,
               player_name_en, player_name_ka, image_asset_key,
               recognizable_rank, is_sample
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [
              rows[0].id, releaseId, cellIndex, playerId,
              player?.nameEn ?? null, player?.nameKa ?? null, player?.imageAssetKey ?? null,
              sampleIndex >= 0 ? sampleIndex + 1 : null, sampleIndex >= 0,
            ],
          );
        }
      }
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

async function activate(manifest: Manifest, assetRegistryPath: string): Promise<void> {
  const validation = validateManifest(manifest, true);
  if (validation.errors.length > 0) throw new Error(`Content activation failed:\n${validation.errors.join('\n')}`);
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
  if (!command || !manifestPath) throw new Error('Usage: football-grid-content <generate|validate|review|publish|activate|retire> <manifest.json> [--limit N|--feasibility|--out PATH|--asset-registry PATH]');
  const manifest = await loadManifest(manifestPath);
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
    await publish(manifest);
    return;
  }
  if (command === 'activate') {
    const assetRegistry = optionValue(args, '--asset-registry');
    if (!assetRegistry) {
      throw new Error('activate requires --asset-registry PATH so every launch asset is verified on disk');
    }
    await activate(manifest, assetRegistry);
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
