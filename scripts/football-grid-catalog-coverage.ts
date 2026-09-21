/** Local review only. Consolidate known evidence; never approve or publish it. */
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { addFamilyAliases, type CorrectionDraft } from './football-grid-answer-corrections.js';
import type { Manifest } from './football-grid-content.js';
import { normalizeFootballGridAnswer } from '../src/modules/football-grid/football-grid.answer-resolver.js';

type SourceFact = {
  criterionKey: string; playerId: string; sourceLocator: string; capturedFact: string;
  effectiveFrom: string; effectiveTo: string;
};
export type CoverageReport = {
  status: string;
  snapshotChecksums: Record<string, string>;
  releases: Array<{ releaseVersion: number; proposedFacts: SourceFact[] }>;
};

export function prepareCatalogCoverage(draft: CorrectionDraft, catalog: Manifest, report: CoverageReport) {
  if (draft.status !== 'requires_review' || draft.candidate.release.approvedBy !== 'UNREVIEWED') {
    throw new Error('Expected an unapproved correction draft');
  }
  if (catalog.release.version !== draft.candidate.release.relationshipSnapshot.correctionPlayerCatalogVersion) {
    throw new Error('Catalog version mismatch');
  }
  const audit = report.releases.find(r => r.releaseVersion === draft.sourceVersion);
  if (report.status !== 'requires_review' || !audit || !report.snapshotChecksums['appearances.csv.gz']) {
    throw new Error('Missing source coverage audit for this release');
  }
  const candidate = structuredClone(draft.candidate);
  const criteria = new Map(candidate.criteria.map(c => [c.key, c]));
  const catalogCriteria = new Map(catalog.criteria.map(c => [c.key, c]));
  const players = new Map(candidate.players.map(p => [p.id, p]));
  const donorPlayers = new Map(catalog.players.map(p => [p.id, p]));
  const donorAliases = new Map<string, Manifest['aliases']>();
  for (const alias of catalog.aliases) {
    const list = donorAliases.get(alias.playerId) ?? [];
    list.push(alias); donorAliases.set(alias.playerId, list);
  }
  const origins = new Set(candidate.players.filter(p => p.imageAssetKey.startsWith('http')).map(p => new URL(p.imageAssetKey).origin));
  const present = new Set(candidate.memberships.map(m => `${m.criterionKey}:${m.playerId}`));
  const summary = { addedPlayers: 0, catalogFacts: 0, snapshotFacts: 0, addedAliases: 0, changedCells: 0, addedAnswers: 0 };
  const assets = new Set(candidate.assetCatalog);
  const unresolvedIdentities = new Set<string>();
  const unresolvedFacts: Array<{ criterionKey: string; playerId: string }> = [];
  function ensurePlayer(id: string) {
    if (players.has(id)) {
      const donor = donorPlayers.get(id);
      if (donor && normalizeFootballGridAnswer(donor.nameEn) !== normalizeFootballGridAnswer(players.get(id)!.nameEn)) throw new Error(`Identity mismatch: ${id}`);
      return true;
    }
    const donor = donorPlayers.get(id);
    const aliases = donorAliases.get(id) ?? [];
    if (!donor || !donor.nameKa || !aliases.some(a => a.locale === 'en' && a.acceptancePolicy === 'exact')
      || !aliases.some(a => a.locale === 'ka' && a.acceptancePolicy === 'exact')) {
      unresolvedIdentities.add(id); return false;
    }
    if (donor.imageAssetKey.startsWith('http') && !origins.has(new URL(donor.imageAssetKey).origin)) throw new Error('Catalog image origin mismatch');
    candidate.players.push(structuredClone(donor)); players.set(id, donor);
    candidate.aliases.push(...structuredClone(aliases)); summary.addedAliases += aliases.length;
    assets.add(donor.imageAssetKey); summary.addedPlayers += 1;
    return true;
  }
  function add(member: Manifest['memberships'][number], kind: 'catalogFacts' | 'snapshotFacts') {
    const key = `${member.criterionKey}:${member.playerId}`;
    if (present.has(key)) return;
    if (!ensurePlayer(member.playerId)) {
      if (!unresolvedFacts.some(f => f.criterionKey === member.criterionKey && f.playerId === member.playerId)) {
        unresolvedFacts.push({ criterionKey: member.criterionKey, playerId: member.playerId });
      }
      return;
    }
    for (const evidence of member.evidence) {
      const source = candidate.sources.find(s => s.key === evidence.sourceKey);
      if (!source) throw new Error(`Missing source: ${evidence.sourceKey}`);
    }
    candidate.memberships.push(structuredClone(member)); present.add(key); summary[kind] += 1;
  }
  for (const member of catalog.memberships) {
    const target = criteria.get(member.criterionKey);
    if (!target) continue;
    const donor = catalogCriteria.get(member.criterionKey);
    if (!donor || donor.family !== target.family || donor.subtype !== target.subtype) throw new Error(`Criterion semantics mismatch: ${member.criterionKey}`);
    for (const evidence of member.evidence) {
      const left = candidate.sources.find(s => s.key === evidence.sourceKey);
      const right = catalog.sources.find(s => s.key === evidence.sourceKey);
      if (!right || (left && (left.datasetVersion !== right.datasetVersion || left.providerName !== right.providerName))) throw new Error(`Source version mismatch: ${evidence.sourceKey}`);
      if (!left) candidate.sources.push({ ...structuredClone(right), databaseRightsStatus: 'pending_review', approvalOwner: 'UNREVIEWED' });
    }
    add(member, 'catalogFacts');
  }
  const timestamp = candidate.release.approvedAt;
  for (const fact of audit.proposedFacts) {
    const criterion = criteria.get(fact.criterionKey);
    if (!criterion) throw new Error(`Unknown criterion: ${fact.criterionKey}`);
    if (!['club', 'league', 'manager', 'teammate'].includes(criterion.family)) throw new Error('Unsupported source-audit inference');
    add({ criterionKey: fact.criterionKey, playerId: fact.playerId, relationshipSubtype: criterion.subtype,
      effectiveFrom: fact.effectiveFrom, effectiveTo: fact.effectiveTo, verifiedBy: 'UNREVIEWED', reviewedAt: timestamp,
      evidence: [{ sourceKey: 'dcaribou-transfermarkt-datasets', sourceLocator: fact.sourceLocator,
        capturedFact: fact.capturedFact, effectiveFrom: fact.effectiveFrom, effectiveTo: fact.effectiveTo,
        rightsClass: 'CC0-1.0-public-domain-dataset', reviewedBy: 'UNREVIEWED', reviewedAt: timestamp }],
    }, 'snapshotFacts');
  }
  candidate.assetCatalog = [...assets];
  summary.addedAliases += addFamilyAliases(candidate, timestamp);
  const members = new Map(candidate.criteria.map(c => [c.key, new Set<string>()]));
  for (const m of candidate.memberships) members.get(m.criterionKey)!.add(m.playerId);
  for (const c of candidate.criteria) c.metadata.memberCount = members.get(c.key)!.size;
  for (const board of candidate.boards) {
    let changed = false;
    board.cells.forEach((cell, i) => {
      const row = members.get(board.rowCriteria[Math.floor(i / 3)])!;
      const col = members.get(board.columnCriteria[i % 3])!;
      if (cell.playerIds.some(id => !row.has(id) || !col.has(id))) throw new Error('Existing answer unsupported by stored evidence');
      const previous = new Set(cell.playerIds);
      const additions = [...row].filter(id => col.has(id) && !previous.has(id)).sort();
      if (!additions.length) return;
      cell.playerIds.push(...additions); summary.changedCells++; summary.addedAnswers += additions.length; changed = true;
    });
    if (changed) { board.version++; board.approvedBy = 'UNREVIEWED'; }
  }
  candidate.release.relationshipSnapshot = { ...candidate.release.relationshipSnapshot,
    transform: 'catalog-coverage-draft-v1', coverageTargetFromYear: 1950, coverageComplete: false,
    coverageScope: 'Existing catalog and witnessed appearances; historical and unmapped-player gaps remain',
    exposedPlayers: new Set(candidate.boards.flatMap(b => b.cells.flatMap(c => c.playerIds))).size,
  };
  return { status: 'requires_review' as const, sourceVersion: draft.sourceVersion, sourceSha256: draft.sourceSha256,
    candidate, summary, snapshotChecksums: report.snapshotChecksums,
    unresolvedIdentities: [...unresolvedIdentities].sort(), unresolvedFacts,
    blockers: ['Historical coverage from 1950 is incomplete.', 'Review source proposals, ambiguous-name replay and changed difficulty.',
      'No publishing/approval command supports this broader draft; the confirmed-fix approval must reject it.'] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [draftFile, catalogFile, reportFile, outputFile] = process.argv.slice(2);
  if (!outputFile) throw new Error('Usage: tsx football-grid-catalog-coverage.ts DRAFT CATALOG SOURCE_REPORT OUTPUT');
  const result = prepareCatalogCoverage(JSON.parse(await readFile(draftFile, 'utf8')), JSON.parse(await readFile(catalogFile, 'utf8')), JSON.parse(await readFile(reportFile, 'utf8')));
  await writeFile(outputFile, JSON.stringify(result), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(result.summary));
}
