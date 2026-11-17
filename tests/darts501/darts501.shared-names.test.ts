import { describe, expect, it } from 'vitest';
import { buildDirectory, withRussian, type TenableEntity } from '../../src/modules/tenable/tenable.identify.js';
import { entriesOf, readDart, type Board } from '../../src/modules/darts501/darts501.rules.js';

// Invented footballers only: the repository is public.
const E = (eid: string, name: string, fame: number): TenableEntity => ({ eid, name, known: name.split(' ')[1], fame, aliases: [], qualifier: null });
const directory = buildDirectory('player', 'rel', [
  E('rik', 'Rik Zeller', 30), E('tam', 'Tam Zeller', 20), E('pol', 'Pol Zeller', 10),
  E('ana', 'Ana Brode', 25), E('ben', 'Ben Brode', 25),
  E('kai', 'Kai Morrow', 40),
]);
// Pol Zeller and Ben Brode are uncovered (no numbers in our source).
const coverage = new Set(['rik', 'tam', 'ana', 'kai']);
const board = (entries: Array<[string, number]>): Board => ({ directory, coverage, entries: entriesOf({ entries: entries.map(([eid, value]) => ({ eid, value })) }) });
const read = (b: Board, text: string, used: string[] = []) => readDart(b, new Set(used), 501, text, null);

describe('Darts 501: a shared surname whose best-known holder is covered is read against the category', () => {
  it('its holder in the category scores, even when a less-known namesake is uncovered', () => {
    expect(directory.identify('Zeller')).toEqual({ kind: 'ambiguous' });
    expect(read(board([['tam', 40]]), 'Zeller')).toMatchObject({ free: false, verdict: 'score', eid: 'tam', value: 40 });
    expect(read(board([['rik', 7], ['tam', 40]]), 'Zeller')).toMatchObject({ free: false, eid: 'rik', value: 7 });
    expect(read(board([['rik', 7], ['tam', 40]]), 'Zeller', ['rik'])).toMatchObject({ free: false, eid: 'tam', value: 40 });
  });

  it('with no open holder in the category it is a miss that costs the dart, named by the best known', () => {
    expect(read(board([['kai', 9]]), 'Zeller')).toMatchObject({ free: false, verdict: 'miss', eid: 'rik', value: null });
    expect(read(board([['rik', 7]]), 'Zeller', ['rik'])).toMatchObject({ free: false, verdict: 'miss', eid: 'rik' });
  });

  it('stays ambiguous and free whatever the category holds when an uncovered namesake is as well known', () => {
    for (const entries of [[['ana', 3]], [['kai', 9]], []] as Array<Array<[string, number]>>) {
      expect(read(board(entries), 'Brode')).toEqual({ free: true, verdict: 'ambiguous', eid: null });
    }
  });

  it('a long typo near several footballers is read the same way when exactly one is in the category', () => {
    expect(directory.nearby('Zelller')).toEqual(['rik', 'tam', 'pol']);
    expect(read(board([['tam', 40]]), 'Zelller')).toMatchObject({ free: false, eid: 'tam', value: 40 });
    expect(read(board([['kai', 9]]), 'Zelller')).toMatchObject({ free: false, verdict: 'miss', eid: 'rik' });
    // Two of its near spellings in the category: still a guess, so the dart misses (never a free probe).
    expect(read(board([['rik', 7], ['tam', 40]]), 'Zelller')).toMatchObject({ free: false, verdict: 'miss', eid: 'rik' });
  });

  it('free verdicts never depend on the category (no oracle)', () => {
    const categories: Array<Array<[string, number]>> = [[], [['rik', 1]], [['tam', 1]], [['pol', 1]], [['ana', 1]], [['ben', 1]], [['kai', 1]]];
    for (const text of ['Zeller', 'Zelller', 'Brode', 'Brodde', 'Kai Morow', 'Nobody Here']) {
      const free = categories.map((entries) => read(board(entries), text)).map((r) => (r.free ? r.verdict : 'thrown'));
      expect(new Set(free).size, text).toBe(1);
    }
  });
});

