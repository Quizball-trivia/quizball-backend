import { describe, expect, it } from 'vitest';
import { buildDirectory, type TenableEntity } from '../../src/modules/tenable/tenable.identify.js';
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

  it('a typo near several footballers is read the same way', () => {
    expect(directory.nearby('Zelller')).toEqual(['rik', 'tam', 'pol']);
    expect(read(board([['tam', 40]]), 'Zelller')).toMatchObject({ free: false, eid: 'tam', value: 40 });
    expect(read(board([['kai', 9]]), 'Zelller')).toMatchObject({ free: false, verdict: 'miss', eid: 'rik' });
  });

  it('free verdicts never depend on the category (no oracle)', () => {
    const categories: Array<Array<[string, number]>> = [[], [['rik', 1]], [['tam', 1]], [['pol', 1]], [['ana', 1]], [['ben', 1]], [['kai', 1]]];
    for (const text of ['Zeller', 'Zelller', 'Brode', 'Brodde', 'Kai Morow', 'Nobody Here']) {
      const free = categories.map((entries) => read(board(entries), text)).map((r) => (r.free ? r.verdict : 'thrown'));
      expect(new Set(free).size, text).toBe(1);
    }
  });
});
