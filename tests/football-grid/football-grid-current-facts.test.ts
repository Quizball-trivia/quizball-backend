import { describe, expect, it } from 'vitest';
import { approveAnswerCorrections, CURRENT_FACTS_BATCH, CURRENT_FACTS_SOURCE, prepareAnswerCorrections } from '../../scripts/football-grid-answer-corrections.js';
import { matchesPrescribedAnswerCorrection, type Manifest } from '../../scripts/football-grid-content.js';
import { normalizeFootballGridAnswer, resolveFootballGridAnswer } from '../../src/modules/football-grid/football-grid.answer-resolver.js';

const at = '2026-09-24T10:00:00.000Z';
const kvaratskhelia = 'fae90c7f-4f88-477e-892c-d277792ea964';
const falcao = 'b7f52ec2-3d5d-44ae-8cc2-2b16313da48d';
const tielemans = 'c56f9c35-9cef-4733-b80e-faad28b3c3b8';

function fixture(): Manifest {
  const players = [
    { id: kvaratskhelia, nameEn: 'Khvicha Kvaratskhelia', nameKa: 'ხვიჩა კვარაცხელია', imageAssetKey: '/kvara.webp' },
    { id: falcao, nameEn: 'Radamel Falcao', nameKa: 'რადამელ ფალკაო', imageAssetKey: '/falcao.webp' },
    { id: tielemans, nameEn: 'Youri Tielemans', nameKa: 'იური ტილემანსი', imageAssetKey: '/tielemans.webp' },
  ];
  const aliases = players.flatMap(p => ([
    { playerId: p.id, alias: p.nameEn, normalizedAlias: normalizeFootballGridAnswer(p.nameEn), locale: 'en', aliasType: 'full_name', acceptancePolicy: 'exact', reviewedBy: 'fixture', reviewedAt: at },
    { playerId: p.id, alias: p.nameKa, normalizedAlias: normalizeFootballGridAnswer(p.nameKa), locale: 'ka', aliasType: 'full_name', acceptancePolicy: 'exact', reviewedBy: 'fixture', reviewedAt: at },
  ]));
  const keys = ['club-dinamo-batumi', 'country-georgia', 'trophy:uefa-europa-league', 'wildcard:position-fwd'];
  const memberships = [
    { criterionKey: 'country-georgia', playerId: kvaratskhelia },
    { criterionKey: 'wildcard:position-fwd', playerId: falcao },
  ].map(m => ({ ...m, relationshipSubtype: 'fixture', verifiedBy: 'fixture', reviewedAt: at, evidence: [] }));
  const board = (key: string, row: string, col: string) => ({ key, version: 1, theme: 'fixture', approvedBy: 'fixture',
    difficulty: 'normal', familiarityScore: 50, rowCriteria: [row, row, row], columnCriteria: [col, col, col],
    cells: Array.from({ length: 9 }, () => ({ playerIds: [], recognizablePlayerIds: [] })) });
  return {
    release: { version: 2026092402, aliasVersion: 1, resolverPolicyVersion: 1, approvedBy: 'fixture', approvedAt: at,
      relationshipSnapshot: {} },
    sources: [], assetCatalog: players.map(p => p.imageAssetKey), players, aliases,
    criteria: keys.map(key => ({ key, family: 'fixture', subtype: 'fixture', labelEn: key, labelKa: key,
      metadata: {}, difficulty: 'normal', familiarityScore: 50 })),
    memberships,
    boards: [board('georgian', 'club-dinamo-batumi', 'country-georgia'),
      board('european', 'trophy:uefa-europa-league', 'wildcard:position-fwd')],
  } as unknown as Manifest;
}

describe('current football facts', () => {
  it('accepts the reported Georgian and Europa League answers only in matching cells', () => {
    const source = fixture();
    const draft = prepareAnswerCorrections(source, source, 2026092502, at, CURRENT_FACTS_BATCH);
    expect(draft.candidate.sources.at(-1)).toMatchObject({ key: CURRENT_FACTS_SOURCE,
      databaseRightsStatus: 'pending_review' });
    expect(draft.changes.addedMemberships).toEqual(expect.arrayContaining([
      { criterionKey: 'club-dinamo-batumi', playerId: kvaratskhelia },
      { criterionKey: 'trophy:uefa-europa-league', playerId: falcao },
    ]));
    const resolve = (text: string, boardIndex: number) => resolveFootballGridAnswer({
      submittedText: text, validPlayerIds: draft.candidate.boards[boardIndex].cells[0].playerIds,
      boardPlayerIds: draft.candidate.players.map(p => p.id), usedPlayerIds: [],
      aliases: draft.candidate.aliases.map((alias, index) => ({ ...alias, id: String(index) })),
    });
    expect(resolve('ხვიჩა კვარაცხელია', 0)).toMatchObject({ outcome: 'correct', playerId: kvaratskhelia });
    expect(resolve('Falcao', 1)).toMatchObject({ outcome: 'correct', playerId: falcao });
    expect(resolve('Falcao', 0).outcome).toBe('wrong');
    expect(resolve('ხვიჩა კვარაცხელია', 1).outcome).toBe('wrong');
    const approved = approveAnswerCorrections(draft, 'fixture-reviewer', at);
    expect(matchesPrescribedAnswerCorrection(source, source, approved)).toBe(true);
  });
});
