import { describe, expect, it } from 'vitest';
import type { MatchQuestionEvaluation } from '../../src/modules/matches/matches.service.js';
import { __possessionInternals } from '../../src/realtime/possession-match-flow.js';
import {
  COUNTDOWN_QUESTION_TIME_MS,
  PUT_IN_ORDER_QUESTION_TIME_MS,
  getQuestionDurationMs,
} from '../../src/realtime/possession-state.js';
import { calculateCountdownScore } from '../../src/realtime/scoring.js';

const { normalizeAnswer, countdownMatch } = __possessionInternals;

// ── Helpers ──

function makeEvaluation(
  groups: Array<{ id: string; display: Record<string, string>; acceptedAnswers: string[] }>
): Extract<MatchQuestionEvaluation, { kind: 'countdown' }> {
  return {
    kind: 'countdown',
    answerGroups: groups.map((g) => ({
      id: g.id,
      display: g.display,
      acceptedAnswers: g.acceptedAnswers,
    })),
  };
}

const FOOTBALL_EVALUATION = makeEvaluation([
  { id: 'g1', display: { en: 'Ronaldo' }, acceptedAnswers: ['Ronaldo', 'Cristiano Ronaldo'] },
  { id: 'g2', display: { en: 'Messi' }, acceptedAnswers: ['Messi', 'Lionel Messi'] },
  { id: 'g3', display: { en: 'Neymar' }, acceptedAnswers: ['Neymar', 'Neymar Jr'] },
  { id: 'g4', display: { en: 'Mbappé' }, acceptedAnswers: ['Mbappé', 'Mbappe', 'Kylian Mbappe'] },
  { id: 'g5', display: { en: 'Ronaldinho' }, acceptedAnswers: ['Ronaldinho'] },
]);

// ── Timer constant tests ──

describe('timer constants', () => {
  it('countdown question duration is 30 seconds', () => {
    expect(COUNTDOWN_QUESTION_TIME_MS).toBe(30000);
    expect(getQuestionDurationMs('countdown')).toBe(30000);
  });

  it('put-in-order question duration is 30 seconds', () => {
    expect(PUT_IN_ORDER_QUESTION_TIME_MS).toBe(30000);
    expect(getQuestionDurationMs('putInOrder')).toBe(30000);
  });

  it('MCQ duration is unchanged at 10 seconds', () => {
    expect(getQuestionDurationMs('multipleChoice')).toBe(10000);
  });

  it('clues duration is unchanged at 20 seconds', () => {
    expect(getQuestionDurationMs('clues')).toBe(20000);
  });
});

// ── normalizeAnswer tests ──

describe('normalizeAnswer', () => {
  it('lowercases and trims', () => {
    expect(normalizeAnswer('  Ronaldo  ')).toBe('ronaldo');
  });

  it('strips diacritics', () => {
    expect(normalizeAnswer('Mbappé')).toBe('mbappe');
  });

  it('strips punctuation but keeps letters and numbers', () => {
    expect(normalizeAnswer("O'Brien-Smith")).toBe('o brien smith');
  });

  it('collapses whitespace', () => {
    expect(normalizeAnswer('Lionel   Messi')).toBe('lionel messi');
  });

  it('returns empty string for empty input', () => {
    expect(normalizeAnswer('')).toBe('');
  });
});

// ── Prefix matching tests ──

describe('countdownMatch — prefix matching', () => {
  it('accepts a unique 3-character prefix', () => {
    // "ney" matches only Neymar (g3)
    const result = countdownMatch(FOOTBALL_EVALUATION, 'ney', new Set());
    expect(result).not.toBeNull();
    expect(result!.id).toBe('g3');
  });

  it('rejects an ambiguous prefix that matches multiple groups', () => {
    // "ron" matches Ronaldo (g1) and Ronaldinho (g5) — ambiguous
    const result = countdownMatch(FOOTBALL_EVALUATION, 'ron', new Set());
    expect(result).toBeNull();
  });

  it('accepts a prefix once ambiguity is resolved by longer input', () => {
    // Use an evaluation where fuzzy/substring won't interfere
    const evalWithSimilarNames = makeEvaluation([
      { id: 'a1', display: { en: 'Martinez' }, acceptedAnswers: ['Martinez'] },
      { id: 'a2', display: { en: 'Martins' }, acceptedAnswers: ['Martins'] },
    ]);

    // "mar" matches both — ambiguous prefix, no fuzzy match either (too short for substring)
    const result1 = countdownMatch(evalWithSimilarNames, 'mar', new Set());
    expect(result1).toBeNull();

    // "mart" matches both (substring of both)
    // But since fuzzy runs first and "mart" is substring of "martinez" (4+ chars), it matches a1
    const result2 = countdownMatch(evalWithSimilarNames, 'mart', new Set());
    expect(result2).not.toBeNull();

    // "martin" is substring of both — but fuzzy match picks the first one
    // After a1 is found, "martin" matches a2 via substring
    const result3 = countdownMatch(evalWithSimilarNames, 'martin', new Set(['a1']));
    expect(result3).not.toBeNull();
    expect(result3!.id).toBe('a2');
  });

  it('resolves ambiguity when one group is already found', () => {
    // "ron" with Ronaldo (g1) already found → only Ronaldinho (g5) remains → unique prefix
    const result = countdownMatch(FOOTBALL_EVALUATION, 'ron', new Set(['g1']));
    expect(result).not.toBeNull();
    expect(result!.id).toBe('g5');
  });

  it('rejects a prefix shorter than 3 characters', () => {
    // "me" is only 2 chars — below MIN_PREFIX_LENGTH
    const result = countdownMatch(FOOTBALL_EVALUATION, 'me', new Set());
    expect(result).toBeNull();
  });

  it('prefix matching is case-insensitive', () => {
    const result = countdownMatch(FOOTBALL_EVALUATION, 'NEY', new Set());
    expect(result).not.toBeNull();
    expect(result!.id).toBe('g3');
  });

  it('prefix matching normalizes diacritics', () => {
    // "mba" matches "Mbappé" (normalized to "mbappe")
    const result = countdownMatch(FOOTBALL_EVALUATION, 'mba', new Set());
    expect(result).not.toBeNull();
    expect(result!.id).toBe('g4');
  });

  it('skips already-found groups for prefix matching', () => {
    // All groups found except g4 (Mbappé)
    const found = new Set(['g1', 'g2', 'g3', 'g5']);
    const result = countdownMatch(FOOTBALL_EVALUATION, 'mba', found);
    expect(result).not.toBeNull();
    expect(result!.id).toBe('g4');
  });
});

