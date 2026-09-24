import { describe, expect, it } from 'vitest';
import { approveAnswerCorrections, correctionSourceIdentity, REPORT_FOLLOWUP_BATCH, REPORT_FOLLOWUP_SOURCE, prepareAnswerCorrections } from '../../scripts/football-grid-answer-corrections.js';
import { matchesPrescribedAnswerCorrection, type Manifest } from '../../scripts/football-grid-content.js';
import { normalizeFootballGridAnswer, resolveFootballGridAnswer } from '../../src/modules/football-grid/football-grid.answer-resolver.js';

const at = '2026-09-23T14:00:00.000Z';
const pacho = '4e9bd3d2-728a-4f4b-bf6f-873540e7a5f8';
const loria = '12cdc422-74c5-4391-8520-dc2044b1a1ec';
const other = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function fixture(): { source: Manifest; catalog: Manifest } {
  const player = (id: string, nameEn: string) => ({ id, nameEn, nameKa: nameEn,
    imageAssetKey: `/players/${id}.webp` });
  const alias = (id: string, text: string, locale: 'en' | 'ka') => ({ playerId: id, alias: text,
    normalizedAlias: normalizeFootballGridAnswer(text), locale, aliasType: 'full_name',
    acceptancePolicy: 'exact' as const, reviewedBy: 'fixture', reviewedAt: at });
  const keys = ['club:paris-saint-germain', 'wildcard:position-def', 'country-georgia', 'club-dinamo-tbilisi'];
  const source = {
    release: { version: 100, aliasVersion: 1, resolverPolicyVersion: 1, approvedBy: 'fixture', approvedAt: at,
      relationshipSnapshot: {} },
    sources: [], assetCatalog: [`/players/${loria}.webp`, `/players/${other}.webp`],
    players: [player(loria, 'Giorgi Loria'), player(other, 'Other Player')],
    aliases: [alias(loria, 'Giorgi Loria', 'en'), alias(other, 'Other Player', 'en')],
    criteria: keys.map(key => ({ key, family: 'club', subtype: 'fixture', labelEn: key,
      labelKa: key, metadata: {}, difficulty: 'normal', familiarityScore: 50 })),
    memberships: [
      ['country-georgia', loria], ['wildcard:position-def', other],
      ['club:paris-saint-germain', other], ['club-dinamo-tbilisi', other],
    ].map(([criterionKey, playerId]) => ({ criterionKey, playerId, relationshipSubtype: 'fixture',
      verifiedBy: 'fixture', reviewedAt: at, evidence: [] })),
    boards: [{ key: 'fixture-board', version: 1, theme: 'themed', approvedBy: 'fixture',
      difficulty: 'normal', familiarityScore: 50,
      rowCriteria: ['club:paris-saint-germain', 'country-georgia', 'country-georgia'],
      columnCriteria: ['wildcard:position-def', 'club-dinamo-tbilisi', 'club-dinamo-tbilisi'],
      cells: Array.from({ length: 9 }, (_, index) => ({ playerIds: index === 0 ? [other] : [],
        recognizablePlayerIds: [] })) }],
  } as unknown as Manifest;
  const catalog = structuredClone(source);
  catalog.players.push(player(pacho, 'Willian Pacho'));
  catalog.aliases.push(alias(pacho, 'Willian Pacho', 'en'), alias(pacho, 'ვილიან პაჩო', 'ka'));
  catalog.assetCatalog.push(`/players/${pacho}.webp`);
  return { source, catalog };
}

describe('reviewed player-report correction', () => {
  it('retains provenance for an alias-only correction', () => {
    expect(correctionSourceIdentity(REPORT_FOLLOWUP_BATCH)).toEqual({
      sourceKey: REPORT_FOLLOWUP_SOURCE, datasetVersion: 'player-reports-2026-09-23',
    });
  });

  it('adds the cited fact and Georgian name, then resolves both reported cells', () => {
    const { source, catalog } = fixture();
    const draft = prepareAnswerCorrections(source, catalog, 101, at, REPORT_FOLLOWUP_BATCH);
    expect(draft.candidate.sources.at(-1)).toMatchObject({ key: REPORT_FOLLOWUP_SOURCE,
      databaseRightsStatus: 'pending_review' });
    expect(draft.changes.addedMemberships).toEqual(expect.arrayContaining([
      { criterionKey: 'club-dinamo-tbilisi', playerId: loria },
      { criterionKey: 'club:paris-saint-germain', playerId: pacho },
      { criterionKey: 'wildcard:position-def', playerId: pacho },
    ]));
    const resolve = (text: string, validPlayerIds: string[]) => resolveFootballGridAnswer({
      submittedText: text, validPlayerIds, boardPlayerIds: draft.candidate.players.map(p => p.id),
      usedPlayerIds: [], aliases: draft.candidate.aliases.map((alias, index) => ({ ...alias, id: String(index) })),
    });
    expect(resolve('პაჩო', draft.candidate.boards[0].cells[0].playerIds)).toMatchObject({
      outcome: 'correct', playerId: pacho });
    expect(resolve('Giorgi Loria', draft.candidate.boards[0].cells[4].playerIds)).toMatchObject({
      outcome: 'correct', playerId: loria });
    expect(resolve('Giorgi Loria', draft.candidate.boards[0].cells[0].playerIds).outcome).toBe('wrong');
    const approved = approveAnswerCorrections(draft, 'fixture-reviewer', at);
    expect(matchesPrescribedAnswerCorrection(source, catalog, approved)).toBe(true);
  });

  it('does not let a reviewed short name silently collide with another player', () => {
    const { source, catalog } = fixture();
    source.aliases.push({ playerId: other, alias: 'პაჩო', normalizedAlias: 'პაჩო', locale: 'ka',
      aliasType: 'family_name', acceptancePolicy: 'unique_only', reviewedBy: 'fixture', reviewedAt: at });
    expect(() => prepareAnswerCorrections(source, catalog, 101, at, REPORT_FOLLOWUP_BATCH))
      .toThrow('Reviewed alias conflicts');
  });
});
