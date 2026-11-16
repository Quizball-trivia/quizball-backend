import { describe, expect, it } from 'vitest';
import { fuzzyMatchesAnswer, matchAnswerV2 } from '../../src/realtime/possession-answer-matching.js';
import { NAMES } from '../footballers/names-fixture.js';

// Invented names only (tests/footballers/names-fixture.ts).
describe('Clue Chain matcher: the footballer-name veto', () => {
  it('a typo that is another footballer\'s exact name is refused (v1 and v2)', () => {
    expect(fuzzyMatchesAnswer('Tamas Varnik', ['Tomas Varnik', 'Varnik'], NAMES)).toBe(false);
    expect(matchAnswerV2('Tamas Varnik', ['Tomas Varnik', 'Varnik'], NAMES)).toBeNull();
    expect(fuzzyMatchesAnswer('Tamas Varnik', ['Tomas Varnik', 'Varnik'], null)).toBe(true);
    expect(fuzzyMatchesAnswer('Tomas Varnk', ['Tomas Varnik'], NAMES)).toBe(true);
    expect(matchAnswerV2('Tomas Varnk', ['Tomas Varnik'], NAMES)?.kind).toBe('typo');
  });

  it('several words found inside a longer answer must not name someone else; one word may', () => {
    expect(fuzzyMatchesAnswer('Arlan Moss', ['Teo Arlan Moss'], NAMES)).toBe(false);
    expect(matchAnswerV2('Arlan Moss', ['Teo Arlan Moss'], NAMES)).toBeNull();
    expect(fuzzyMatchesAnswer('Moss', ['Teo Arlan Moss'], NAMES)).toBe(true);
    expect(matchAnswerV2('ArlanMoss', ['Teo Arlan Moss'], NAMES)).toBeNull();
    expect(matchAnswerV2('TeoArlanMoss', ['Teo Arlan Moss'], NAMES)?.kind).toBe('spaceless');
  });

  it('countdown: a group refused by the veto keeps a weaker match elsewhere ambiguous', async () => {
    const { installFootballerNames } = await import('../../src/modules/footballers/footballers.names.js');
    const { countdownMatch, countdownMatchV2 } = await import('../../src/realtime/possession-answer-matching.js');
    const evaluation = { kind: 'countdown', answerGroups: [
      { id: 'a', display: { en: 'Tomas Varnik' }, acceptedAnswers: ['Tomas Varnik'] },
      { id: 'b', display: { en: 'Tamas Varnyk' }, acceptedAnswers: ['Tamas Varnyk'] },
    ] } as never;
    installFootballerNames(NAMES);
    try {
      expect(countdownMatch(evaluation, 'Tamas Varnik', new Set())).toBeNull();
      expect(countdownMatchV2(evaluation, 'Tamas Varnik', new Set())).toBeNull();
      expect(countdownMatch(evaluation, 'Tomas Varnikk', new Set())?.id).toBe('a');
      const spans = { kind: 'countdown', answerGroups: [
        { id: 'teo', display: { en: 'Teo Arlan Moss' }, acceptedAnswers: ['Teo Arlan Moss'] },
        { id: 'taro', display: { en: 'Taro Arlan Moss' }, acceptedAnswers: ['Taro Arlan Moss'] },
      ] } as never;
      expect(countdownMatchV2(spans, 'ArlanMoss', new Set())).toBeNull();
    } finally {
      installFootballerNames(null);
    }
  });

  it('diagnostics say when the veto refused a matched rule', async () => {
    const { explainClueGuess } = await import('../../src/realtime/possession-answer-matching.js');
    const { installFootballerNames } = await import('../../src/modules/footballers/footballers.names.js');
    installFootballerNames(NAMES);
    try {
      expect(explainClueGuess('Tamas Varnik', ['Tomas Varnik'])).toMatchObject({ matchedRule: null, rejectReason: 'names_someone_else' });
    } finally {
      installFootballerNames(null);
    }
  });

  it('exact accepted answers stand, and answers that are not footballers are never vetoed', () => {
    expect(fuzzyMatchesAnswer('Tamas Varnik', ['Tomas Varnik', 'Tamas Varnik'], NAMES)).toBe(true);
    expect(fuzzyMatchesAnswer('Mikael', ['Mikaeli'], NAMES)).toBe(true);
  });

  it('letters Unicode cannot strip fold to plain ones', () => {
    expect(fuzzyMatchesAnswer('Lars Ostergard', ['Lars Østergard'], NAMES)).toBe(true);
    expect(fuzzyMatchesAnswer('Glabinski', ['Kamil Głąbiński'], NAMES)).toBe(true);
  });
});
