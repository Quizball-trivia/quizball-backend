import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  countdownMatch,
  countdownMatchV2,
  fuzzyMatchesAnswer,
  fuzzyMatchesAnswerV2,
  matchAnswerV2,
} from '../../src/realtime/possession-answer-matching.js';
import type { MatchQuestionEvaluation } from '../../src/modules/matches/matches.service.js';

interface FixtureCase {
  note: string;
  guess: string;
  accepted: string[];
  legacy: boolean;
  v2: boolean;
}
interface CountdownFixtureCase {
  note: string;
  guess: string;
  groups: Array<{ id: string; display: Record<string, string>; accepted: string[] }>;
  legacy: string | null;
  v2: string | null;
}
const fixtures = JSON.parse(
  readFileSync(resolve(__dirname, 'fixtures/answer-matching-fixtures.json'), 'utf8'),
) as { cases: FixtureCase[]; countdownCases: CountdownFixtureCase[] };

const countdownEvaluation = (
  groups: CountdownFixtureCase['groups'],
): Extract<MatchQuestionEvaluation, { kind: 'countdown' }> => ({
  kind: 'countdown',
  answerGroups: groups.map((group) => ({
    id: group.id,
    display: group.display,
    acceptedAnswers: group.accepted,
  })),
}) as Extract<MatchQuestionEvaluation, { kind: 'countdown' }>;

describe('answer matcher conformance fixtures', () => {
  for (const fixture of fixtures.cases) {
    it(`${fixture.note}: "${fixture.guess}"`, () => {
      expect(fuzzyMatchesAnswer(fixture.guess, fixture.accepted), 'legacy verdict').toBe(fixture.legacy);
      expect(fuzzyMatchesAnswerV2(fixture.guess, fixture.accepted), 'v2 verdict').toBe(fixture.v2);
    });
  }

  for (const fixture of fixtures.countdownCases) {
    it(`countdown — ${fixture.note}: "${fixture.guess}"`, () => {
      const evaluation = countdownEvaluation(fixture.groups);
      const legacy = countdownMatch(evaluation, fixture.guess, new Set());
      const v2 = countdownMatchV2(evaluation, fixture.guess, new Set());
      expect(legacy?.id ?? null, 'legacy group').toBe(fixture.legacy);
      expect(v2?.id ?? null, 'v2 group').toBe(fixture.v2);
    });
  }
});

describe('matchAnswerV2 structured result', () => {
  it('reports the match kind and matched answer', () => {
    expect(matchAnswerV2('დიმარია', ['ანხელ დი მარია'])).toEqual({
      kind: 'spaceless',
      matchedAnswer: 'ანხელ დი მარია',
      distance: 0,
    });
    expect(matchAnswerV2('კაილ უოკერი', ['Kyle Walker', 'კაილ უოკერი'])).toEqual({
      kind: 'exact',
      matchedAnswer: 'კაილ უოკერი',
      distance: 0,
    });
    expect(matchAnswerV2('მილნერი', ['Kyle Walker', 'კაილ უოკერი'])).toBeNull();
  });

  it('spaceless matches contiguous token spans only, never different names', () => {
    expect(fuzzyMatchesAnswerV2('დიმარია', ['დიმიტრი მარიანი'])).toBe(false);
    expect(fuzzyMatchesAnswerV2('vandijk', ['Virgil van Dijk'])).toBe(true); // joined surname span
    expect(fuzzyMatchesAnswerV2('virgildijk', ['Virgil van Dijk'])).toBe(false); // non-contiguous join
    expect(fuzzyMatchesAnswerV2('van dijk', ['vandijk'])).toBe(true);
  });

  it('v2 is a superset of v1 except for the guarded holes', () => {
    for (const fixture of fixtures.cases) {
      if (fixture.legacy && !fixture.v2) {
        // only the deliberate tightenings may flip accept -> reject
        expect(['დი', 'de', 'ვან']).toContain(fixture.guess);
      }
    }
  });
});

describe('review-driven guards', () => {
  it('compound particle phrases cannot whole-word match', () => {
    expect(fuzzyMatchesAnswerV2('de la', ['David de la Fuente'])).toBe(false);
    expect(fuzzyMatchesAnswerV2('van der', ['Rafael van der Vaart'])).toBe(false);
    expect(fuzzyMatchesAnswerV2('van der vaart', ['Rafael van der Vaart'])).toBe(true);
  });

  it('three-letter particles are rejected alone', () => {
    expect(fuzzyMatchesAnswerV2('ter', ['Marc-André ter Stegen'])).toBe(false);
    expect(fuzzyMatchesAnswerV2('ტერ', ['მარკ-ანდრე ტერ შტეგენი'])).toBe(false);
    expect(fuzzyMatchesAnswerV2('შტეგენი', ['მარკ-ანდრე ტერ შტეგენი'])).toBe(true);
  });

  it('countdown: exact in one group + spaceless in another is ambiguous', () => {
    const evaluation = countdownEvaluation([
      { id: 'g1', display: { en: 'A' }, accepted: ['vandijk'] },
      { id: 'g2', display: { en: 'B' }, accepted: ['Virgil van Dijk'] },
    ]);
    expect(countdownMatchV2(evaluation, 'vandijk', new Set())).toBeNull();
  });
});