// ── Exact/fuzzy match tests (existing behavior preserved) ──

describe('countdownMatch — exact and fuzzy matching', () => {
  it('accepts an exact match', () => {
    const result = countdownMatch(FOOTBALL_EVALUATION, 'Messi', new Set());
    expect(result).not.toBeNull();
    expect(result!.id).toBe('g2');
  });

  it('accepts a case-insensitive exact match', () => {
    const result = countdownMatch(FOOTBALL_EVALUATION, 'messi', new Set());
    expect(result).not.toBeNull();
    expect(result!.id).toBe('g2');
  });

  it('accepts fuzzy match with small Levenshtein distance', () => {
    // "Messy" is distance 1 from "Messi"
    const result = countdownMatch(FOOTBALL_EVALUATION, 'Messy', new Set());
    expect(result).not.toBeNull();
    expect(result!.id).toBe('g2');
  });

  it('accepts substring match for inputs >= 4 chars', () => {
    // "aldo" is a substring of "Ronaldo" (4 chars)
    const result = countdownMatch(FOOTBALL_EVALUATION, 'aldo', new Set());
    expect(result).not.toBeNull();
    expect(result!.id).toBe('g1');
  });

  it('returns null when no match is found', () => {
    const result = countdownMatch(FOOTBALL_EVALUATION, 'Zidane', new Set());
    expect(result).toBeNull();
  });

  it('skips already-found groups', () => {
    const result = countdownMatch(FOOTBALL_EVALUATION, 'Messi', new Set(['g2']));
    expect(result).toBeNull();
  });

  it('exact match takes priority over prefix match', () => {
    // Create evaluation where "Mes" is an exact accepted answer for g6
    // but "Messi" (g2) also has a prefix starting with "mes"
    const evalWithShortAnswer = makeEvaluation([
      { id: 'g2', display: { en: 'Messi' }, acceptedAnswers: ['Messi'] },
      { id: 'g6', display: { en: 'Mes' }, acceptedAnswers: ['Mes'] },
    ]);
    const result = countdownMatch(evalWithShortAnswer, 'Mes', new Set());
    // Exact/fuzzy match runs first, should match g6 exactly
    expect(result).not.toBeNull();
    expect(result!.id).toBe('g6');
  });
});

// ── Scoring formula tests ──

describe('calculateCountdownScore', () => {
  it('computes proportional score capped at 100', () => {
    expect(calculateCountdownScore(3, 5)).toBe(60);
    expect(calculateCountdownScore(5, 5)).toBe(100);
    expect(calculateCountdownScore(0, 5)).toBe(0);
    expect(calculateCountdownScore(1, 10)).toBe(10);
    expect(calculateCountdownScore(7, 10)).toBe(70);
  });

  it('handles single answer group (all-or-nothing)', () => {
    expect(calculateCountdownScore(1, 1)).toBe(100);
    expect(calculateCountdownScore(0, 1)).toBe(0);
  });

  it('rounds correctly for non-even divisions', () => {
    expect(calculateCountdownScore(1, 3)).toBe(33);
    expect(calculateCountdownScore(2, 3)).toBe(67);
  });

  it('returns 0 when totalGroups is 0', () => {
    expect(calculateCountdownScore(0, 0)).toBe(0);
    expect(calculateCountdownScore(5, 0)).toBe(0);
  });

  it('returns 0 when totalGroups is negative', () => {
    expect(calculateCountdownScore(1, -1)).toBe(0);
  });
});
