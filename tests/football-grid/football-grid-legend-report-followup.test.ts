import { describe, expect, it } from 'vitest';
import facts from '../../scripts/football-grid-content-generator/reviewed-report-followup-20261009.json' with { type: 'json' };
import { approveAnswerCorrections, correctionSourceIdentity, LEGEND_REPORT_BATCH, LEGEND_REPORT_SOURCE, prepareAnswerCorrections } from '../../scripts/football-grid-answer-corrections.js';
import { matchesPrescribedAnswerCorrection, type Manifest } from '../../scripts/football-grid-content.js';
import { normalizeFootballGridAnswer, resolveFootballGridAnswer } from '../../src/modules/football-grid/football-grid.answer-resolver.js';

const at = '2026-10-09T10:00:00.000Z';
// The same person has one display record in the European pack and two in the themed pack.
const european = '95faf5b6-9e1c-4879-854d-6a8746bbc3b8';
const themedFull = '79f167d2-9d12-4f3e-91c0-0fbbf1b7d994';
const themedShort = '778ab168-1244-4cd2-930a-6a26b384fc0b';
const other = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const player = (id: string, nameEn: string) => ({ id, nameEn, nameKa: nameEn, imageAssetKey: `/players/${id}.webp` });
const alias = (id: string, text: string, locale: 'en' | 'ka', acceptancePolicy: 'exact' | 'unique_only' = 'exact') => ({
  playerId: id, alias: text, normalizedAlias: normalizeFootballGridAnswer(text), locale, aliasType: 'full_name',
  acceptancePolicy, reviewedBy: 'fixture', reviewedAt: at });

/** One board whose first cell is PSV x Serie A (the reported cell) and whose fifth is the Brazilian club x La Liga. */
function pack(kind: 'european' | 'themed'): Manifest {
  const psv = kind === 'european' ? 'club:psv-eindhoven' : 'club-psv-eindhoven';
  const brazil = kind === 'european' ? 'club:fc-barcelona' : 'club-corinthians';
  const keys = [psv, brazil, 'club:fc-barcelona', 'club:real-madrid-cf', 'club:ac-milan', 'club:inter-milan', 'club-cruzeiro',
    'league:serie-a', 'league:la-liga', 'league:eredivisie'].filter((key, index, all) => all.indexOf(key) === index);
  const players = kind === 'european'
    ? [player(european, 'Ronaldo Nazario'), player(other, 'Other Player')]
    : [player(themedFull, 'Ronaldo Nazário'), player(themedShort, 'Ronaldo'), player(other, 'Other Player')];
  const aliases = kind === 'european'
    ? [alias(european, 'Ronaldo Nazario', 'en'), alias(european, 'Nazario', 'en', 'unique_only'), alias(european, 'რონალდო', 'ka'), alias(other, 'Other Player', 'en')]
    : [alias(themedFull, 'Ronaldo Nazário', 'en'), alias(themedFull, 'ნაზარიო', 'ka', 'unique_only'), alias(themedShort, 'Ronaldo', 'en'), alias(other, 'Other Player', 'en')];
  const held: Array<[string, string]> = kind === 'european'
    ? [[psv, european], ['club:fc-barcelona', european], ['club:real-madrid-cf', european], ['club:inter-milan', european], ['club:ac-milan', european]]
    : [['club:inter-milan', themedFull], ['club-corinthians', themedFull], ['club-cruzeiro', themedFull],
      [psv, themedShort], ['club:fc-barcelona', themedShort], ['club:real-madrid-cf', themedShort], ['club:inter-milan', themedShort]];
  return {
    release: { version: 100, aliasVersion: 1, resolverPolicyVersion: 1, approvedBy: 'fixture', approvedAt: at, relationshipSnapshot: {} },
    sources: [], assetCatalog: players.map(p => p.imageAssetKey), players, aliases,
    criteria: keys.map(key => ({ key, family: key.startsWith('league') ? 'league' : 'club', subtype: 'fixture', labelEn: key,
      labelKa: key, metadata: {}, difficulty: 'normal', familiarityScore: 50 })),
    memberships: [...held, ...keys.map(key => [key, other] as [string, string])].map(([criterionKey, playerId]) => ({
      criterionKey, playerId, relationshipSubtype: 'fixture', verifiedBy: 'fixture', reviewedAt: at, evidence: [] })),
    boards: [{ key: 'fixture-board', version: 1, theme: kind, approvedBy: 'fixture', difficulty: 'normal', familiarityScore: 50,
      rowCriteria: [psv, brazil, 'club:inter-milan'], columnCriteria: ['league:serie-a', 'league:la-liga', 'league:eredivisie'],
      cells: Array.from({ length: 9 }, () => ({ playerIds: [other], recognizablePlayerIds: [] })) }],
  } as unknown as Manifest;
}

