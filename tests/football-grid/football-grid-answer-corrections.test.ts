import { describe, expect, it } from 'vitest';
import { addFamilyAliases, approveAnswerCorrections, CONFIRMED_FACTS, prepareAnswerCorrections } from '../../scripts/football-grid-answer-corrections.js';
import { matchesPrescribedAnswerCorrection } from '../../scripts/football-grid-content.js';
import { normalizeFootballGridAnswer, resolveFootballGridAnswer } from '../../src/modules/football-grid/football-grid.answer-resolver.js';
import type { Manifest } from '../../scripts/football-grid-content.js';

const date = '2026-09-21T19:00:00.000Z';
const [henry, ronaldo, coutinho, dele, neymar] = CONFIRMED_FACTS;
const ka = ['ტიერი ანრი', 'კრიშტიანუ რონალდუ', 'ფილიპე კოუტინიო', 'დელი ალი', 'ნეიმარი'];
function aliases(id: string, en: string, ge: string): Manifest['aliases'] {
  return ([['en', en], ['ka', ge]] as const).map(([locale, alias]) => ({
    playerId: id, alias, normalizedAlias: normalizeFootballGridAnswer(alias), locale,
    aliasType: locale === 'en' ? 'full_name' : 'georgian', acceptancePolicy: 'exact', reviewedBy: 'fixture', reviewedAt: date,
  }));
}
function fixture(): Manifest {
  const keys = [...new Set([...CONFIRMED_FACTS.flatMap(c => [...c.criteria]),
    'league:la-liga', 'wildcard:major-leagues-3', 'trophy:uefa-europa-league', 'trophy:ligue-1-title',
    'teammate:dembele', 'trophy:serie-a-title'])];
  return {
    release: { version: 10, aliasVersion: 1, resolverPolicyVersion: 1, approvedBy: 'fixture', approvedAt: date, relationshipSnapshot: {} },
    sources: [], assetCatalog: [], boards: [],
    players: CONFIRMED_FACTS.map((p, i) => ({ id: p.playerId, nameEn: p.nameEn, nameKa: ka[i], imageAssetKey: `https://prod.example/players/${p.playerId}.webp` })),
    aliases: CONFIRMED_FACTS.flatMap((p, i) => aliases(p.playerId, p.nameEn, ka[i])),
    criteria: keys.map(key => ({ key, family: 'club', subtype: 'fixture', labelEn: key, labelKa: key, metadata: {}, difficulty: 'normal', familiarityScore: 50 })),
    memberships: [
      ['league:la-liga', ronaldo.playerId], ['wildcard:major-leagues-3', ronaldo.playerId],
      ['league:premier-league', coutinho.playerId],
      ['trophy:serie-a-title', 'theo'],
    ].map(([criterionKey, playerId]) => ({ criterionKey, playerId, relationshipSubtype: 'fixture', verifiedBy: 'fixture', reviewedAt: date, evidence: [] })),
  };
}
function answer(candidate: Pick<Manifest, 'aliases' | 'memberships'>, text: string, row: string, column: string, used: string[] = []) {
  const rows = new Set(candidate.memberships.filter(m => m.criterionKey === row).map(m => m.playerId));
  const valid = candidate.memberships.filter(m => m.criterionKey === column && rows.has(m.playerId)).map(m => m.playerId);
  return resolveFootballGridAnswer({ submittedText: text,
    aliases: candidate.aliases.map((a, i) => ({ ...a, id: `alias-${i}` })),
    validPlayerIds: valid, boardPlayerIds: valid, usedPlayerIds: used });
}

