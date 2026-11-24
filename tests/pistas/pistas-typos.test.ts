import { describe, expect, it } from 'vitest';
import { isAcceptedGuess, normalizeAnswer } from '../../src/modules/pistas/pistas.normalize.js';
import { NAMES } from '../footballers/names-fixture.js';
import { footballerNamesOf } from '../../src/modules/footballers/footballers.names.js';
import { buildUniverse } from '../../src/modules/footballers/footballers.universe.js';

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

  it('Greek answers: accents optional, final sigma typed either way, capitals', () => {
    // Invented Greek-script name.
    const greek = accepted('Ιούδας Κέλερμανς', 'Κέλερμανς');
    expect(ok(greek, 'Κέλερμανς')).toBe(true);
    expect(ok(greek, 'κελερμανσ')).toBe(true);
    expect(ok(greek, 'ΙΟΥΔΑΣ ΚΕΛΕΡΜΑΝΣ')).toBe(true);
    expect(ok(greek, 'Κέλερ')).toBe(false);
    // Short answers get no typo slack: only the sigma fold lets these meet.
    expect(normalizeAnswer('Ταξ ΑΡΗΣ')).toBe('ταξ αρησ');
    expect(ok(accepted('Άρης'), 'αρησ')).toBe(true);
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

  it('a number is never a typo, in any digits', () => {
    expect(ok(accepted('Tavi Rondo 7'), 'Tavi Rondo 8')).toBe(false);
    expect(ok(accepted('Tavi Rondo \uFF17'), 'Tavi Rondo \uFF18')).toBe(false);
    expect(ok(accepted('Tavi Rondo \uFF17'), 'Tavu Rondo \uFF17')).toBe(true);
    expect(ok(accepted('Tavi Rondo \uFF17'), 'Tavi Rondo 7')).toBe(true);
    expect(ok(accepted('Tavi Rondo II'), 'Tavi Rondo \u2161')).toBe(true);
    // Compatibility forms are the same letters, not typos: "Ⅲ" is three edits from "iii" as typed.
    expect(ok(accepted('Tavi Rondo III'), 'Tavi Rondo \u2162')).toBe(true);
    expect(ok(accepted('Tavi Rondo \u2162'), 'Tavi Rondo III')).toBe(true);
  });

  it('a compatibility form never hides another footballer from the veto', () => {
    const names = footballerNamesOf(buildUniverse('rel-compat', [
      { pid: 'ruf-a', name: 'Tavi Ruffin', game: 'Ruffin', fame: 60, aliases: [] },
      { pid: 'ruf-b', name: 'Tavi Ro\uFB03n', game: 'Ro\uFB03n', fame: 20, aliases: [] },
    ]));
    expect(ok(accepted('Tavi Ruffin'), 'Tavi Ro\uFB03n', names)).toBe(false);
    expect(ok(accepted('Tavi Ruffin'), 'Tavi Ruffin', names)).toBe(true);
  });

  it('folding an answer never widens who it is, nor vetoes its own alias', () => {
    const names = footballerNamesOf(buildUniverse('rel-compat-2', [
      { pid: 'rof-a', name: 'Tavi Ro\uFB03n', game: 'Ro\uFB03n', fame: 60, aliases: ['Tavi Ro\uFB03m'] },
      { pid: 'rof-b', name: 'Tavi Roffim', game: 'Roffim', fame: 20, aliases: ['Tavu Roffin'] },
    ]));
    expect(ok(accepted('Tavi Ro\uFB03n'), 'Tavu Roffin', names)).toBe(false);
    expect(ok(accepted('Tavi Ro\uFB03n'), 'Tavi Ro\uFB03m', names)).toBe(true);
  });

  it('letters Unicode cannot strip fold to plain ones', () => {
    expect(ok(accepted('Lars Østergard'), 'Lars Ostergard')).toBe(true);
    expect(ok(accepted('Kamil Głąbiński'), 'Kamil Glabinski')).toBe(true);
  });
});
