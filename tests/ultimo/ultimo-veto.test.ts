import { describe, expect, it } from 'vitest';
import { matchAnswer, type UltimoCategory } from '../../src/modules/ultimo/ultimo.match.js';
import { NAMES } from '../footballers/names-fixture.js';

// Invented names only (tests/footballers/names-fixture.ts).
const same = (name: string) => ({ es: name, en: name, ka: name, tr: name });
const answer = (id: string, name: string, aliases: string[] = []) => ({ id, display: same(name), aliases });
const c: UltimoCategory = {
  id: 'veto', difficulty: 'easy', title: same('Lista inventada'), hint: same('Inventada'),
  answers: [
    answer('kell', 'Judo Kellerman'), answer('moss', 'Teo Arlan Moss'), answer('var', 'Tomas Varnik'), answer('mik', 'Mikkel'),
    answer('a', 'Aldo Primo'), answer('b', 'Beto Segundo'), answer('c', 'Ciro Tercero'), answer('d', 'Dino Cuarto'),
  ],
};
const idx = (id: string) => c.answers.findIndex((a) => a.id === id);

describe('Último: a typed footballer name is never another answer\'s typo', () => {
  it('a typo that is someone else\'s exact name is refused; plain typos still count', () => {
    expect(matchAnswer(c, 'Jobo Kellerman', NAMES)).toEqual({ kind: 'none' });
    expect(matchAnswer(c, 'Jobo Kellerman', null)).toEqual({ kind: 'answer', index: idx('kell') });
    expect(matchAnswer(c, 'Tamas Varnik', NAMES)).toEqual({ kind: 'none' });
    expect(matchAnswer(c, 'Tomas Varnk', NAMES)).toEqual({ kind: 'answer', index: idx('var') });
    expect(matchAnswer(c, 'Mikael', NAMES)).toEqual({ kind: 'none' });
  });

  it('a name cut from a longer one is refused when it names someone else; a surname is not', () => {
    expect(matchAnswer(c, 'Arlan Moss', NAMES)).toEqual({ kind: 'none' });
    expect(matchAnswer(c, 'Arlan Moss', null)).toEqual({ kind: 'answer', index: idx('moss') });
    expect(matchAnswer(c, 'Moss', NAMES)).toEqual({ kind: 'answer', index: idx('moss') });
  });

  it('typed without spaces, a shortened name is still read as that name', () => {
    expect(matchAnswer(c, 'ArlanMoss', NAMES)).toEqual({ kind: 'none' });
    expect(matchAnswer(c, 'ArlanMoss', null)).toEqual({ kind: 'answer', index: idx('moss') });
  });

  it('a typo near a vetoed answer and an answer the release does not know stays ambiguous, never the unknown one', () => {
    const both: UltimoCategory = { ...c, answers: [...c.answers, answer('jopo', 'Jopo Kellerman')] };
    expect(matchAnswer(both, 'Jobo Kellerman', null)).toEqual({ kind: 'ambiguous' });
    expect(matchAnswer(both, 'Jobo Kellerman', NAMES)).toEqual({ kind: 'ambiguous' });
  });

  it('a club or country the release does not know keeps its typos', () => {
    const places: UltimoCategory = { ...c, answers: [...c.answers.slice(0, 7), answer('mik', 'Mikkalo')] };
    expect(matchAnswer(places, 'Mikael', NAMES)).toEqual({ kind: 'none' });
    expect(matchAnswer(places, 'Mikkallo', NAMES)).toEqual({ kind: 'answer', index: 7 });
  });

  it('an alias in the content always stands', () => {
    const aliased: UltimoCategory = { ...c, answers: c.answers.map((a) => (a.id === 'moss' ? { ...a, aliases: ['Arlan Moss'] } : a)) };
    expect(matchAnswer(aliased, 'Arlan Moss', NAMES)).toEqual({ kind: 'answer', index: idx('moss') });
  });
});
