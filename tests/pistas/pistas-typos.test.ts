import { describe, expect, it } from 'vitest';
import { isAcceptedGuess, normalizeAnswer } from '../../src/modules/pistas/pistas.normalize.js';
import { NAMES } from '../footballers/names-fixture.js';

// Invented names only (tests/footballers/names-fixture.ts).
const accepted = (...names: string[]) => names.map(normalizeAnswer);
const ok = (answers: string[], typed: string, names = NAMES) => isAcceptedGuess(answers, normalizeAnswer(typed), names);

describe('Pistas typos', () => {
  const kellerman = accepted('Judo Kellerman', 'Kellerman');

  it('one typo from five letters, two from nine', () => {
    expect(ok(kellerman, 'Judo Kelerman')).toBe(true);
    expect(ok(kellerman, 'Juda Kelerman')).toBe(true);
    expect(ok(kellerman, 'Kelerman')).toBe(true);
    expect(ok(accepted('Tavi Rond'), 'Tavi Rnd')).toBe(true);
    expect(ok(kellerman, 'Juxo Kelxrmxn')).toBe(false);
  });

  it('short guesses and short answers stay exact', () => {
    expect(ok(accepted('Tavi'), 'Tavo')).toBe(false);
    expect(ok(accepted('Tavi Rond', 'Rond'), 'Ronf')).toBe(false);
  });

  it('a long name is also accepted without its first word', () => {
    expect(ok(accepted('Juan Arno Pellegrini'), 'Arno Pellegrini')).toBe(true);
    expect(ok(accepted('Arno Pellegrini'), 'Pellegrini')).toBe(false);
  });

  it('a guess that is, as typed, another footballer\'s name is never a typo or a shortened name', () => {
    expect(ok(kellerman, 'Jobo Kellerman')).toBe(false);
    expect(ok(kellerman, 'Jobo Kellerman', null)).toBe(true);
    expect(ok(accepted('Teo Arlan Moss', 'Moss'), 'Arlan Moss')).toBe(false);
    expect(ok(accepted('Teo Arlan Moss', 'Moss'), 'Arlan Moss', null)).toBe(true);
    expect(ok(accepted('Mikkel'), 'Mikael')).toBe(false);
    // Typed without its spaces it is still that name.
    expect(ok(accepted('Teo Arlan Moss', 'Moss'), 'ArlanMoss')).toBe(false);
    // An answer the release does not know is still not the footballer typed (its surname is no evidence).
    expect(ok(accepted('Taro Arlan Moss', 'Moss'), 'Arlan Moss')).toBe(false);
    expect(ok(accepted('Taro Arlan Moss', 'Moss'), 'Taro Arlan Mos')).toBe(true);
  });

  it('an exact accepted answer stands even when it is also someone else\'s name', () => {
    expect(ok(accepted('Judo Kellerman', 'Jobo Kellerman'), 'Jobo Kellerman')).toBe(true);
  });

  it('letters Unicode cannot strip fold to plain ones', () => {
    expect(ok(accepted('Lars Østergard'), 'Lars Ostergard')).toBe(true);
    expect(ok(accepted('Kamil Głąbiński'), 'Kamil Glabinski')).toBe(true);
  });
});
