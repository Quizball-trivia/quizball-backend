/** Offline only: creates a review draft, never connects to or updates a database. */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type { Manifest } from './football-grid-content.js';
import { normalizeFootballGridAnswer } from '../src/modules/football-grid/football-grid.answer-resolver.js';

export const CORRECTION_SOURCE = 'official-football-answer-review-20260921';
export const CONFIRMED_FACTS = [
  {
    playerId: '662e7c41-0436-4be0-a5dc-8b3fabe93ecf', nameEn: 'Thierry Henry',
    criteria: ['manager:arsene-wenger', 'league:premier-league'],
    url: 'https://www.premierleague.com/en/news/1299931',
    fact: 'Thierry Henry played Premier League football for Arsenal under Arsène Wenger.',
  },
  {
    playerId: 'ee3905e1-3134-4026-b1c6-f6fc0e63d5cf', nameEn: 'Cristiano Ronaldo',
    criteria: ['trophy:premier-league-title'],
    url: 'https://www.manutd.com/en/club/history/history-by-decade/2000-2009',
    fact: 'Cristiano Ronaldo played in Manchester United Premier League title-winning campaigns in 2007, 2008 and 2009.',
  },
  {
    playerId: '3be1aed0-97a2-48cb-b6b1-42da5a17cd5e', nameEn: 'Philippe Coutinho',
    criteria: ['teammate:05e1b3df-4194-4aef-a256-eec199cef42b'],
    url: 'https://www.liverpoolfc.com/news/first-team/230420-luis-suarez-i-can-t-wait-to-face-my-mate-philippe-coutinho',
    fact: 'Philippe Coutinho and Luis Suárez played together at Liverpool, satisfying club teammate overlap.',
  },
  {
    playerId: 'f194539a-fd49-4f3c-8741-adabe9b2a5ca', nameEn: 'Dele Alli',
    criteria: ['club:tottenham-hotspur', 'country:gb-eng'],
    url: 'https://www.tottenhamhotspur.com/news/1008497/i-love-you-all-deles-message-to-spurs-fans-on-his-n17-return',
    fact: 'Dele Alli made 269 Tottenham appearances and represented England 37 times.',
  },
] as const;

type Source = Manifest['sources'][number];
export type CorrectionDraft = {
  status: 'requires_review';
  sourceVersion: number;
  sourceSha256: string;
  candidate: Omit<Manifest, 'sources'> & {
    sources: Array<Omit<Source, 'databaseRightsStatus'> & { databaseRightsStatus: 'approved' | 'pending_review' }>;
  };
  changes: {
    addedPlayers: string[];
    addedMemberships: Array<{ criterionKey: string; playerId: string }>;
    addedAliases: number;
    changedCells: number;
    addedAnswers: number;
  };
};

/** Keep all owners; selected-cell ambiguity is decided by the existing resolver. */
export function addFamilyAliases(manifest: Pick<Manifest, 'players' | 'aliases'>, reviewedAt: string): number {
  const keys = new Set(manifest.aliases.map(a => `${a.playerId}:${a.locale}:${a.normalizedAlias}`));
  const exactEnglish = new Set(manifest.aliases
    .filter(a => a.locale === 'en' && a.acceptancePolicy === 'exact')
    .map(a => `${a.playerId}:${a.normalizedAlias}`));
  let added = 0;
  for (const player of manifest.players) {
    // Only English display identities already anchored by an exact English alias.
    // Do not derive identities from the known inconsistent Georgian translations.
    const canonical = normalizeFootballGridAnswer(player.nameEn);
    if (!exactEnglish.has(`${player.id}:${canonical}`)) continue;
    const parts = player.nameEn.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const alias = parts.at(-1)!;
    const normalizedAlias = normalizeFootballGridAnswer(alias);
    if (!normalizedAlias) continue;
    const key = `${player.id}:en:${normalizedAlias}`;
    if (keys.has(key)) continue;
    keys.add(key);
    manifest.aliases.push({ playerId: player.id, alias, normalizedAlias, locale: 'en',
      aliasType: 'family_name', acceptancePolicy: 'unique_only',
      reviewedBy: 'exact-display-family-name-rule-v2', reviewedAt });
    added += 1;
  }
  return added;
}

