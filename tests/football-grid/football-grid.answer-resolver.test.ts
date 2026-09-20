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
  it('normalizes punctuation, accents, case, and whitespace', () => {
    expect(normalizeFootballGridAnswer('  ÁNGEL  Di-María! ')).toBe('angel di maria');
  });

  it('returns correct, ambiguous, and already-used without exposing candidates', () => {
    const aliases = [alias('a1', 'p1', 'ronaldo'), alias('a2', 'p2', 'ronaldo')];
    expect(resolveFootballGridAnswer({
      submittedText: 'Ronaldo', aliases, validPlayerIds: ['p1'], boardPlayerIds: ['p1', 'p2'], usedPlayerIds: [],
    })).toMatchObject({ outcome: 'correct', playerId: 'p1' });
    expect(resolveFootballGridAnswer({
      submittedText: 'Ronaldo', aliases, validPlayerIds: ['p1', 'p2'], boardPlayerIds: ['p1', 'p2'], usedPlayerIds: [],
    })).toMatchObject({ outcome: 'ambiguous', playerId: null });
    expect(resolveFootballGridAnswer({
      submittedText: 'Ronaldo', aliases, validPlayerIds: ['p1'], boardPlayerIds: ['p1', 'p2'], usedPlayerIds: ['p1'],
    })).toMatchObject({ outcome: 'already_used', playerId: 'p1' });
  });

  it('never lets a fuzzy valid answer override an exact invalid alias', () => {
    const aliases = [
      alias('invalid-exact', 'p-outside', 'messi'),
      alias('valid-fuzzy', 'p-valid', 'messia', 'safe_typo'),
    ];
    expect(resolveFootballGridAnswer({
      submittedText: 'messi', aliases, validPlayerIds: ['p-valid'], boardPlayerIds: ['p-valid'], usedPlayerIds: [],
    }).outcome).toBe('wrong');
  });

  it('accepts only a unique nearest typo candidate on the board', () => {
    const unique = resolveFootballGridAnswer({
      submittedText: 'ronldo',
      aliases: [alias('a1', 'p1', 'ronaldo', 'safe_typo')],
      validPlayerIds: ['p1'], boardPlayerIds: ['p1'], usedPlayerIds: [],
    });
    expect(unique).toMatchObject({ outcome: 'correct', playerId: 'p1' });

    const ambiguous = resolveFootballGridAnswer({
      submittedText: 'ronldo',
      aliases: [alias('a1', 'p1', 'ronaldo', 'safe_typo'), alias('a2', 'p2', 'ronildo', 'safe_typo')],
      validPlayerIds: ['p1'], boardPlayerIds: ['p1', 'p2'], usedPlayerIds: [],
    });
    expect(ambiguous.outcome).toBe('ambiguous');
  });

  it('does not fuzzy-match an alias reviewed as exact-only', () => {
    expect(resolveFootballGridAnswer({
      submittedText: 'ronldo',
      aliases: [alias('exact-only', 'p1', 'ronaldo', 'exact')],
      validPlayerIds: ['p1'], boardPlayerIds: ['p1'], usedPlayerIds: [],
    })).toMatchObject({ outcome: 'wrong', playerId: null });
  });

  it('bounds edit distance work', () => {
    expect(boundedLevenshtein('abc', 'abcdefgh', 2)).toBe(3);
  });
});