describe('Darts 501: a shared name typed in Georgian is read against the category as in Latin', () => {
  const K = (eid: string, name: string, fame: number, aliases: string[]): TenableEntity => ({ eid, name, known: name.split(' ')[1], fame, aliases, qualifier: null });
  const ka = buildDirectory('player', 'rel', [
    K('lo-a', 'Dato Lovrek', 30, ['დატო ლოვრეკი', 'ლოვრეკი']), K('lo-b', 'Iko Lovrek', 20, ['იკო ლოვრეკი', 'ლოვრეკი']),
    K('lo-c', 'Rati Lovrek', 2, ['რატი ლოვრეკი', 'ლოვრეკი']),
    K('br-a', 'Ana Brodet', 25, ['ბროდეტი']), K('br-b', 'Ben Brodet', 25, ['ბროდეტი']),
    K('he-a', 'Remo Herrano', 35, ['ჰერანო']), K('he-b', 'Tavo Herrana', 30, ['ჰერანო']),
    K('kai', 'Kai Morrow', 40, ['კაი მოროუ', 'მოროუ']),
  ]);
  // Rati Lovrek and Ben Brodet are uncovered.
  const kcov = new Set(['lo-a', 'lo-b', 'br-a', 'he-a', 'he-b', 'kai']);
  const kboard = (entries: Array<[string, number]>): Board => ({ directory: ka, coverage: kcov, entries: entriesOf({ entries: entries.map(([eid, value]) => ({ eid, value })) }) });

  it('its holder in the category scores, even when a less-known namesake is uncovered', () => {
    expect(ka.identify('ლოვრეკი')).toEqual({ kind: 'ambiguous' });
    expect(read(kboard([['lo-b', 40]]), 'ლოვრეკი')).toMatchObject({ free: false, verdict: 'score', eid: 'lo-b', value: 40 });
    expect(read(kboard([['lo-a', 7], ['lo-b', 40]]), 'ლოვრეკი')).toMatchObject({ free: false, eid: 'lo-a', value: 7 });
    expect(read(kboard([['kai', 9]]), 'ლოვრეკი')).toMatchObject({ free: false, verdict: 'miss', eid: 'lo-a', value: null });
  });

  it('stays ambiguous and free when an uncovered namesake is as well known', () => {
    for (const entries of [[['br-a', 3]], [['kai', 9]], []] as Array<Array<[string, number]>>) {
      expect(read(kboard(entries), 'ბროდეტი')).toEqual({ free: true, verdict: 'ambiguous', eid: null });
    }
  });

  it('one spelling for two Latin names is never read against the category: ambiguous and free', () => {
    for (const entries of [[['he-b', 12]], [['he-a', 5], ['he-b', 12]], [['kai', 9]]] as Array<Array<[string, number]>>) {
      expect(read(kboard(entries), 'ჰერანო')).toEqual({ free: true, verdict: 'ambiguous', eid: null });
    }
  });

  it('a player who does not hold the name never scores, and a near spelling is never read against the category', () => {
    expect(read(kboard([['kai', 9]]), 'ლოვრეკი')).toMatchObject({ verdict: 'miss', eid: 'lo-a' });
    expect(read(kboard([['lo-b', 40]]), 'ლოვრეკ')).toEqual(read(kboard([['kai', 9]]), 'ლოვრეკ'));
  });

  it('free verdicts never depend on the category (no oracle)', () => {
    const categories: Array<Array<[string, number]>> = [[], ['lo-a', 'lo-b', 'lo-c', 'br-a', 'br-b', 'he-a', 'he-b', 'kai'].map((e) => [e, 1])]
      .concat(['lo-a', 'lo-b', 'lo-c', 'br-a', 'br-b', 'he-a', 'he-b', 'kai'].map((e) => [[e, 1]]));
    for (const text of ['ლოვრეკი', 'ლოვრეკ', 'ბროდეტი', 'ჰერანო', 'ჰერან', 'მოროუ']) {
      const free = categories.map((entries) => read(kboard(entries), text)).map((r) => (r.free ? r.verdict : 'thrown'));
      expect(new Set(free).size, text).toBe(1);
    }
  });
});

describe('Darts 501: a shared Cyrillic surname follows the same coverage rule as Latin', () => {
  it('its holder in the category scores when only a less-known namesake is uncovered', () => {
    const latin = buildDirectory('player', 'rel', [E('cy-a', 'Dato Lovrek', 30), E('cy-b', 'Iko Lovrek', 20)]);
    const ru = buildDirectory('player', 'rel', [E('cy-a', 'Дато Ловрек', 30), E('cy-b', 'Ико Ловрек', 20)], 'cyrillic');
    const both = withRussian(latin, ru);
    const b = (entries: Array<[string, number]>): Board => ({ directory: both, coverage: new Set(['cy-a']), entries: entriesOf({ entries: entries.map(([eid, value]) => ({ eid, value })) }) });
    expect(read(b([['cy-a', 5]]), 'Ловрек')).toMatchObject({ free: false, eid: 'cy-a', value: 5 });
    expect(read(b([]), 'Ловрек')).toMatchObject({ free: false, verdict: 'miss', eid: 'cy-a' });
  });
});