export function prepareAnswerCorrections(
  source: Manifest,
  playerCatalog: Manifest,
  version: number,
  reviewedAt: string,
): CorrectionDraft {
  if (!Number.isSafeInteger(version) || version <= source.release.version) {
    throw new Error('Candidate must have a new, higher release version');
  }
  if (!Number.isFinite(Date.parse(reviewedAt))) throw new Error('Invalid review timestamp');
  if (source.sources.some(s => s.key === CORRECTION_SOURCE)) throw new Error('Source already contains this correction');
  const original = JSON.stringify(source);
  const manifest = structuredClone(source);
  const changes: CorrectionDraft['changes'] = {
    addedPlayers: [], addedMemberships: [], addedAliases: 0, changedCells: 0, addedAnswers: 0,
  };
  const criteria = new Map(manifest.criteria.map(c => [c.key, c]));
  const players = new Map(manifest.players.map(p => [p.id, p]));
  const memberships = new Map<string, Set<string>>();
  for (const m of manifest.memberships) {
    if (!memberships.has(m.criterionKey)) memberships.set(m.criterionKey, new Set());
    memberships.get(m.criterionKey)!.add(m.playerId);
  }
  for (const correction of CONFIRMED_FACTS) {
    const relevant = correction.criteria.filter(key => criteria.has(key));
    if (!relevant.length) continue;
    const existing = players.get(correction.playerId);
    const donor = playerCatalog.players.find(p => p.id === correction.playerId);
    if ((existing && existing.nameEn !== correction.nameEn) || (donor && donor.nameEn !== correction.nameEn)) {
      throw new Error(`Player identity mismatch: ${correction.playerId}`);
    }
    if (!existing) {
      if (!donor) throw new Error(`Missing reviewed display record for ${correction.nameEn}`);
      const exact = playerCatalog.aliases.filter(a => a.playerId === donor.id && a.acceptancePolicy === 'exact');
      if (!exact.some(a => a.locale === 'en') || !exact.some(a => a.locale === 'ka')) {
        throw new Error(`Missing bilingual aliases for ${correction.nameEn}`);
      }
      const origins = new Set(manifest.players.flatMap(p => {
        try { return [new URL(p.imageAssetKey).origin]; } catch { return []; }
      }));
      if (donor.imageAssetKey.startsWith('http') && !origins.has(new URL(donor.imageAssetKey).origin)) {
        throw new Error('Player catalog image origin differs from target manifest');
      }
      manifest.players.push(structuredClone(donor));
      players.set(donor.id, donor);
      manifest.aliases.push(...structuredClone(exact));
      changes.addedAliases += exact.length;
      if (!manifest.assetCatalog.includes(donor.imageAssetKey)) manifest.assetCatalog.push(donor.imageAssetKey);
      changes.addedPlayers.push(donor.id);
    }
    for (const criterionKey of relevant) {
      const members = memberships.get(criterionKey) ?? new Set<string>();
      if (members.has(correction.playerId)) continue;
      members.add(correction.playerId);
      memberships.set(criterionKey, members);
      manifest.memberships.push({ criterionKey, playerId: correction.playerId,
        relationshipSubtype: criteria.get(criterionKey)!.subtype,
        verifiedBy: 'official-football-fact-audit-20260921', reviewedAt,
        evidence: [{ sourceKey: CORRECTION_SOURCE, sourceLocator: correction.url,
          capturedFact: correction.fact, rightsClass: 'official-public-factual-reference-review-pending',
          reviewedBy: 'official-football-fact-audit-20260921', reviewedAt }],
      });
      changes.addedMemberships.push({ criterionKey, playerId: correction.playerId });
    }
  }
  changes.addedAliases += addFamilyAliases(manifest, reviewedAt);
  for (const criterion of manifest.criteria) {
    if (changes.addedMemberships.some(m => m.criterionKey === criterion.key)) {
      criterion.metadata.memberCount = memberships.get(criterion.key)!.size;
    }
  }
  for (const board of manifest.boards) {
    if (board.cells.length !== 9) throw new Error(`Invalid board: ${board.key}`);
    let changed = false;
    board.cells.forEach((cell, i) => {
      const row = memberships.get(board.rowCriteria[Math.floor(i / 3)]);
      const col = memberships.get(board.columnCriteria[i % 3]);
      if (!row || !col) throw new Error(`Missing criterion membership set: ${board.key}`);
      if (cell.playerIds.some(id => !row.has(id) || !col.has(id))) {
        throw new Error(`Existing answer lacks evidence: ${board.key}/${i}`);
      }
      // Preserve ordering and recognizable answers; add the entire missing intersection.
      const existing = new Set(cell.playerIds);
      const additions = [...row].filter(id => col.has(id) && !existing.has(id)).sort();
      if (!additions.length) return;
      cell.playerIds.push(...additions);
      changes.addedAnswers += additions.length;
      changes.changedCells += 1;
      changed = true;
    });
    if (changed) {
      board.version += 1;
      board.approvedBy = 'UNREVIEWED';
    }
  }
  manifest.release = { ...manifest.release, version, aliasVersion: source.release.aliasVersion + 1,
    approvedBy: 'UNREVIEWED', approvedAt: reviewedAt,
    relationshipSnapshot: { ...manifest.release.relationshipSnapshot,
      transformedFromVersion: source.release.version, transform: 'answer-coverage-correction-v1',
      correctionPlayerCatalogVersion: playerCatalog.release.version,
      correctionPreparedAt: reviewedAt,
      exposedPlayers: new Set(manifest.boards.flatMap(b => b.cells.flatMap(c => c.playerIds))).size,
      correctionReviewStatus: 'pending', reviewScope: 'confirmed facts and exact surname recognition' },
  };
  return {
    status: 'requires_review', sourceVersion: source.release.version,
    sourceSha256: createHash('sha256').update(original).digest('hex'), changes,
    candidate: { ...manifest, sources: [...manifest.sources, {
      key: CORRECTION_SOURCE, providerName: 'Premier League, Manchester United, Liverpool and Tottenham official sources',
      datasetVersion: 'answer-audit-2026-09-21', permittedUse: 'Individually cited football facts for Quizball gameplay.',
      databaseRightsStatus: 'pending_review', approvalOwner: 'UNREVIEWED', approvedAt: reviewedAt,
      retentionRequirements: 'Retain citations for the lifetime of pinned matches.',
    }] },
  };
}

