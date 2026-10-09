import { describe, expect, it } from 'vitest';
import { firstLetter, lastLetter, normalizeName, surnameOf, withinEdits, withinOneEdit } from '../../src/modules/footballers/footballers.text.js';
import { buildUniverse, type UniversePlayer } from '../../src/modules/footballers/footballers.universe.js';

// Invented footballers only: the repository is public.
const P = (pid: string, name: string, game: string, fame: number, aliases: string[] = []): UniversePlayer => ({ pid, name, game, fame, aliases });
const ROWS = [
  P('p-bako', 'Bako', 'Bako', 90), P('p-orlen', 'Tarin Orlen', 'Orlen', 80), P('p-kosel', 'Emir Kosel', 'Kosel', 60),
  P('p-nesto', 'Nesto', 'Nesto', 40, ['El Nesto']), P('p-nesto2', 'Niko Nesto', 'Nesto', 20), P('p-ilter', 'Özkan İlter', 'İlter', 30),
  P('p-simsek', 'Raúl Şimşek', 'Şimşek', 25), P('p-brando', 'Stefano Brandolini', 'Brandolini', 15),
  P('p-farran', 'Milo Farran', 'Milo Farran', 85), P('p-farran-jr', 'Pim Farran Junior', 'Farran', 10), P('p-ko', 'Ko Varen', 'Varen', 45),
  P('p-carvelo', 'Joan Carvelo', 'Carvelo', 65), P('p-marvelo', 'Joan Marvelo', 'Marvelo', 35),
  P('p-geo', 'Luka Dzneladze', 'Dzneladze', 50, ['ლუკა ძნელაძე']),
];
const u = buildUniverse('test-release', ROWS);

describe('names', () => {
  it('uses one accent-insensitive Latin alphabet and keeps Georgian letters', () => {
    expect(normalizeName('  Özkan   İLTER ')).toBe('ozkan ilter');
    expect(normalizeName('ლუკა  ძნელაძე!')).toBe('ლუკა ძნელაძე');
    expect(firstLetter('İlter')).toBe('I');
    expect(firstLetter('Şimşek')).toBe('S');
    expect(lastLetter('Şimşek')).toBe('K');
    expect(firstLetter('van Derlo')).toBe('V');
    expect(surnameOf('Pim Farran Junior')).toBe('farran');
  });
  it('forgives one edit, or two on long names', () => {
    expect(withinOneEdit('brandolini', 'brandolni')).toBe(true);
    expect(withinOneEdit('brandolini', 'brnadolini')).toBe(true);
    expect(withinOneEdit('brandolini', 'brandalano')).toBe(false);
    expect(withinEdits('brandolini', 'brandalani', 2)).toBe(true);
    expect(withinEdits('brandolini', 'brandalano', 2)).toBe(false);
  });
});

describe('the universe of one release', () => {
  it('judges the same whatever order the rows were loaded in', () => {
    const shuffled = buildUniverse('test-release', [...ROWS].reverse());
    expect(shuffled.resolve('nesto')).toEqual(u.resolve('nesto'));
    expect(shuffled.starting('N')).toEqual(u.starting('N'));
  });
  it('refuses a release that names one footballer twice', () => {
    expect(() => buildUniverse('bad', [ROWS[0], ROWS[0]])).toThrow();
  });
  it('resolves full names, known names, aliases and Georgian spellings, best known first', () => {
    expect(u.resolve('emir kosel')).toEqual(['p-kosel']);
    expect(u.resolve('NESTO')).toEqual(['p-nesto', 'p-nesto2']);
    expect(u.resolve('el nesto')).toEqual(['p-nesto']);
    expect(u.resolve('Stefano Brandolni')).toEqual(['p-brando']);
    expect(u.resolve('ლუკა ძნელაძე')).toEqual(['p-geo']);
    expect(u.resolve('nobody')).toEqual([]);
  });
  it('a footballer answers the first letter of the first name, the known name and the surname', () => {
    expect(u.starts('p-orlen')).toEqual(['T', 'O']);
    expect(u.starts('p-bako')).toEqual(['B']);
    expect(u.starts('p-farran')).toEqual(['M', 'F']);
    expect(u.starts('p-farran-jr')).toEqual(['P', 'F']);
    expect(u.last('p-orlen')).toBe('N');
    expect(u.last('p-farran')).toBe('N');
    expect(u.starting('F')).toEqual(['p-farran', 'p-farran-jr']);
    expect(u.starts('unknown')).toEqual([]);
  });
});

describe('generous answers among a few footballers', () => {
  const among = ['p-orlen', 'p-kosel', 'p-brando', 'p-nesto', 'p-nesto2', 'p-ko', 'p-carvelo'];
  it('takes the full name, the surname, the first name, a nickname or a two-letter name word', () => {
    expect(u.pickAmong('tarin orlen', among)).toBe('p-orlen');
    expect(u.pickAmong('Orlen', among)).toBe('p-orlen');
    expect(u.pickAmong('emir', among)).toBe('p-kosel');
    expect(u.pickAmong('El Nesto', among)).toBe('p-nesto');
    expect(u.pickAmong('ko', among)).toBe('p-ko');
  });
  it('forgives typos, more of them on long names', () => {
    expect(u.pickAmong('Brandolni', among)).toBe('p-brando');
    expect(u.pickAmong('Stefano Brandalani', among)).toBe('p-brando');
    expect(u.pickAmong('Orlan', among)).toBe('p-orlen');
  });
  it('a shared name goes to the best known; a name that fits nobody is refused', () => {
    expect(u.pickAmong('nesto', among)).toBe('p-nesto');
    expect(u.pickAmong('nesto', ['p-nesto2', 'p-orlen'])).toBe('p-nesto2');
    expect(u.pickAmong('zzzz', among)).toBeNull();
    expect(u.pickAmong('k', among)).toBeNull();
  });
  it('a typo is not forgiven when the text is, as typed, a footballer outside the list', () => {
    expect(u.pickAmong('Joan Carvelo', among)).toBe('p-carvelo');
    expect(u.pickAmong('Joan Carvelu', among)).toBe('p-carvelo');
    expect(u.pickAmong('Joan Marvelo', among)).toBeNull();
  });
  it('ignores ids the release does not have', () => {
    expect(u.pickAmong('Orlen', ['gone', 'p-orlen'])).toBe('p-orlen');
    expect(u.pickAmong('Orlen', ['gone'])).toBeNull();
  });
});
