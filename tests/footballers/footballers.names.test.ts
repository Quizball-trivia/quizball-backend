import { describe, expect, it } from 'vitest';
import { namesSomeoneElse, namesSomeoneElseThan } from '../../src/modules/footballers/footballers.names.js';
import { NAMES, UNIVERSE } from './names-fixture.js';

describe('footballer names: who a text names exactly', () => {
  it('holders are exact names, known names and aliases, best known first; typos and other scripts hold nobody', () => {
    expect(UNIVERSE.named('Wilmar')).toEqual(['wil-a', 'wil-b']);
    expect(NAMES.holders('benn dak')).toEqual(['dak-a']);
    expect(NAMES.holders('Ostergard')).toEqual(['ost-a']);
    expect(NAMES.holders('ლარს ოსტერგარდი')).toEqual(['ost-a']);
    expect(NAMES.holders('Tomas Varnk')).toEqual([]);
    expect(NAMES.holders('Томас Варник')).toEqual([]);
    // A letter of another script is never dropped to leave a name behind.
    expect(NAMES.holders('Саро Velmar')).toEqual([]);
    expect(NAMES.holders('Taro Velmar')).toEqual(['vel-a']);
  });

  it('a text names someone else when it holds a footballer and none of them is the target', () => {
    expect(namesSomeoneElse(NAMES, 'Tamas Varnik', (pid) => pid === 'var-a')).toBe(true);
    expect(namesSomeoneElse(NAMES, 'Varnik', (pid) => pid === 'var-a')).toBe(false);
    expect(namesSomeoneElse(NAMES, 'Tomas Varnk', (pid) => pid === 'var-a')).toBe(false);
    expect(namesSomeoneElse(null, 'Tamas Varnik', (pid) => pid === 'var-a')).toBe(false);
  });

  it('an answer known by its forms is whoever its names of several words name; a bare surname does not widen it', () => {
    expect(namesSomeoneElseThan(NAMES, 'Jobo Kellerman', () => ['judo kellerman', 'kellerman'])).toBe(true);
    expect(namesSomeoneElseThan(NAMES, 'Judo Kellerman', () => ['judo kellerman', 'kellerman'])).toBe(false);
    // A whole name the release does not know is never replaced by what its surname names.
    expect(namesSomeoneElseThan(NAMES, 'Arlan Moss', () => ['taro arlan moss', 'moss'])).toBe(false);
    expect(namesSomeoneElseThan(NAMES, 'Arlan Moss', () => ['taro arlan moss', 'moss'], { person: true })).toBe(true);
    // A one-word name of its own still says who the answer is when its full legal name is unknown to the release.
    expect(namesSomeoneElseThan(NAMES, 'Mikael', () => ['mikkel', 'jonas andersson berg'])).toBe(true);
    // A one-word answer is whoever holds its forms.
    expect(namesSomeoneElseThan(NAMES, 'Mikael', () => ['mikkel'])).toBe(true);
  });

  it('an answer no footballer holds is vetoed only when it is a person', () => {
    expect(namesSomeoneElseThan(NAMES, 'Mikael', () => ['mikaeli city', 'mikaeli'])).toBe(false);
    expect(namesSomeoneElseThan(NAMES, 'Mikael', () => ['mikaeli city', 'mikaeli'], { person: true })).toBe(true);
  });

  it('the answer is read in the script the text was typed in, never through an initial', () => {
    // The shared Georgian spelling must not make Luka Henrik count as Luka Enrik for a Latin text…
    expect(namesSomeoneElseThan(NAMES, 'Luka Henrik', () => ['Luka Enrik', 'ლუკა ენრიკი'])).toBe(true);
    // …nor the initial alias "L. Enrik" widen the answer to every L. Enrik.
    expect(namesSomeoneElseThan(NAMES, 'Luka Henrik', () => ['L. Enrik', 'Enrik', 'Luka Enrik'])).toBe(true);
    // A Georgian text is read with the Georgian forms: there the two names are one spelling.
    expect(namesSomeoneElseThan(NAMES, 'ლუკა ენრიკი', () => ['Luka Enrik', 'ლუკა ენრიკი'])).toBe(false);
  });
});
