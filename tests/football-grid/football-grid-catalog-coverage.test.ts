import { describe, expect, it } from 'vitest';
import { prepareCatalogCoverage, type CoverageReport } from '../../scripts/football-grid-catalog-coverage.js';
import type { Manifest } from '../../scripts/football-grid-content.js';
import { approveAnswerCorrections, type CorrectionDraft } from '../../scripts/football-grid-answer-corrections.js';

function fixture() {
  const date = '2026-09-21T19:00:00Z';
  const sourceKey = 'dcaribou-transfermarkt-datasets';
  const catalog: Manifest = {
    release: { version: 2, aliasVersion: 1, resolverPolicyVersion: 1, approvedBy: 'fixture', approvedAt: date, relationshipSnapshot: {} },
    sources: [{ key: sourceKey, providerName: 'fixture', datasetVersion: 'fixture', permittedUse: 'fixture', databaseRightsStatus: 'approved', approvalOwner: 'fixture', approvedAt: date }],
    assetCatalog: [],
    players: ['a', 'b'].map(id => ({ id, nameEn: `Player ${id}`, nameKa: `მოთამაშე ${id}`, imageAssetKey: `https://prod.example/${id}.webp` })),
    aliases: ['a', 'b'].flatMap(playerId => (['en', 'ka'] as const).map(locale => ({
      playerId, locale, alias: `Player ${playerId}`, normalizedAlias: `player ${playerId}`, aliasType: 'full_name', acceptancePolicy: 'exact' as const, reviewedBy: 'fixture', reviewedAt: date,
    }))),
    criteria: ['club:x', 'league:y'].map((key, i) => ({ key, family: i ? 'league' as const : 'club' as const, subtype: 'appearance', labelEn: key, labelKa: key, difficulty: 'easy' as const, familiarityScore: 90, metadata: {} })),
    memberships: ['a', 'b'].flatMap(playerId => ['club:x', 'league:y'].map(criterionKey => ({
      playerId, criterionKey, relationshipSubtype: 'appearance', verifiedBy: 'fixture', reviewedAt: date,
      evidence: [{ sourceKey, sourceLocator: `fixture:${playerId}`, capturedFact: 'fixture', rightsClass: 'fixture', reviewedBy: 'fixture', reviewedAt: date }],
    }))),
    boards: [{ key: 'board', version: 1, theme: 'european', difficulty: 'easy', familiarityScore: 90, approvedBy: 'fixture',
      rowCriteria: ['club:x', 'club:x', 'club:x'], columnCriteria: ['league:y', 'league:y', 'league:y'],
      cells: Array.from({ length: 9 }, () => ({ playerIds: ['a'], recognizablePlayerIds: ['a'] })) }],
  };
  const candidate = structuredClone(catalog);
  candidate.players = candidate.players.filter(p => p.id === 'a');
  candidate.aliases = candidate.aliases.filter(a => a.playerId === 'a');
  candidate.memberships = candidate.memberships.filter(m => m.playerId === 'a');
  candidate.release.approvedBy = 'UNREVIEWED';
  candidate.release.relationshipSnapshot = { correctionPlayerCatalogVersion: 2 };
  const draft: CorrectionDraft = { status: 'requires_review', sourceVersion: 1, sourceSha256: 'fixture', candidate,
    changes: { addedPlayers: [], addedMemberships: [], addedAliases: 0, changedCells: 0, addedAnswers: 0 } };
  const report: CoverageReport = { status: 'requires_review', snapshotChecksums: { 'appearances.csv.gz': 'fixture' }, releases: [{ releaseVersion: 1, proposedFacts: [] }] };
  return { draft, catalog, report };
}

describe('offline catalog coverage review', () => {
  it('includes every known intersection member without removing answers or claiming historical completeness', () => {
    const { draft, catalog, report } = fixture();
    const result = prepareCatalogCoverage(draft, catalog, report);
    expect(result.summary).toMatchObject({ addedPlayers: 1, catalogFacts: 2, addedAnswers: 9 });
    expect(result.candidate.boards[0].cells.every(c => c.playerIds.join(',') === 'a,b')).toBe(true);
    expect(result.candidate.release.relationshipSnapshot).toMatchObject({ coverageTargetFromYear: 1950, coverageComplete: false });
    expect(() => approveAnswerCorrections({ ...draft, candidate: result.candidate }, 'reviewer', '2026-09-21')).toThrow('Invalid answer correction draft');
    expect(draft.candidate.players).toHaveLength(1);
  });
  it('keeps missing identities explicitly unresolved instead of fabricating names', () => {
    const { draft, catalog, report } = fixture();
    catalog.players = catalog.players.filter(p => p.id === 'a');
    const result = prepareCatalogCoverage(draft, catalog, report);
    expect(result.unresolvedIdentities).toEqual(['b']);
    expect(result.unresolvedFacts).toHaveLength(2);
    expect(result.summary.addedAnswers).toBe(0);
  });
  it('refuses changed rule semantics, unrelated source versions and staging image origins', () => {
    const first = fixture(); first.catalog.criteria[0].subtype = 'youth-only';
    expect(() => prepareCatalogCoverage(first.draft, first.catalog, first.report)).toThrow('semantics mismatch');
    const second = fixture(); second.catalog.sources[0].datasetVersion = 'different';
    expect(() => prepareCatalogCoverage(second.draft, second.catalog, second.report)).toThrow('Source version mismatch');
    const third = fixture(); third.catalog.players[1].imageAssetKey = 'https://staging.example/b.webp';
    expect(() => prepareCatalogCoverage(third.draft, third.catalog, third.report)).toThrow('origin mismatch');
  });
});
