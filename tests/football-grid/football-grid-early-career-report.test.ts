import { describe, expect, it } from 'vitest';
import facts from '../../scripts/football-grid-content-generator/reviewed-report-followup-20261102.json' with { type: 'json' };
import {
  approveAnswerCorrections, correctionSourceIdentity, EARLY_CAREER_REPORT_BATCH, EARLY_CAREER_REPORT_SOURCE, prepareAnswerCorrections,
} from '../../scripts/football-grid-answer-corrections.js';
import { matchesPrescribedAnswerCorrection, type Manifest } from '../../scripts/football-grid-content.js';
import { normalizeFootballGridAnswer, resolveFootballGridAnswer } from '../../src/modules/football-grid/football-grid.answer-resolver.js';

const at = '2026-11-02T10:00:00.000Z';
// The record the served release holds (Málaga, La Liga and Brazil only: his 2012/13 Málaga appearances).
const baptista = '7aa111e1-1c65-481c-9612-4da8c3dbf283';
const julioCesar = '80bcb2d4-bfbd-4ef8-85ec-44925ecebe79';
const other = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const player = (id: string, nameEn: string) => ({ id, nameEn, nameKa: nameEn, imageAssetKey: `/players/${id}.webp` });
const alias = (id: string, text: string, locale: 'en' | 'ka', acceptancePolicy: 'exact' | 'unique_only' = 'exact') => ({
  playerId: id, alias: text, normalizedAlias: normalizeFootballGridAnswer(text), locale, aliasType: 'full_name',
  acceptancePolicy, reviewedBy: 'fixture', reviewedAt: at });

/** One board: AS Roma / Sevilla / Real Madrid rows × La Liga / Serie A / Brazil columns; cell 0 is AS Roma × La Liga. */
function pack(): Manifest {
  const rows = ['club:as-roma', 'club:sevilla-fc', 'club:real-madrid-cf'];
  const columns = ['league:la-liga', 'league:serie-a', 'country:br'];
  const players = [player(baptista, 'Júlio Baptista'), player(julioCesar, 'Júlio César'), player(other, 'Other Player')];
  const aliases = [
    alias(baptista, 'Júlio Baptista', 'en'), alias(baptista, 'Baptista', 'en', 'unique_only'), alias(baptista, 'ჟულიო ბაპტისტა', 'ka'),
    alias(julioCesar, 'Júlio César', 'en'), alias(other, 'Other Player', 'en'),
  ];
  const held: Array<[string, string]> = [['league:la-liga', baptista], ['country:br', baptista], ['club:as-roma', julioCesar], ['country:br', julioCesar]];
  const keys = [...rows, ...columns];
  return {
    release: { version: 100, aliasVersion: 1, resolverPolicyVersion: 1, approvedBy: 'fixture', approvedAt: at, relationshipSnapshot: {} },
    sources: [], assetCatalog: players.map(p => p.imageAssetKey), players, aliases,
    criteria: keys.map(key => ({ key, family: key.split(':')[0] === 'country' ? 'country' : key.split(':')[0], subtype: 'fixture', labelEn: key,
      labelKa: key, metadata: {}, difficulty: 'normal', familiarityScore: 50 })),
    memberships: [...held, ...keys.map(key => [key, other] as [string, string])].map(([criterionKey, playerId]) => ({
      criterionKey, playerId, relationshipSubtype: 'fixture', verifiedBy: 'fixture', reviewedAt: at, evidence: [] })),
    boards: [{ key: 'fixture-board', version: 1, theme: 'european', approvedBy: 'fixture', difficulty: 'normal', familiarityScore: 50,
      rowCriteria: rows, columnCriteria: columns,
      cells: Array.from({ length: 9 }, () => ({ playerIds: [other], recognizablePlayerIds: [] })) }],
  } as unknown as Manifest;
}

const resolveIn = (candidate: Manifest, cell: number, text: string) => resolveFootballGridAnswer({
  submittedText: text, validPlayerIds: candidate.boards[0].cells[cell].playerIds, boardPlayerIds: candidate.players.map(p => p.id),
  usedPlayerIds: [], validPlayerNames: [], aliases: candidate.aliases.map((entry, index) => ({ ...entry, id: String(index) })),
});

describe('reviewed player report: club spells before the 2012 appearance source', () => {
  it('names its own source', () => {
    expect(correctionSourceIdentity(EARLY_CAREER_REPORT_BATCH)).toEqual({ sourceKey: EARLY_CAREER_REPORT_SOURCE, datasetVersion: 'player-reports-2026-11-02' });
  });

  it('every fact is cited from UEFA and completes a record that is already there', () => {
    for (const entry of facts.facts) {
      expect(entry.presentOnly).toBe(true);
      expect(entry.playerId).toBe(baptista);
      expect(entry.url).toMatch(/^https:\/\/www\.uefa\.com\//);
      expect(entry.fact.length).toBeGreaterThan(20);
    }
  });

  it('Júlio Baptista is accepted for AS Roma × La Liga (refused twice before), and Sevilla/Real Madrid open up too', () => {
    const source = pack();
    // The reported refusal: he is in La Liga but the release never saw his 2008–11 Roma spell.
    expect(resolveIn(source, 0, 'Júlio Baptista').outcome).toBe('wrong');
    const draft = prepareAnswerCorrections(source, source, 101, at, EARLY_CAREER_REPORT_BATCH);
    expect(draft.changes.addedPlayers).toEqual([]);
    expect(draft.changes.addedMemberships.map(m => m.criterionKey).sort())
      .toEqual(['club:as-roma', 'club:real-madrid-cf', 'club:sevilla-fc', 'league:serie-a']);
    for (const text of ['Júlio Baptista', 'Julio Baptista', 'Baptista', 'ჟულიო ბაპტისტა']) {
      expect(resolveIn(draft.candidate, 0, text)).toMatchObject({ outcome: 'correct', playerId: baptista });
    }
    expect(resolveIn(draft.candidate, 3, 'Baptista')).toMatchObject({ outcome: 'correct', playerId: baptista }); // Sevilla × La Liga
    expect(resolveIn(draft.candidate, 6, 'Baptista')).toMatchObject({ outcome: 'correct', playerId: baptista }); // Real Madrid × La Liga
    expect(resolveIn(draft.candidate, 1, 'Baptista')).toMatchObject({ outcome: 'correct', playerId: baptista }); // AS Roma × Serie A
    // The other Júlio (a Roma player too, never in La Liga) is not picked for him.
    expect(resolveIn(draft.candidate, 0, 'Júlio César').outcome).toBe('wrong');
    expect(draft.candidate.boards[0].cells[0].playerIds).toEqual([other, baptista]);
    const approved = approveAnswerCorrections(draft, 'fixture-reviewer', at);
    expect(matchesPrescribedAnswerCorrection(source, source, approved)).toBe(true);
  });

  it('a pack without his record imports nobody', () => {
    const source = pack();
    source.players = source.players.filter(p => p.id !== baptista);
    source.aliases = source.aliases.filter(a => a.playerId !== baptista);
    source.memberships = source.memberships.filter(m => m.playerId !== baptista);
    const draft = prepareAnswerCorrections(source, pack(), 101, at, EARLY_CAREER_REPORT_BATCH);
    expect(draft.changes.addedPlayers).toEqual([]);
    expect(draft.changes.addedMemberships).toEqual([]);
  });
});