describe('production rejected-answer corrections', () => {
  it('accepts Neymar as a forward without removing his existing midfield role', () => {
    const source = fixture();
    for (const key of ['country:br', 'wildcard:position-mid']) {
      source.criteria.push({ key, family: 'wildcard', subtype: 'fixture', labelEn: key, labelKa: key,
        metadata: {}, difficulty: 'easy', familiarityScore: 90 });
      source.memberships.push({ criterionKey: key, playerId: neymar.playerId, relationshipSubtype: 'fixture',
        verifiedBy: 'fixture', reviewedAt: date, evidence: [] });
    }
    const candidate = prepareAnswerCorrections(source, source, 11, date).candidate;
    for (const name of ['Neymar', 'NEYMAR', 'ნეიმარი']) {
      expect(answer(source, name, 'country:br', 'wildcard:position-fwd').outcome).toBe('wrong');
      expect(answer(candidate, name, 'country:br', 'wildcard:position-fwd')).toMatchObject({ outcome: 'correct', playerId: neymar.playerId });
      expect(answer(candidate, name, 'country:br', 'wildcard:position-mid').outcome).toBe('correct');
      expect(answer(candidate, name, 'country:br', 'wildcard:position-def').outcome).toBe('wrong');
    }
  });
  it('permits only the exact reviewed correction, rejecting unrelated data and source changes', () => {
    const source = fixture();
    const draft = prepareAnswerCorrections(source, source, 11, date);
    const approved = approveAnswerCorrections(draft, 'Test reviewer', date);
    expect(matchesPrescribedAnswerCorrection(source, source, approved)).toBe(true);
    const changedAlias = structuredClone(approved);
    changedAlias.aliases[0].acceptancePolicy = 'safe_typo';
    expect(matchesPrescribedAnswerCorrection(source, source, changedAlias)).toBe(false);
    const changedFact = structuredClone(approved);
    changedFact.memberships.pop();
    expect(matchesPrescribedAnswerCorrection(source, source, changedFact)).toBe(false);
    const changedSource = structuredClone(source);
    changedSource.criteria[0].labelEn = 'Unrelated source change';
    expect(matchesPrescribedAnswerCorrection(changedSource, changedSource, approved)).toBe(false);
    const noReview = structuredClone(approved);
    noReview.release.relationshipSnapshot.correctionReviewStatus = 'pending';
    expect(matchesPrescribedAnswerCorrection(source, source, noReview)).toBe(false);
    expect(() => approveAnswerCorrections(draft, 'UNREVIEWED', date)).toThrow('Explicit reviewer');
  });
  it('repairs the five confirmed reported failures, including Georgian inputs', () => {
    const source = fixture();
    const candidate = prepareAnswerCorrections(source, source, 11, date).candidate;
    const cases = [
      [ka[0], 'manager:arsene-wenger', 'league:premier-league', henry.playerId],
      [ka[1], 'trophy:premier-league-title', 'league:la-liga', ronaldo.playerId],
      ['Cristiano Ronaldo', 'wildcard:major-leagues-3', 'trophy:premier-league-title', ronaldo.playerId],
      ['Coutinho', coutinho.criteria[0], 'league:premier-league', coutinho.playerId],
      [ka[3], 'club:tottenham-hotspur', 'country:gb-eng', dele.playerId],
    ];
    for (const [input, row, column, playerId] of cases) {
      expect(answer(source, input, row, column).outcome).toBe('wrong');
      expect(answer(candidate, input, row, column)).toMatchObject({ outcome: 'correct', playerId });
      expect(answer(candidate, input, row, column, [playerId]).outcome).toBe('already_used');
    }
  });

  it('keeps invalid Messi/Hamsik answers and national-only teammate claims rejected', () => {
    const source = fixture();
    source.aliases.push(...aliases('messi', 'Lionel Messi', 'ლიონელ მესი'),
      ...aliases('hamsik', 'Marek Hamsik', 'მარეკ ჰამშიკი'), ...aliases('theo', 'Theo Hernández', 'თეო ერნანდესი'));
    const candidate = prepareAnswerCorrections(source, source, 11, date).candidate;
    expect(answer(candidate, 'ლიონელ მესი', 'teammate:griezmann', 'trophy:uefa-europa-league').outcome).toBe('wrong');
    expect(answer(candidate, 'მარეკ ჰამშიკი', 'trophy:ligue-1-title', 'league:premier-league').outcome).toBe('wrong');
    expect(answer(candidate, 'თეო ერნანდესი', 'teammate:dembele', 'trophy:serie-a-title').outcome).toBe('wrong');
  });

  it('imports a missing Dele display record and exact bilingual aliases from the matching catalog', () => {
    const catalog = fixture();
    const source = fixture();
    source.players = source.players.filter(p => p.id !== dele.playerId);
    source.aliases = source.aliases.filter(a => a.playerId !== dele.playerId);
    const draft = prepareAnswerCorrections(source, catalog, 11, date);
    expect(draft.changes.addedPlayers).toEqual([dele.playerId]);
    expect(draft.candidate.assetCatalog).toContain(catalog.players[3].imageAssetKey);
    expect(answer(draft.candidate, 'დელი ალი', ...dele.criteria).outcome).toBe('correct');
    catalog.players[3].imageAssetKey = 'https://staging.example/dele.webp';
    expect(() => prepareAnswerCorrections(source, catalog, 11, date)).toThrow('origin');
  });

  it('keeps aliases already stored for a player absent from the board display catalog', () => {
    const catalog = fixture();
    const source = fixture();
    source.players = source.players.filter(p => p.id !== dele.playerId);
    const previous = source.aliases.filter(a => a.playerId === dele.playerId);
    catalog.aliases.filter(a => a.playerId === dele.playerId).forEach(a => { a.reviewedBy = 'donor'; });
    const candidate = prepareAnswerCorrections(source, catalog, 11, date).candidate;
    for (const alias of previous) {
      expect(candidate.aliases.filter(a => a.playerId === alias.playerId && a.normalizedAlias === alias.normalizedAlias
        && a.locale === alias.locale && a.aliasType === alias.aliasType)).toEqual([alias]);
    }
  });

  it('preserves the source and existing answers, rebuilding affected intersections in a new draft', () => {
    const source = fixture();
    source.boards = [{ key: 'fixture', version: 1, theme: 'european', difficulty: 'easy', familiarityScore: 90,
      approvedBy: 'fixture', rowCriteria: ['manager:arsene-wenger', 'club:tottenham-hotspur', 'country:gb-eng'],
      columnCriteria: ['league:premier-league', 'country:gb-eng', 'club:tottenham-hotspur'],
      cells: Array.from({ length: 9 }, () => ({ playerIds: [], recognizablePlayerIds: [] })),
    }];
    const before = JSON.stringify(source);
    const draft = prepareAnswerCorrections(source, source, 11, date);
    expect(JSON.stringify(source)).toBe(before);
    expect(draft.status).toBe('requires_review');
    expect(draft.candidate.release.approvedBy).toBe('UNREVIEWED');
    expect(draft.candidate.sources.at(-1)?.databaseRightsStatus).toBe('pending_review');
    expect(draft.candidate.boards[0].cells[0].playerIds).toContain(henry.playerId);
    expect(draft.candidate.boards[0].version).toBe(2);
    expect(() => prepareAnswerCorrections(source, source, 10, date)).toThrow('higher release');
    source.players[0].nameEn = 'Different Henry';
    expect(() => prepareAnswerCorrections(source, source, 11, date)).toThrow('identity mismatch');
  });
});

