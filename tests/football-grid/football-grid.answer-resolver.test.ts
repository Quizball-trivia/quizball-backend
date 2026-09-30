import { describe, expect, it } from 'vitest';
import {
  boundedLevenshtein,
  normalizeFootballGridAnswer,
  resolveFootballGridAnswer,
  type FootballGridAliasRecord,
} from '../../src/modules/football-grid/index.js';

const alias = (
  id: string,
  playerId: string,
  normalizedAlias: string,
  acceptancePolicy: FootballGridAliasRecord['acceptancePolicy'] = 'exact',
): FootballGridAliasRecord => ({
  id,
  playerId,
  alias: normalizedAlias,
  normalizedAlias,
  locale: 'en',
  acceptancePolicy,
});

describe('football grid answer resolver', () => {
  it.each([
    ['en', 'Kylian Mbappé', 'KYLIAN MBAPPE'],
    ['ka', 'კილიან მბაპე', 'კილიან მბაპე'.toUpperCase()],
    ['es', 'Ángel Di María', 'ANGEL DI MARIA'],
    ['tr', 'İlkay Gündoğan', 'ılkay gundogan'],
    ['tr', 'Nuri Şahin', 'NURİ SAHİN'],
    ['tr', 'Rıdvan Yılmaz', 'Ridvan Yilmaz'],
    ['en', 'Stefan Kießling', 'STEFAN KIESSLING'],
    ['es', 'Kevin Großkreutz', 'KEVIN GROSSKREUTZ'],
    ['tr', 'Pascal Groß', 'PASCAL GROSS'],
  ] as const)('accepts a reviewed %s name with keyboard/case variants', (locale, name, submittedText) => {
    const reviewed = { ...alias('a', 'p', normalizeFootballGridAnswer(name)), alias: name, locale };
    expect(resolveFootballGridAnswer({ submittedText, aliases: [reviewed], validPlayerIds: ['p'],
      boardPlayerIds: ['p'], usedPlayerIds: [], validPlayerNames: [] })).toMatchObject({ outcome: 'correct', playerId: 'p' });
    expect(resolveFootballGridAnswer({ submittedText, aliases: [reviewed], validPlayerIds: [],
      boardPlayerIds: ['p'], usedPlayerIds: [], validPlayerNames: [] }).outcome).toBe('wrong');
    expect(resolveFootballGridAnswer({ submittedText, aliases: [reviewed], validPlayerIds: ['p'],
      boardPlayerIds: ['p'], usedPlayerIds: ['p'], validPlayerNames: [] }).outcome).toBe('already_used');
  });

  it('preserves exact identity precedence and ambiguity for keyboard-equivalent aliases', () => {
    const resolve = (submittedText: string, aliases: FootballGridAliasRecord[], validPlayerIds: string[]) =>
      resolveFootballGridAnswer({ submittedText, aliases, validPlayerIds, boardPlayerIds: ['p1', 'p2'], usedPlayerIds: [], validPlayerNames: [] });
    expect(resolve('isik', [alias('a', 'p1', 'isik'), alias('b', 'p2', 'ısık')], ['p2']).outcome).toBe('wrong');
    expect(resolve('isık', [alias('a', 'p1', 'isik'), alias('b', 'p2', 'ısik')], ['p1', 'p2']))
      .toMatchObject({ outcome: 'ambiguous', diagnostics: { method: 'orthographic', candidateCount: 2 } });
    // Published keys remain byte-for-byte compatible with the existing content generator.
    expect(normalizeFootballGridAnswer('Rıdvan')).toBe('rıdvan');
    expect(normalizeFootballGridAnswer('Groß')).toBe('groß');
  });

  it('normalizes punctuation, accents, case, and whitespace', () => {
    expect(normalizeFootballGridAnswer('  ÁNGEL  Di-María! ')).toBe('angel di maria');
  });

  it('returns correct, ambiguous, and already-used with no ambiguous player selection', () => {
    const aliases = [alias('a1', 'p1', 'ronaldo'), alias('a2', 'p2', 'ronaldo')];
    expect(resolveFootballGridAnswer({
      submittedText: 'Ronaldo', aliases, validPlayerIds: ['p1'], boardPlayerIds: ['p1', 'p2'], usedPlayerIds: [], validPlayerNames: [],
    })).toMatchObject({ outcome: 'correct', playerId: 'p1' });
    expect(resolveFootballGridAnswer({
      submittedText: 'Ronaldo', aliases, validPlayerIds: ['p1', 'p2'], boardPlayerIds: ['p1', 'p2'], usedPlayerIds: [], validPlayerNames: [],
    })).toMatchObject({ outcome: 'ambiguous', playerId: null });
    expect(resolveFootballGridAnswer({
      submittedText: 'Ronaldo', aliases, validPlayerIds: ['p1'], boardPlayerIds: ['p1', 'p2'], usedPlayerIds: ['p1'], validPlayerNames: [],
    })).toMatchObject({ outcome: 'already_used', playerId: 'p1' });
  });

  it('never lets a fuzzy valid answer override an exact invalid alias', () => {
    const aliases = [
      alias('invalid-exact', 'p-outside', 'messi'),
      alias('valid-fuzzy', 'p-valid', 'messia', 'safe_typo'),
    ];
    expect(resolveFootballGridAnswer({
      submittedText: 'messi', aliases, validPlayerIds: ['p-valid'], boardPlayerIds: ['p-valid'], usedPlayerIds: [], validPlayerNames: [],
    }).outcome).toBe('wrong');
  });

  it('accepts only a unique nearest typo candidate on the board', () => {
    const unique = resolveFootballGridAnswer({
      submittedText: 'ronldo',
      aliases: [alias('a1', 'p1', 'ronaldo', 'safe_typo')],
      validPlayerIds: ['p1'], boardPlayerIds: ['p1'], usedPlayerIds: [], validPlayerNames: [],
    });
    expect(unique).toMatchObject({ outcome: 'correct', playerId: 'p1' });

    const ambiguous = resolveFootballGridAnswer({
      submittedText: 'ronldo',
      aliases: [alias('a1', 'p1', 'ronaldo', 'safe_typo'), alias('a2', 'p2', 'ronildo', 'safe_typo')],
      validPlayerIds: ['p1'], boardPlayerIds: ['p1', 'p2'], usedPlayerIds: [], validPlayerNames: [],
    });
    expect(ambiguous.outcome).toBe('ambiguous');
  });

  it('does not fuzzy-match an alias reviewed as exact-only', () => {
    expect(resolveFootballGridAnswer({
      submittedText: 'ronldo',
      aliases: [alias('exact-only', 'p1', 'ronaldo', 'exact')],
      validPlayerIds: ['p1'], boardPlayerIds: ['p1'], usedPlayerIds: [], validPlayerNames: [],
    })).toMatchObject({ outcome: 'wrong', playerId: null });
  });

  it('bounds edit distance work', () => {
    expect(boundedLevenshtein('abc', 'abcdefgh', 2)).toBe(3);
  });

  it('records why a name failed without treating missing facts as proof of invalidity', () => {
    const resolve = (text: string, aliases: FootballGridAliasRecord[], valid: string[] = []) => resolveFootballGridAnswer({
      submittedText: text, aliases, validPlayerIds: valid, boardPlayerIds: valid, usedPlayerIds: [], validPlayerNames: [],
    });
    expect(resolve('', []).diagnostics.reason).toBe('empty_input');
    expect(resolve('Unknown player', []).diagnostics.reason).toBe('no_matching_alias');
    expect(resolve('Henry', [alias('h', 'henry', 'henry')]).diagnostics).toMatchObject({
      reason: 'recognized_not_in_cell', method: 'exact', candidatePlayerIds: ['henry'], cellCandidateCount: 0,
    });
    expect(resolve('Muller', [alias('t', 'thomas', 'muller'), alias('g', 'gerd', 'muller')], ['thomas', 'gerd']).diagnostics)
      .toMatchObject({ reason: 'multiple_cell_candidates', candidateCount: 2, cellCandidateCount: 2 });
    expect(resolve('ronldo', [alias('r', 'ronaldo', 'ronaldo', 'safe_typo')]).diagnostics)
      .toMatchObject({ reason: 'nearest_typo_not_on_board', candidatePlayerIds: ['ronaldo'] });
  });

  it('deduplicates and bounds private diagnostics for high-collision aliases', () => {
    const aliases = Array.from({ length: 30 }, (_, i) => alias(String(i), String(i), 'silva'));
    aliases.push(alias('duplicate', '0', 'silva'));
    const result = resolveFootballGridAnswer({ submittedText: 'silva', aliases,
      validPlayerIds: ['0'], boardPlayerIds: ['0'], usedPlayerIds: ['0'], validPlayerNames: [] });
    expect(result.outcome).toBe('already_used');
    expect(result.diagnostics).toMatchObject({ reason: 'player_already_used', candidateCount: 30,
      candidatesTruncated: true, cellCandidateCount: 1 });
    expect(result.diagnostics.candidatePlayerIds).toHaveLength(20);
  });
});