/** Explicit review step only; publishing still verifies against fresh source exports. */
export function approveAnswerCorrections(draft: CorrectionDraft, reviewer: string, approvedAt: string): Manifest {
  if (draft.status !== 'requires_review' || !reviewer.trim() || reviewer.trim().toUpperCase() === 'UNREVIEWED'
    || !Number.isFinite(Date.parse(approvedAt))) throw new Error('Explicit reviewer and approval timestamp required');
  const candidate = structuredClone(draft.candidate);
  if (candidate.release.relationshipSnapshot.transform !== 'answer-coverage-correction-v1'
    || candidate.release.relationshipSnapshot.transformedFromVersion !== draft.sourceVersion
    || candidate.release.relationshipSnapshot.correctionReviewStatus !== 'pending') {
    throw new Error('Invalid answer correction draft');
  }
  const sources: Manifest['sources'] = candidate.sources.map(source => {
    if (source.databaseRightsStatus === 'approved') return { ...source, databaseRightsStatus: 'approved' };
    if (source.key !== CORRECTION_SOURCE) throw new Error('Unexpected unreviewed source');
    return { ...source, databaseRightsStatus: 'approved', approvalOwner: reviewer.trim(), approvedAt };
  });
  for (const board of candidate.boards) {
    if (board.approvedBy === 'UNREVIEWED') board.approvedBy = reviewer.trim();
  }
  candidate.release.approvedBy = reviewer.trim();
  candidate.release.approvedAt = approvedAt;
  candidate.release.relationshipSnapshot.correctionReviewStatus = 'approved';
  return { ...candidate, sources };
}

async function main() {
  const [sourceFile, catalogFile, outputFile, version] = process.argv.slice(2);
  if (!sourceFile || !catalogFile || !outputFile || !version) {
    throw new Error('Usage: tsx scripts/football-grid-answer-corrections.ts SOURCE_JSON PLAYER_CATALOG_JSON OUTPUT_DRAFT_JSON NEW_VERSION');
  }
  const draft = prepareAnswerCorrections(JSON.parse(await readFile(sourceFile, 'utf8')),
    JSON.parse(await readFile(catalogFile, 'utf8')), Number(version), new Date().toISOString());
  // Exclusive creation protects source files and earlier review packages.
  await writeFile(outputFile, JSON.stringify(draft), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ status: draft.status, sourceVersion: draft.sourceVersion, changes: draft.changes }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