describe('exact surnames are resolved against the cell, not the whole release', () => {
  it('accepts Mbappe and Mbappé for one qualifying player, preserves ambiguity and already-used rules', () => {
    const manifest = fixture();
    manifest.players = ['Kylian Mbappé', 'Ethan Mbappé', 'Thomas Müller', 'Gerd Müller'].map((nameEn, i) => ({
      id: String(i), nameEn, nameKa: `fixture-${i}`, imageAssetKey: '/fixture.webp',
    }));
    manifest.aliases = manifest.players.flatMap(p => aliases(p.id, p.nameEn, p.nameKa));
    const count = addFamilyAliases(manifest, date);
    expect(count).toBe(4);
    expect(addFamilyAliases(manifest, date)).toBe(0);
    const resolve = (text: string, valid: string[], used: string[] = []) => resolveFootballGridAnswer({
      submittedText: text, aliases: manifest.aliases.map((a, i) => ({ ...a, id: String(i) })),
      validPlayerIds: valid, boardPlayerIds: ['0', '1', '2', '3'], usedPlayerIds: used,
    });
    expect(resolve('Mbappe', ['0']).outcome).toBe('correct');
    expect(resolve('Mbappé', ['0']).outcome).toBe('correct');
    expect(resolve('Mbappe', ['0', '1']).outcome).toBe('ambiguous');
    expect(resolve('Mbappe', ['0', '1'], ['0']).outcome).toBe('ambiguous');
    expect(resolve('Mbappe', ['0'], ['0']).outcome).toBe('already_used');
    expect(resolve('Muller', ['2']).outcome).toBe('correct');
    expect(resolve('Muller', ['2', '3']).outcome).toBe('ambiguous');
    expect(resolve('Muller', ['0']).outcome).toBe('wrong');
    expect(resolve('Muler', ['2']).outcome).toBe('wrong'); // no unreviewed typo expansion
  });
});
