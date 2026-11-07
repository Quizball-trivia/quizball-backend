import { describe, expect, it } from 'vitest';
import { isAcceptedGuess, normalizeAnswer as normalizePistas } from '../../src/modules/pistas/pistas.normalize.js';
import { normalizeAnswerString } from '../../src/modules/daily-challenges/answer-normalize.js';
import { footballGridOrthographicKey, normalizeFootballGridAnswer } from '../../src/modules/football-grid/football-grid.answer-resolver.js';
import { normalizeName } from '../../src/modules/footballers/footballers.text.js';
import { fuzzyMatchesAnswerV2, normalizeAnswer as normalizePossession } from '../../src/realtime/possession-answer-matching.js';

// Invented names only: the repository is public.
const grid = (text: string) => footballGridOrthographicKey(normalizeFootballGridAnswer(text));
const matchers: Array<[string, (text: string) => string | null]> = [
  ['Pistas', normalizePistas],
  ['Pass Chain', normalizeAnswerString],
  ['Football Grid and Squad Spin', grid],
  ['Tenable and word games', normalizeName],
  ['Clue cards and possession', normalizePossession],
];

describe.each(matchers)('French typed answers: %s', (_, normalize) => {
  it.each([
    ['Hervé Bœufort', 'Herve Boeufort'],
    ['HERVÉ BŒUFORT', 'herve boeufort'],
    ['Cœurdelis', 'Coeurdelis'],
    ['François Mâcon', 'Francois Macon'],
    ['Éloïse Crêtier', 'Eloise Cretier'],
    ["N’Dalaye", "N'Dalaye"],
    ['Côte d’Azurie', "Côte d'Azurie"],
  ])('%s reads as %s', (typed, stored) => {
    expect(normalize(typed)).toBe(normalize(stored));
  });
});

describe('French typed answers: apostrophes', () => {
  it('Pistas accepts a name typed without its apostrophe', () => {
    expect(isAcceptedGuess([normalizePistas("N'Dalaye")], normalizePistas('Ndalaye'))).toBe(true);
  });

  it('the Grid drops the apostrophe', () => {
    expect(grid("N'Dalaye")).toBe(grid('Ndalaye'));
  });

  it('a short ligature name is a match, not a typo the matcher would refuse', () => {
    expect(fuzzyMatchesAnswerV2('Cœur', ['Coeur'])).toBe(true);
  });
});

describe('Other languages keep their matching', () => {
  it.each([
    ['ვარდო კელმარი', 'ვარდო კელმარი'],
    ['Ümo Şarlak', 'umo şarlak'],
    ['Særvik', 'særvik'],
    ['Østlund', 'østlund'],
    ['Вардо Бэйн', 'вардо бэйн'],
    ['Großwald', 'großwald'],
  ])('%s normalizes as before in Pass Chain and possession', (typed, expected) => {
    expect(normalizeAnswerString(typed)).toBe(expected.normalize('NFKD').replace(/[̀-ͯ]/g, ''));
    expect(normalizePossession(typed)).toBe(expected.normalize('NFKD').replace(/[̀-ͯ]/g, ''));
  });

  it('the Grid key still folds only ı, ß and the French ligature', () => {
    expect(footballGridOrthographicKey('ısık')).toBe('isik');
    expect(footballGridOrthographicKey('straße')).toBe('strasse');
    expect(footballGridOrthographicKey('sæther')).toBe('sæther');
  });
});
