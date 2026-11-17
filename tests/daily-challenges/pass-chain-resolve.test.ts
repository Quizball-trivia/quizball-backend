import { describe, expect, it } from 'vitest';
import { resolvePassChainPlayer } from '../../src/modules/daily-challenges/pass-chain.resolve.js';
import { NAMES } from '../footballers/names-fixture.js';

// Invented players only (tests/footballers/names-fixture.ts). Clubs are plain sets of keys here.
const row = (id: string, aliases: string[], clubs: string[] = []) => ({ id, normalized_aliases: aliases, clubs });
type Row = ReturnType<typeof row>;
const PLAYERS = [
  row('wil-a', ['wilmar'], ['north']),
  row('wil-b', ['wilmar'], ['south']),
  row('var-a', ['tomas varnik', 'varnik'], ['north']),
  row('dak-a', ['benn gallo dak', 'gallo dak'], ['south']),
  row('mik-a', ['mikkel'], ['east']),
  row('ost-a', ['lars østergard'], ['east']),
  row('mos-a', ['teo arlan moss'], ['east']),
  row('pel-t', ['taro pelvani'], ['north']),
  row('pel-s', ['saro pelvani'], ['south']),
  row('mae-a', ['rui pando'], ['south']),
];
const from = (clubs: string[]) => ({ links: (r: Row) => r.clubs.some((c) => clubs.includes(c)) });
const id = (text: string, step = {}, names: typeof NAMES | null = NAMES) => resolvePassChainPlayer(PLAYERS, text, step, names)?.id ?? null;

describe('Pass Chain: a name two players share is read against the step', () => {
  it('the one holder that links from the chain end is meant; without a step, or with both or neither linking, unknown', () => {
    expect(id('Wilmar')).toBeNull();
    expect(id('Wilmar', from(['south']))).toBe('wil-b');
    expect(id('Wilmar', from(['north']))).toBe('wil-a');
    expect(id('Wilmar', from(['north', 'south']))).toBeNull();
    expect(id('Wilmar', from(['west']))).toBeNull();
  });

  it('when both link, the only one that also reaches the target is meant', () => {
    const both = { ...from(['north', 'south']), reaches: (r: Row) => r.id === 'wil-b' };
    expect(id('Wilmar', both)).toBe('wil-b');
  });

  it('a name the footballer release gives one of the players counts', () => {
    expect(id('Benn Dak')).toBe('dak-a');
    expect(id('Benn Dak', {}, null)).toBeNull();
  });

  it('a typo that is another footballer\'s exact name is refused; plain typos still count', () => {
    expect(id('Mikael')).toBeNull();
    expect(id('Mikael', {}, null)).toBe('mik-a');
    expect(id('Tomas Varnk')).toBe('var-a');
  });

  it('two different names equally near a typo stay unknown, whatever the step', () => {
    expect(id('Varo Pelvani', from(['south']))).toBeNull();
    expect(id('Saro Pelvanni', from(['north']))).toBe('pel-s');
  });

  it('several words that are somebody else\'s own name never match inside a longer name', () => {
    expect(id('Arlan Moss')).toBeNull();
    expect(id('Arlan Moss', {}, null)).toBe('mos-a');
    expect(id('Moss')).toBe('mos-a');
  });

  it('a release name that also belongs to somebody outside the pool is not credited', () => {
    expect(id('Maelo')).toBeNull();
    expect(id('Benn Dak')).toBe('dak-a');
  });

  it('letters Unicode cannot strip fold on both sides (stored keys kept them)', () => {
    expect(id('Lars Ostergard', {}, null)).toBe('ost-a');
    expect(id('Lars Østergard', {}, null)).toBe('ost-a');
  });
});

describe('Pass Chain: Greek names', () => {
  // Invented Greek-script names; keys stored the way the seed stores them (normalizeAnswerString: accents off, ς kept).
  const greek = [row('kel-g', ['ιουδας κελερμανς', 'κελερμανς'], ['north'])];
  const find = (text: string) => resolvePassChainPlayer(greek, text, {}, null)?.id ?? null;
  it('accents optional, final sigma typed either way, capitals', () => {
    expect(find('Κέλερμανς')).toBe('kel-g');
    expect(find('κελερμανσ')).toBe('kel-g');
    expect(find('ΙΟΥΔΑΣ ΚΕΛΕΡΜΑΝΣ')).toBe('kel-g');
  });
});