describe('football grid name-form matching (surname alias gap)', () => {
  const names = [{ playerId: 'p1', nameEn: 'Ramiro Funes Mori', nameKa: null }];
  const resolve = (submittedText: string, extra: Partial<Parameters<typeof resolveFootballGridAnswer>[0]> = {}) =>
    resolveFootballGridAnswer({ submittedText, aliases: [alias('a', 'p1', 'ramiro funes mori')],
      validPlayerIds: ['p1'], boardPlayerIds: ['p1'], usedPlayerIds: [], validPlayerNames: names, ...extra });

  it('accepts the surname (and compound surname) of a valid answer with a NULL alias id', () => {
    expect(resolve('funes mori')).toMatchObject({ outcome: 'correct', playerId: 'p1', aliasId: null,
      diagnostics: { method: 'name_form' } });
    expect(resolve('MORI')).toMatchObject({ outcome: 'correct', playerId: 'p1' });
    expect(resolve('Sandro Tonali', { aliases: [alias('a', 'p1', 'sandro tonali')],
      validPlayerNames: [{ playerId: 'p1', nameEn: 'Sandro Tonali', nameKa: 'სანდრო ტონალი' }] }).outcome).toBe('correct');
    expect(resolve('tonali', { aliases: [alias('a', 'p1', 'sandro tonali')],
      validPlayerNames: [{ playerId: 'p1', nameEn: 'Sandro Tonali', nameKa: 'სანდრო ტონალი' }] }).outcome).toBe('correct');
    expect(resolve('ტონალი', { aliases: [alias('a', 'p1', 'sandro tonali')],
      validPlayerNames: [{ playerId: 'p1', nameEn: 'Sandro Tonali', nameKa: 'სანდრო ტონალი' }] }).outcome).toBe('correct');
  });

  it('only generates name forms for valid cell players, never for other board players', () => {
    expect(resolve('funes mori', { validPlayerIds: ['p2'], validPlayerNames: [] }).outcome).toBe('wrong');
  });

  it('keeps published-alias precedence and flags two valid players sharing a surname as ambiguous', () => {
    const twins = [
      { playerId: 'p1', nameEn: 'Ramiro Funes Mori', nameKa: null },
      { playerId: 'p2', nameEn: 'Rogelio Funes Mori', nameKa: null },
    ];
    expect(resolveFootballGridAnswer({ submittedText: 'funes mori', aliases: [],
      validPlayerIds: ['p1', 'p2'], boardPlayerIds: ['p1', 'p2'], usedPlayerIds: [], validPlayerNames: twins }))
      .toMatchObject({ outcome: 'ambiguous', diagnostics: { method: 'name_form' } });
  });

  it('tolerates typos and Turkish keyboard variants against valid-answer name forms', () => {
    expect(resolve('funes morri').outcome).toBe('correct');
    expect(resolve('yıldız', { aliases: [alias('a', 'p1', 'kenan yildiz')],
      validPlayerNames: [{ playerId: 'p1', nameEn: 'Kenan Yildiz', nameKa: null }] }).outcome).toBe('correct');
    expect(resolve('van', { aliases: [alias('a', 'p1', 'virgil van dijk')],
      validPlayerNames: [{ playerId: 'p1', nameEn: 'Virgil van Dijk', nameKa: null }] }).outcome).toBe('wrong');
  });
});

