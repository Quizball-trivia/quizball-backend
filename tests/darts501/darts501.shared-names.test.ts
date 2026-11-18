import { describe, expect, it } from 'vitest';
import { buildDirectory, withGreek, withRussian, type TenableEntity } from '../../src/modules/tenable/tenable.identify.js';
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

  it('with an uncovered namesake as well known, its one holder in the category scores; otherwise ambiguous and free', () => {
    expect(read(board([['ana', 3]]), 'Brode')).toMatchObject({ free: false, verdict: 'score', eid: 'ana', value: 3 });
    for (const entries of [[['kai', 9]], []] as Array<Array<[string, number]>>) {
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
    // Not 'Brode': an exact name with an uncovered holder now scores its one holder in the category (owner call 2026-11-18).
    for (const text of ['Zeller', 'Zelller', 'Brodde', 'Kai Morow', 'Nobody Here']) {
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

  it('with an uncovered namesake as well known, its one holder in the category scores; otherwise ambiguous and free', () => {
    expect(read(kboard([['br-a', 3]]), 'ბროდეტი')).toMatchObject({ free: false, verdict: 'score', eid: 'br-a', value: 3 });
    for (const entries of [[['kai', 9]], []] as Array<Array<[string, number]>>) {
      expect(read(kboard(entries), 'ბროდეტი')).toEqual({ free: true, verdict: 'ambiguous', eid: null });
    }
  });

  it('one spelling for two Latin names that is no holder\'s own transliterated name is never read against the category', () => {
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
    for (const text of ['ლოვრეკი', 'ლოვრეკ', 'ჰერანო', 'ჰერან', 'მოროუ']) {
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
    // Its best-known holder uncovered: the one covered holder in the category still scores; none in it stays free.
    const top = (entries: Array<[string, number]>): Board => ({ directory: both, coverage: new Set(['cy-b']), entries: entriesOf({ entries: entries.map(([eid, value]) => ({ eid, value })) }) });
    expect(read(top([['cy-b', 6]]), 'Ловрек')).toMatchObject({ free: false, verdict: 'score', eid: 'cy-b', value: 6 });
    expect(read(top([]), 'Ловрек')).toEqual({ free: true, verdict: 'ambiguous', eid: null });
  });
});

describe('Darts 501: one holder of an exact shared name in the category wins over an uncovered namesake', () => {
  // Invented: Vel Ostrander is the best known and uncovered; Oma and Ilo Ostrander are covered.
  const dir = buildDirectory('player', 'rel', [E('vel', 'Vel Ostrander', 30), E('oma', 'Oma Ostrander', 25), E('ilo', 'Ilo Ostrander', 20), E('kai', 'Kai Morrow', 40)]);
  const cov = new Set(['oma', 'ilo', 'kai']);
  const b = (entries: Array<[string, number]>): Board => ({ directory: dir, coverage: cov, entries: entriesOf({ entries: entries.map(([eid, value]) => ({ eid, value })) }) });
  const ambiguous = { free: true, verdict: 'ambiguous', eid: null };

  it('scores the one board holder although a better-known namesake is uncovered', () => {
    expect(dir.identify('Ostrander')).toEqual({ kind: 'ambiguous' });
    expect(read(b([['oma', 12]]), 'Ostrander')).toMatchObject({ free: false, verdict: 'score', eid: 'oma', value: 12 });
    expect(read(b([['ilo', 5], ['kai', 9]]), 'Ostrander')).toMatchObject({ free: false, verdict: 'score', eid: 'ilo', value: 5 });
  });

  it('with no holder in the category, it stays ambiguous and free', () => {
    expect(read(b([['kai', 9]]), 'Ostrander')).toEqual(ambiguous);
    expect(read(b([]), 'Ostrander')).toEqual(ambiguous);
  });

  it('with two holders in the category, it stays ambiguous and free', () => {
    expect(read(b([['oma', 12], ['ilo', 5]]), 'Ostrander')).toEqual(ambiguous);
  });

  it('not when the one board holder is himself uncovered (typing his full name would be free)', () => {
    const vb: Board = { directory: dir, coverage: new Set(['ilo', 'kai']), entries: entriesOf({ entries: [{ eid: 'oma', value: 12 }] }) };
    expect(read(vb, 'Ostrander')).toEqual(ambiguous);
  });

  it('with its one board holder already thrown, it stays ambiguous and free', () => {
    expect(read(b([['oma', 12]]), 'Ostrander', ['oma'])).toEqual(ambiguous);
  });

  it('a typo near several holders keeps the stricter rule', () => {
    expect(dir.nearby('Ostrandre')).toEqual(['vel', 'oma', 'ilo']);
    expect(read(b([['oma', 12]]), 'Ostrandre')).toEqual(ambiguous);
  });

  it('not when another footballer in the category may be meant (his alias holds the word only inside a full name, or a near form)', () => {
    const G = (eid: string, name: string, fame: number, aliases: string[]): TenableEntity => ({ eid, name, known: name.split(' ')[1], fame, aliases, qualifier: null });
    const gd = buildDirectory('player', 'rel', [
      G('vel', 'Vel Ostrander', 30, ['ოსტრანდერ']), G('oma', 'Oma Ostrander', 25, ['ოსტრანდერ']),
      G('ilo', 'Ilo Ostrander', 20, ['ილო ოსტრანდერ', 'ოსტრანდერი']), G('kai', 'Kai Morrow', 40, ['მოროუ']),
    ]);
    const gb = (entries: Array<[string, number]>): Board => ({ directory: gd, coverage: new Set(['oma', 'ilo', 'kai']), entries: entriesOf({ entries: entries.map(([eid, value]) => ({ eid, value })) }) });
    expect(gd.namesakes('ოსტრანდერ')).toEqual(['vel', 'oma']);
    expect(read(gb([['oma', 12], ['kai', 9]]), 'ოსტრანდერ')).toMatchObject({ free: false, verdict: 'score', eid: 'oma' });
    expect(read(gb([['oma', 12], ['ilo', 5]]), 'ოსტრანდერ')).toEqual(ambiguous);
  });

  it('the guard also sees a run of words inside a full name, the name written without spaces, and three-letter stems', () => {
    const G = (eid: string, name: string, fame: number, aliases: string[]): TenableEntity => ({ eid, name, known: name.split(' ').slice(1).join(' '), fame, aliases, qualifier: null });
    const gd = buildDirectory('player', 'rel', [
      G('a1', 'Teo Van Brakel', 30, ['ვან ბრაკელი', 'ვანბრაკელი', 'ჯუნ']), G('a2', 'Rui Van Brakel', 25, ['ვან ბრაკელი', 'ვანბრაკელი', 'ჯუნ']),
      G('b1', 'Ilo Van Brakel', 20, ['ილო ვან ბრაკელი']), G('c1', 'Pak Jun', 20, ['პაკ ჯუნი']),
    ]);
    const gb = (entries: Array<[string, number]>): Board => ({ directory: gd, coverage: new Set(['a2', 'b1', 'c1']), entries: entriesOf({ entries: entries.map(([eid, value]) => ({ eid, value })) }) });
    expect(read(gb([['a2', 12]]), 'ვან ბრაკელი')).toMatchObject({ verdict: 'score', eid: 'a2' });
    expect(read(gb([['a2', 12], ['b1', 5]]), 'ვან ბრაკელი')).toEqual(ambiguous);
    expect(read(gb([['a2', 12], ['b1', 5]]), 'ვანბრაკელი')).toEqual(ambiguous);
    expect(read(gb([['a2', 12]]), 'ჯუნ')).toMatchObject({ verdict: 'score', eid: 'a2' });
    expect(read(gb([['a2', 12], ['c1', 5]]), 'ჯუნ')).toEqual(ambiguous);
  });
});

describe('Darts 501: the board holder wins only when the name is one Latin surname for everyone it may name', () => {
  const N = (eid: string, name: string, fame: number, aliases: string[] = []): TenableEntity => ({ eid, name, known: name.split(' ').slice(1).join(' '), fame, aliases, qualifier: null });
  const at = (directory: ReturnType<typeof buildDirectory>, entries: Array<[string, number]>): Board => ({ directory, coverage: new Set(['b', 'c']), entries: new Map(entries) });
  const ambiguous = { free: true, verdict: 'ambiguous', eid: null };

  it('not when the typed word is only an alias some holders carry (another footballer has it as his surname)', () => {
    const d = buildDirectory('player', 'rel', [N('a', 'Teo Valcor', 30, ['Bracken']), N('b', 'Rui Valcor', 25, ['Bracken']), N('c', 'Ila Bracken', 20)]);
    expect(read(at(d, [['b', 40]]), 'Bracken')).toEqual(ambiguous);
    expect(read(at(d, [['b', 40]]), 'Valcor')).toMatchObject({ verdict: 'score', eid: 'b' });
  });

  it('not when an off-board footballer with another Latin surname ends a full alias with the typed word (Georgian, Russian, Greek)', () => {
    const ka = buildDirectory('player', 'rel', [N('a', 'Vel Herrano', 30, ['ჰერანო']), N('b', 'Oma Herrano', 25, ['ჰერანო']), N('c', 'Remo Herrana', 20, ['რემო ჰერანო'])]);
    expect(read(at(ka, [['b', 40]]), 'ჰერანო')).toEqual(ambiguous);
    expect(read(at(ka, [['b', 40]]), 'ჰერანო !')).toEqual(ambiguous);
    const kaSame = buildDirectory('player', 'rel', [N('a', 'Vel Herrano', 30, ['ჰერანო']), N('b', 'Oma Herrano', 25, ['ჰერანო']), N('c', 'Remo Herrano', 20, ['რემო ჰერანო'])]);
    expect(read(at(kaSame, [['b', 40]]), 'ჰერანო')).toMatchObject({ verdict: 'score', eid: 'b' });

    const latin = buildDirectory('player', 'rel', [N('a', 'Vel Herrano', 30), N('b', 'Oma Herrano', 25), N('c', 'Remo Herrana', 20)]);
    const ru = withRussian(latin, buildDirectory('player', 'rel', [N('a', 'Вел Херано', 30), N('b', 'Ома Херано', 25), N('c', 'Ремо Херана', 20, ['Ремо Херано'])], 'cyrillic'));
    expect(read(at(ru, [['b', 40]]), 'Херано')).toEqual(ambiguous);
    const el = withGreek(latin, buildDirectory('player', 'rel', [N('a', 'Βελ Ερράνο', 30), N('b', 'Ομα Ερράνο', 25), N('c', 'Ρέμο Ερράνα', 20, ['Ρέμο Ερράνο'])], 'greek'));
    expect(read(at(el, [['b', 40]]), 'Ερράνο')).toEqual(ambiguous);
  });

  it('also for a name of several words, spaced or written together', () => {
    const d = buildDirectory('player', 'rel', [
      N('a', 'Teo Van Brakel', 30, ['ვან ბრაკელი', 'ვანბრაკელი']), N('b', 'Rui Van Brakel', 25, ['ვან ბრაკელი', 'ვანბრაკელი']),
      N('c', 'Remo Brakell', 20, ['რემო ვან ბრაკელი']),
    ]);
    expect(read(at(d, [['b', 40]]), 'ვან ბრაკელი')).toEqual(ambiguous);
    expect(read(at(d, [['b', 40]]), 'ვანბრაკელი')).toEqual(ambiguous);
    const same = buildDirectory('player', 'rel', [
      N('a', 'Teo Van Brakel', 30, ['ვან ბრაკელი', 'ვანბრაკელი']), N('b', 'Rui Van Brakel', 25, ['ვან ბრაკელი', 'ვანბრაკელი']),
    ]);
    expect(read(at(same, [['b', 40]]), 'ვანბრაკელი')).toMatchObject({ verdict: 'score', eid: 'b' });
    // Holders know it only written together; the off-board namesake only spaced.
    const apart = buildDirectory('player', 'rel', [
      N('a', 'Teo Van Brakel', 30, ['ვანბრაკელი']), N('b', 'Rui Van Brakel', 25, ['ვანბრაკელი']), N('c', 'Remo Brakell', 20, ['რემო ვან ბრაკელი']),
    ]);
    expect(read(at(apart, [['b', 40]]), 'ვანბრაკელი')).toEqual(ambiguous);
    // The other way round: holders spaced, the off-board namesake's whole name written together.
    const together = buildDirectory('player', 'rel', [
      N('a', 'Teo Van Brakel', 30, ['ვან ბრაკელი']), N('b', 'Rui Van Brakel', 25, ['ვან ბრაკელი']), N('c', 'Remo Brakell', 20, ['რემოვანბრაკელი']),
    ]);
    expect(read(at(together, [['b', 40]]), 'ვან ბრაკელი')).toEqual(ambiguous);
  });

  it('the guard sees the name written together inside another board entry\'s longer name', () => {
    const d = buildDirectory('player', 'rel', [
      N('a', 'Teo De La Cruz', 30, ['დე ლა კრუს', 'დელაკრუს']), N('b', 'Rui De La Cruz', 25, ['დე ლა კრუს', 'დელაკრუს']),
      N('c', 'Remo Solano', 20, ['რემო დე ლა კრუს სოლანო']),
    ]);
    expect(read(at(d, [['b', 40]]), 'დელაკრუს')).toMatchObject({ verdict: 'score', eid: 'b' });
    expect(read(at(d, [['b', 40], ['c', 20]]), 'დელაკრუს')).toEqual(ambiguous);
  });

  it('the guard on other board entries matches whole words only, never the end of a longer one', () => {
    const d = buildDirectory('player', 'rel', [N('a', 'Vel Orr', 30), N('b', 'Oma Orr', 25), N('c', 'Ila Horr', 20)]);
    expect(read(at(d, [['b', 40], ['c', 20]]), 'Orr')).toMatchObject({ verdict: 'score', eid: 'b' });
  });

  // Below, the uncovered namesake is as well known as the board's holder: when the new win does not fire, the rule before
  // it keeps the dart ambiguous.
  it('an off-board footballer with another Latin surname and the name inside a one-word alias blocks it (Georgian, Russian, Greek)', () => {
    const ka = buildDirectory('player', 'rel', [N('a', 'Tavo Lovrek', 30, ['ლოვრეკი']), N('b', 'Daro Lovrek', 30, ['ლოვრეკი']), N('c', 'Rati Lovrack', 20, ['რატილოვრეკი'])]);
    expect(read({ directory: ka, coverage: new Set(['a']), entries: new Map([['a', 40]]) }, 'ლოვრეკი')).toEqual(ambiguous);
    const latin = buildDirectory('player', 'rel', [N('a', 'Tavo Lovrek', 30), N('b', 'Daro Lovrek', 30), N('c', 'Rati Lovrack', 20)]);
    const ru = withRussian(latin, buildDirectory('player', 'rel', [N('a', 'Таво Ловрек', 30), N('b', 'Даро Ловрек', 30), N('c', 'Рати Ловрак', 20, ['Ратиловрек'])], 'cyrillic'));
    expect(read({ directory: ru, coverage: new Set(['a']), entries: new Map([['a', 40]]) }, 'Ловрек')).toEqual(ambiguous);
    const el = withGreek(latin, buildDirectory('player', 'rel', [N('a', 'Ταβο Λοβρεκ', 30), N('b', 'Νταρο Λοβρεκ', 30), N('c', 'Ρατι Λοβρακ', 20, ['Ρατιλοβρεκ'])], 'greek'));
    expect(read({ directory: el, coverage: new Set(['a']), entries: new Map([['a', 40]]) }, 'Λοβρεκ')).toEqual(ambiguous);
  });

  it('letters of another script around a Latin alias do not skip the own-name check', () => {
    const d = buildDirectory('player', 'rel', [N('a', 'Tavo Lovrek', 30, ['Tern']), N('b', 'Daro Lovrek', 30, ['Tern'])]);
    for (const text of ['Tern', 'Tern\u0416', 'Tern\u03b1', 'Tern\u4e2d']) {
      expect(read({ directory: d, coverage: new Set(['a']), entries: new Map([['a', 40]]) }, text), text).toEqual(ambiguous);
    }
  });

  it('when it is not one surname, the rule before this one decides, as it did before the new win', () => {
    // Daro uncovered but far less known than Tavo: that rule reads the name as Tavo (unchanged on purpose: making these
    // free loses thousands of right answers on real boards).
    const ka = buildDirectory('player', 'rel', [N('a', 'Tavo Lovrek', 30, ['ლოვრეკი']), N('b', 'Daro Lovrek', 20, ['ლოვრეკი']), N('c', 'Rati Lovrack', 10, ['რატი ლოვრეკი'])]);
    expect(read({ directory: ka, coverage: new Set(['a']), entries: new Map([['a', 40]]) }, 'ლოვრეკი')).toMatchObject({ verdict: 'score', eid: 'a' });
    const tie = buildDirectory('player', 'rel', [N('a', 'Tavo Lovrek', 30, ['ლოვრეკი']), N('b', 'Daro Lovrek', 30, ['ლოვრეკი']), N('c', 'Rati Lovrack', 10, ['რატი ლოვრეკი'])]);
    expect(read({ directory: tie, coverage: new Set(['a']), entries: new Map([['a', 40]]) }, 'ლოვრეკი')).toEqual(ambiguous);
  });

  it('a board entry whose one-word alias ends with the name blocks it', () => {
    // Daro as well known as Tavo and uncovered: the rule before this one keeps it ambiguous.
    const ka = buildDirectory('player', 'rel', [N('a', 'Tavo Lovrek', 30, ['ლოვრეკი']), N('b', 'Daro Lovrek', 30, ['ლოვრეკი']), N('c', 'Rati Lovrek', 20, ['რატილოვრეკი'])]);
    expect(read({ directory: ka, coverage: new Set(['a', 'c']), entries: new Map([['a', 40]]) }, 'ლოვრეკი')).toMatchObject({ verdict: 'score', eid: 'a' });
    expect(read({ directory: ka, coverage: new Set(['a', 'c']), entries: new Map([['a', 40], ['c', 70]]) }, 'ლოვრეკი')).toEqual(ambiguous);
  });

  it('an own name written without spaces counts as the own name (never an alias written so)', () => {
    const d = buildDirectory('player', 'rel', [N('a', 'Teo Valcor', 30), N('b', 'Teo Valcor', 30)]);
    const b = { directory: d, coverage: new Set(['a']), entries: new Map([['a', 40]]) };
    expect(read(b, 'Teo Valcor')).toMatchObject({ verdict: 'score', eid: 'a' });
    expect(read(b, 'TeoValcor')).toMatchObject({ verdict: 'score', eid: 'a' });
  });

  it('an off-board alias spaced elsewhere in the same letters blocks both the spaced and the joined answer', () => {
    const d = buildDirectory('player', 'rel', [
      N('a', 'Teo Van Brakel', 30, ['ვან ბრაკელი', 'ვანბრაკელი']), N('b', 'Rui Van Brakel', 30, ['ვან ბრაკელი', 'ვანბრაკელი']),
      N('c', 'Remo Brakell', 20, ['რემო ვანბრა კელი']),
    ]);
    const b = { directory: d, coverage: new Set(['b']), entries: new Map([['b', 40]]) };
    expect(read(b, 'ვან ბრაკელი')).toEqual(ambiguous);
    expect(read(b, 'ვანბრაკელი')).toEqual(ambiguous);
  });

  it('tail words are looked up in the directory that reads the answer (a numeric last word in Greek)', () => {
    const latin = buildDirectory('player', 'rel', [N('a', 'Teo Smoll', 30), N('b', 'Rui Smoll', 30), N('c', 'Remo Jarvik', 20)]);
    const el = withGreek(latin, buildDirectory('player', 'rel', [
      N('a', 'Τεο Σμολ', 30, ['Σμολ 2']), N('b', 'Ρουι Σμολ', 30, ['Σμολ 2']), N('c', 'Ρεμο Τζαρβικ', 20, ['Ρεμο Σμολ 2']),
    ], 'greek'));
    const b = { directory: el, coverage: new Set(['b']), entries: new Map([['b', 40]]) };
    expect(el.namesakes('Σμολ 2')).toEqual(['a', 'b']);
    expect(read(b, 'Σμολ 2')).toEqual(ambiguous);
  });
});

describe('Darts 501: one spelling for different Latin surnames scores its one holder in the category (Georgian, Russian, Greek)', () => {
  const N = (eid: string, name: string, fame: number, aliases: string[] = []): TenableEntity => ({ eid, name, known: name.split(' ').slice(1).join(' ') || name, fame, aliases, qualifier: null });
  // Invented: "Pavo Rellin" and "Gio Rellyn" are both "რელინი" in Georgian.
  const ka = buildDirectory('player', 'rel', [
    N('pav', 'Pavo Rellin', 45, ['პავო რელინი', 'რელინი']), N('gio', 'Gio Rellyn', 42, ['ჯიო რელინი', 'რელინი']),
    N('mon', 'Tavinho', 40, ['ტავინიო']), N('tav', 'Lu Tavinyo', 30, ['ტავინიო']),
    N('tag', 'Remo Ostin', 30, ['რემო ოსტინი', 'ბორა']), N('bor', 'Ilo Borah', 25, ['ილო ბორა', 'ბორა']),
    N('kai', 'Kai Morrow', 40, ['კაი მოროუ', 'მოროუ']), N('rel', 'Dino Relini', 10, ['დინო რელინის']),
  ]);
  const cov = new Set(['pav', 'gio', 'mon', 'tav', 'tag', 'bor', 'kai', 'rel']);
  const at = (entries: Array<[string, number]>, coverage: ReadonlySet<string> = cov): Board => ({ directory: ka, coverage, entries: new Map(entries) });
  const ambiguous = { free: true, verdict: 'ambiguous', eid: null };

  it('scores the one holder in the category, whichever of them it is', () => {
    expect(ka.identify('რელინი')).toEqual({ kind: 'ambiguous' });
    expect(read(at([['pav', 40], ['kai', 9]]), 'რელინი')).toMatchObject({ free: false, verdict: 'score', eid: 'pav', value: 40 });
    expect(read(at([['gio', 30]]), 'რელინი')).toMatchObject({ free: false, verdict: 'score', eid: 'gio', value: 30 });
  });

  it('none or both of them in the category, or the one thrown already or uncovered: ambiguous and free as before', () => {
    expect(read(at([['kai', 9]]), 'რელინი')).toEqual(ambiguous);
    expect(read(at([['pav', 40], ['gio', 30]]), 'რელინი')).toEqual(ambiguous);
    expect(read(at([['pav', 40]]), 'რელინი', ['pav'])).toEqual(ambiguous);
    expect(read(at([['pav', 40]], new Set(['gio'])), 'რელინი')).toEqual(ambiguous);
  });

  it('never on a lone spelling alone, a one-name footballer\'s included (it may be a tag)', () => {
    expect(read(at([['mon', 12]]), 'ტავინიო')).toEqual(ambiguous);
    expect(read(at([['tav', 12]]), 'ტავინიო')).toEqual(ambiguous);
  });

  it('never with a Latin letter in the text, one the normaliser drops included', () => {
    expect(read(at([['pav', 40]]), 'რელინი a')).toEqual(ambiguous);
    expect(read(at([['pav', 40]]), 'რელინი ə')).toEqual(ambiguous);
  });

  it('never when the spelling is only a lone alias tag of the holder in the category', () => {
    expect(read(at([['tag', 12]]), 'ბორა')).toEqual(ambiguous);
    expect(read(at([['bor', 12]]), 'ბორა')).toMatchObject({ verdict: 'score', eid: 'bor' });
  });

  it('never when another entry in the category may be meant (a near form of one of his names)', () => {
    expect(read(at([['pav', 40], ['rel', 5]]), 'რელინი')).toEqual(ambiguous);
    // Within a typo of his name of several words written together.
    const d = buildDirectory('player', 'rel', [
      N('pd', 'Pavo Derini', 45, ['პავო დერინი', 'დერინი']), N('gd', 'Gio Deryni', 42, ['ჯიო დერინი', 'დერინი']), N('rd', 'Rio De Rina', 40, ['რიო დე რინა', 'დე რინა']),
    ]);
    const b = (entries: Array<[string, number]>): Board => ({ directory: d, coverage: new Set(['pd', 'gd', 'rd']), entries: new Map(entries) });
    expect(read(b([['pd', 40]]), 'დერინი')).toMatchObject({ verdict: 'score', eid: 'pd' });
    expect(read(b([['pd', 40], ['rd', 20]]), 'დერინი')).toEqual(ambiguous);
    // Typed in Latin, an exact shared surname keeps the Latin rule: a near run of another entry's words does not block it.
    const latin = buildDirectory('player', 'rel', [N('pd', 'Pavo Derini', 45), N('gd', 'Gio Derini', 42), N('rd', 'Rio De Rina', 40)]);
    const lb = { directory: latin, coverage: new Set(['gd', 'rd']), entries: new Map([['gd', 30], ['rd', 20]]) };
    expect(read(lb, 'Derini')).toMatchObject({ free: false, verdict: 'score', eid: 'gd' });
  });

  it('typed in Latin, the Latin rules stand unchanged', () => {
    const latin = buildDirectory('player', 'rel', [N('pav', 'Pavo Rellin', 45, ['Rellyn']), N('gio', 'Gio Rellyn', 42)]);
    // Its best-known holder uncovered: the rule before keeps it free, and the spelling rule is for other scripts only.
    expect(read({ directory: latin, coverage: new Set(['gio']), entries: new Map([['gio', 30]]) }, 'Rellyn')).toEqual(ambiguous);
  });

  it('a reading of the spelling as its dominant holder outside the category gives way to its one holder in it', () => {
    // Invented: "Ugo Selle" dominates "სელე", which is also "Rio Sollé" in Georgian.
    const d = buildDirectory('player', 'rel', [N('ugo', 'Ugo Selle', 60, ['უგო სელე', 'სელე']), N('rio', 'Rio Sollé', 25, ['რიო სელე', 'სელე']), N('kai', 'Kai Morrow', 40)]);
    const b = (entries: Array<[string, number]>): Board => ({ directory: d, coverage: new Set(['ugo', 'rio', 'kai']), entries: new Map(entries) });
    expect(d.identify('სელე')).toEqual({ kind: 'entity', eid: 'ugo' });
    expect(read(b([['rio', 14]]), 'სელე')).toMatchObject({ free: false, verdict: 'score', eid: 'rio', value: 14 });
    expect(read(b([['kai', 9]]), 'სელე')).toMatchObject({ free: false, verdict: 'miss', eid: 'ugo' });
    expect(read(b([['ugo', 7], ['rio', 14]]), 'სელე')).toMatchObject({ verdict: 'score', eid: 'ugo' });
    // Already thrown: the costly reading stands (no free probe).
    expect(read(b([['rio', 14]]), 'სელე', ['rio'])).toMatchObject({ free: false, verdict: 'miss', eid: 'ugo' });
  });

  it('Russian and Greek spellings follow the same rule', () => {
    const latin = buildDirectory('player', 'rel', [N('pav', 'Pavo Rellin', 45), N('gio', 'Gio Rellyn', 42)]);
    const ru = withRussian(latin, buildDirectory('player', 'rel', [N('pav', 'Паво Реллин', 45), N('gio', 'Джо Реллин', 42)], 'cyrillic'));
    const el = withGreek(latin, buildDirectory('player', 'rel', [N('pav', 'Πάβο Ρέλιν', 45), N('gio', 'Τζο Ρέλιν', 42)], 'greek'));
    for (const [d, text] of [[ru, 'Реллин'], [el, 'Ρέλιν']] as const) {
      expect(read({ directory: d, coverage: new Set(['pav', 'gio']), entries: new Map([['gio', 30]]) }, text)).toMatchObject({ verdict: 'score', eid: 'gio' });
      expect(read({ directory: d, coverage: new Set(['pav', 'gio']), entries: new Map() }, text)).toEqual(ambiguous);
    }
  });

  it('free verdicts never depend on the category (no oracle)', () => {
    const ids = ['pav', 'gio', 'mon', 'tav', 'tag', 'bor', 'kai', 'rel'];
    const categories: Array<Array<[string, number]>> = [[], ids.map((e) => [e, 1])].concat(ids.map((e) => [[e, 1]]));
    for (const text of ['რელინი', 'ტავინიო', 'ბორა']) {
      const free = categories.map((entries) => read(at(entries), text)).map((r) => (r.free ? r.verdict : 'thrown'));
      expect(new Set(free).size, text).toBeLessThanOrEqual(2);
      expect(free.filter((v) => v !== 'thrown' && v !== 'ambiguous'), text).toEqual([]);
    }
  });
});

describe('Darts 501: a short Latin typo with one dominant near spelling reads as him', () => {
  const N = (eid: string, name: string, fame: number, aliases: string[] = []): TenableEntity => ({ eid, name, known: name.split(' ').slice(1).join(' '), fame, aliases, qualifier: null });
  // Invented. "Havren" is a letter from Havrenz and Havrena; Havrenz is far better known.
  const d = buildDirectory('player', 'rel', [
    N('hz', 'Kai Havrenz', 90, ['კაი ჰავრენცი', 'ჰავრენცი']), N('ha', 'Joe Havrena', 5, ['ჯო ჰავრენა', 'ჰავრენა']),
    N('dg', 'Ivo Dorgan', 80), N('dl', 'Ari Dorgal', 3), N('dn', 'Teo Dorganelli', 50),
    N('ml', 'Uri Melkan', 50), N('mk', 'Sem Melkon', 40), N('sm', 'Ola Smeek', 30), N('sk', 'Ilo Smeel', 5),
    N('kai', 'Kai Morrow', 40),
  ]);
  const cov = new Set(['hz', 'ha', 'dg', 'dl', 'dn', 'ml', 'mk', 'sm', 'sk', 'kai']);
  const at = (entries: Array<[string, number]>, coverage: ReadonlySet<string> = cov): Board => ({ directory: d, coverage, entries: new Map(entries) });
  const ambiguous = { free: true, verdict: 'ambiguous', eid: null };

  it('scores him in the category and misses without him, as his name would', () => {
    expect(d.identify('Havren')).toEqual({ kind: 'ambiguous' });
    expect(d.nearby('Havren')).toEqual([]);
    expect(read(at([['hz', 27], ['kai', 9]]), 'Havren')).toMatchObject({ free: false, verdict: 'score', eid: 'hz', value: 27 });
    expect(read(at([['kai', 9]]), 'Havren')).toMatchObject({ free: false, verdict: 'miss', eid: 'hz' });
    // The less-known near spelling in the category does not score: the typo reads as the dominant one.
    expect(read(at([['ha', 12]]), 'Havren')).toMatchObject({ free: false, verdict: 'miss', eid: 'hz' });
    expect(read(at([['hz', 27]]), 'Havren', ['hz'])).toEqual({ free: true, verdict: 'repeat', eid: 'hz' });
  });

  it('never in another script: a transliteration sits a letter from other people\'s names', () => {
    expect(d.nearby('ჰავრენც')).toEqual([]);
    for (const entries of [[['hz', 27]], [['ha', 12]], []] as Array<Array<[string, number]>>) {
      expect(read(at(entries), 'ჰავრენც')).toEqual(ambiguous);
    }
  });

  it('his numbers uncovered: free and uncovered, whatever the category holds', () => {
    const without = new Set([...cov].filter((eid) => eid !== 'hz'));
    for (const entries of [[['hz', 27]], [['ha', 12]], []] as Array<Array<[string, number]>>) {
      expect(read(at(entries, without), 'Havren')).toEqual({ free: true, verdict: 'uncovered', eid: 'hz' });
    }
  });

  it('stays ambiguous without a dominant near spelling, or with a better-known one under DOMINANT_MIN_FAME', () => {
    expect(read(at([['ml', 5]]), 'Melkn')).toEqual(ambiguous);
    expect(read(at([['sm', 5]]), 'Smee')).toEqual({ free: true, verdict: 'unknown', eid: null });
    expect(read(at([['sm', 5]]), 'Smeed')).toEqual(ambiguous);
  });

  it('never when the suggestions for its start are a full list (a well-known start may be hidden behind it)', () => {
    const fill = ['alto', 'belo', 'caro', 'delo', 'erto', 'faro', 'gano', 'hilo'].map((end, i) => N(`f${i}`, `Uma Havren${end}`, 1));
    const crowded = buildDirectory('player', 'rel', [N('hz', 'Kai Havrenz', 90), N('ha', 'Joe Havrena', 5), ...fill]);
    expect(crowded.suggest('Havren').length).toBe(8);
    expect(read({ directory: crowded, coverage: new Set(['hz', 'ha']), entries: new Map([['hz', 27]]) }, 'Havren')).toEqual(ambiguous);
  });

  it('never for an unfinished answer: the start of another well-known name, or a word under three letters', () => {
    expect(d.suggest('Dorga').map((s) => s.eid)).toContain('dn');
    expect(read(at([['dg', 5]]), 'Dorga')).toEqual(ambiguous);
    expect(read(at([['hz', 27]]), 'Havren K')).toEqual(ambiguous);
  });

  it('free verdicts never depend on the category (no oracle)', () => {
    const ids = [...cov];
    const categories: Array<Array<[string, number]>> = [[], ids.map((e) => [e, 1])].concat(ids.map((e) => [[e, 1]]));
    for (const text of ['Havren', 'ჰავრენც', 'Melkn', 'Smeed', 'Dorga', 'Havren K']) {
      const free = categories.map((entries) => read(at(entries), text)).map((r) => (r.free ? r.verdict : 'thrown'));
      expect(new Set(free.filter((v) => v !== 'thrown')).size, text).toBeLessThanOrEqual(1);
      expect(free.every((v) => v === 'thrown') || free.every((v) => v !== 'thrown'), text).toBe(true);
    }
  });
});