const resolveIn = (candidate: Manifest, cell: number, text: string) => resolveFootballGridAnswer({
  submittedText: text, validPlayerIds: candidate.boards[0].cells[cell].playerIds, boardPlayerIds: candidate.players.map(p => p.id),
  usedPlayerIds: [], validPlayerNames: [], aliases: candidate.aliases.map((entry, index) => ({ ...entry, id: String(index) })),
});

describe('reviewed player report: a legend with clubs but no leagues', () => {
  it('names its own source', () => {
    expect(correctionSourceIdentity(LEGEND_REPORT_BATCH)).toEqual({ sourceKey: LEGEND_REPORT_SOURCE, datasetVersion: 'player-reports-2026-10-09' });
  });

  it('every fact is cited from an official site and completes a record that is already there', () => {
    for (const entry of [...facts.facts, ...facts.aliases]) {
      expect(entry.presentOnly).toBe(true);
      expect(entry.url).toMatch(/^https:\/\/www\.(psv\.nl|laliga\.com|inter\.it|fcbarcelona\.com|realmadrid\.com|acmilan\.com|corinthians\.com\.br|uefa\.com)\//);
      expect(entry.fact.length).toBeGreaterThan(20);
    }
  });

  it('European pack: the reported answer is accepted in PSV x Serie A, in Latin and in Georgian, and nobody is imported', () => {
    const source = pack('european');
    expect(resolveIn(source, 0, 'Nazario').outcome).toBe('wrong');
    const draft = prepareAnswerCorrections(source, source, 101, at, LEGEND_REPORT_BATCH);
    expect(draft.changes.addedPlayers).toEqual([]);
    expect(draft.changes.addedMemberships).toEqual(['league:eredivisie', 'league:la-liga', 'league:serie-a'].map(criterionKey => ({ criterionKey, playerId: european })));
    expect(resolveIn(draft.candidate, 0, 'Nazario')).toMatchObject({ outcome: 'correct', playerId: european });
    expect(resolveIn(draft.candidate, 0, 'ნაზარიო')).toMatchObject({ outcome: 'correct', playerId: european });
    // The answers that were there stay, in their order.
    expect(draft.candidate.boards[0].cells[0].playerIds).toEqual([other, european]);
    const approved = approveAnswerCorrections(draft, 'fixture-reviewer', at);
    expect(matchesPrescribedAnswerCorrection(source, source, approved)).toBe(true);
  });

  it('themed pack: both of its records of him are completed, and the European record is not brought in as a third', () => {
    const source = pack('themed');
    const catalog = pack('european');
    expect(resolveIn(source, 0, 'ნაზარიო').outcome).toBe('wrong');
    const draft = prepareAnswerCorrections(source, catalog, 101, at, LEGEND_REPORT_BATCH);
    expect(draft.changes.addedPlayers).toEqual([]);
    expect(draft.candidate.players.map(p => p.id)).not.toContain(european);
    const added = (id: string) => draft.changes.addedMemberships.filter(m => m.playerId === id).map(m => m.criterionKey).sort();
    expect(added(themedFull)).toEqual(['club-psv-eindhoven', 'club:ac-milan', 'club:fc-barcelona', 'club:real-madrid-cf', 'league:eredivisie', 'league:la-liga', 'league:serie-a']);
    expect(added(themedShort)).toEqual(['club-corinthians', 'club-cruzeiro', 'club:ac-milan', 'league:eredivisie', 'league:la-liga', 'league:serie-a']);
    expect(resolveIn(draft.candidate, 0, 'ნაზარიო')).toMatchObject({ outcome: 'correct', playerId: themedFull });
    expect(resolveIn(draft.candidate, 0, 'Ronaldo')).toMatchObject({ outcome: 'correct', playerId: themedShort });
    expect(resolveIn(draft.candidate, 4, 'Ronaldo Nazário')).toMatchObject({ outcome: 'correct', playerId: themedFull });
    const approved = approveAnswerCorrections(draft, 'fixture-reviewer', at);
    expect(matchesPrescribedAnswerCorrection(source, catalog, approved)).toBe(true);
  });
});