describe('football grid shared-surname fall-through and typo guard-rails', () => {
  it("falls through to name forms when the typed surname's published alias belongs to another board player", () => {
    // Cell A's valid Thiago Silva has no surname alias; Bernardo (cell B) owns 'silva'.
    const result = resolveFootballGridAnswer({
      submittedText: 'Silva',
      aliases: [alias('b-silva', 'bernardo', 'silva')],
      validPlayerIds: ['thiago'],
      boardPlayerIds: ['thiago', 'bernardo'],
      usedPlayerIds: [],
      validPlayerNames: [{ playerId: 'thiago', nameEn: 'Thiago Silva', nameKa: null }],
    });
    expect(result).toMatchObject({ outcome: 'correct', playerId: 'thiago', aliasId: null, diagnostics: { method: 'name_form' } });
  });

  it('still reports recognized_not_in_cell when name forms cannot answer either', () => {
    const result = resolveFootballGridAnswer({
      submittedText: 'Silva',
      aliases: [alias('b-silva', 'bernardo', 'silva')],
      validPlayerIds: ['thiago'],
      boardPlayerIds: ['thiago', 'bernardo'],
      usedPlayerIds: [],
      validPlayerNames: [{ playerId: 'thiago', nameEn: 'Thiago Motta', nameKa: null }],
    });
    expect(result.outcome).toBe('wrong');
    expect(result.diagnostics.reason).toBe('recognized_not_in_cell');
  });

  it('never lets short name forms absorb typos of other real players', () => {
    const son = [{ playerId: 'son', nameEn: 'Son Heung-min', nameKa: null }];
    expect(resolveFootballGridAnswer({ submittedText: 'Mina', aliases: [], validPlayerIds: ['son'],
      boardPlayerIds: ['son'], usedPlayerIds: [], validPlayerNames: son }).outcome).toBe('wrong');
    const mori = [{ playerId: 'rfm', nameEn: 'Ramiro Funes Mori', nameKa: null }];
    expect(resolveFootballGridAnswer({ submittedText: 'Mari', aliases: [], validPlayerIds: ['rfm'],
      boardPlayerIds: ['rfm'], usedPlayerIds: [], validPlayerNames: mori }).outcome).toBe('wrong');
    expect(resolveFootballGridAnswer({ submittedText: 'MORI', aliases: [], validPlayerIds: ['rfm'],
      boardPlayerIds: ['rfm'], usedPlayerIds: [], validPlayerNames: mori }).outcome).toBe('correct');
  });
});
