import { describe, expect, it } from 'vitest';
import { buildDirectory, judge, type TenableEntity, type Verdict } from '../../src/modules/tenable/tenable.identify.js';
import { normalizeName, surnameOf } from '../../src/modules/footballers/footballers.text.js';

// Invented footballers only: the repository is public.
const E = (eid: string, name: string, known: string, fame: number, aliases: string[] = [], qualifier: string | null = null): TenableEntity =>
  ({ eid, name, known, fame, aliases, qualifier });
const ROWS = [
  E('p-bako', 'Bako', 'Bako', 90),
  E('p-orlen', 'Tarin Orlen', 'Orlen', 80, ['T. Orlen']),
  E('p-orlen2', 'Davi Orlen', 'Orlen', 20),
  E('p-ronda', 'Ronda Aliero', 'Ronda', 100),
  E('p-ronda2', 'Cristo Ronda', 'Ronda', 100),
  E('p-valen', 'Dario de Valen', 'de Valen', 60),
  E('p-brando', 'Stefano Brandolini', 'Brandolini', 15),
  E('p-geo', 'Luka Dzneladze', 'Dzneladze', 50, ['ლუკა ძნელაძე']),
  E('p-ilter', 'Özkan İlter', 'İlter', 30),
  E('p-twin-a', 'Juan Perel', 'Perel', 30, [], 'ARG · 1990'),
  E('p-twin-b', 'Juan Perel', 'Perel', 25, [], 'URU · 1994'),
  E('p-mark', 'Mark Tobin', 'Tobin', 45),
];
const dir = buildDirectory('player', 'rel-1', ROWS);
const id = (text: string) => dir.identify(text);

describe('identify (list-independent)', () => {
  it('reads full names, known names and aliases, any case or accent', () => {
    expect(id('tarin orlen')).toEqual({ kind: 'entity', eid: 'p-orlen' });
    expect(id('T. ORLEN')).toEqual({ kind: 'entity', eid: 'p-orlen' });
    expect(id('ozkan ilter')).toEqual({ kind: 'entity', eid: 'p-ilter' });
    expect(id('ილტერ')).toEqual({ kind: 'unknown' });
    expect(id('ლუკა ძნელაძე')).toEqual({ kind: 'entity', eid: 'p-geo' });
  });

  it('a shared name means its holder only when that one dominates', () => {
    expect(id('Orlen')).toEqual({ kind: 'entity', eid: 'p-orlen' }); // 80 vs 20
    expect(id('Ronda')).toEqual({ kind: 'ambiguous' }); // 100 vs 100
    expect(id('Juan Perel')).toEqual({ kind: 'ambiguous' }); // identical full names, neither dominant
  });

  it('a one-word known name gets no shortcut past the dominance rule', () => {
    const vega = buildDirectory('player', 'r', [E('a', 'Adrian Vega', 'Vega', 80), E('b', 'Bruno Vega', 'Vega', 70)]);
    expect(vega.identify('Vega')).toEqual({ kind: 'ambiguous' });
    expect(vega.identify('Adrian Vega')).toEqual({ kind: 'entity', eid: 'a' });
    expect(vega.identify('adrianvega')).toEqual({ kind: 'entity', eid: 'a' });
    const mono = buildDirectory('player', 'r', [E('a', 'Edson Arantes', 'Peleo', 100), E('b', 'Abedi Ayew', 'Peleo', 30)]);
    expect(mono.identify('Peleo')).toEqual({ kind: 'entity', eid: 'a' });
  });

  it('a typo close to two people is ambiguous, not the better-known one', () => {
    const twins = buildDirectory('player', 'r', [E('a', 'Aro Bellan', 'Bellan', 90), E('b', 'Aro Bellon', 'Bellon', 10)]);
    expect(twins.identify('Aro Bellen')).toEqual({ kind: 'ambiguous' });
    expect(twins.identify('Aro Bellan')).toEqual({ kind: 'entity', eid: 'a' });
  });

  it('never identifies by a particle, a first name or a short word', () => {
    expect(id('de')).toEqual({ kind: 'unknown' });
    expect(id('Dario')).toEqual({ kind: 'unknown' });
    expect(id('Mark')).toEqual({ kind: 'unknown' });
    expect(id('Valen')).toEqual({ kind: 'entity', eid: 'p-valen' }); // the surname
    expect(id('de Valen')).toEqual({ kind: 'entity', eid: 'p-valen' }); // the known name
    expect(id('x')).toEqual({ kind: 'unknown' });
  });

  it('forgives typos by length, only towards one decision', () => {
    expect(id('Brandolni')).toEqual({ kind: 'entity', eid: 'p-brando' });
    expect(id('Stefano Brandolinni')).toEqual({ kind: 'entity', eid: 'p-brando' });
    expect(id('Dznelaze')).toEqual({ kind: 'entity', eid: 'p-geo' });
    expect(id('Bkao')).toEqual({ kind: 'unknown' }); // 4 letters: no typos
    expect(id('Zzzzzzzz')).toEqual({ kind: 'unknown' });
  });
});

describe('judge', () => {
  const list = ['p-bako', 'p-orlen', 'p-valen', 'p-brando', 'p-geo', 'p-ilter', 'p-twin-a', 'p-mark', 'p-ronda', 'p-orlen2'];
  it('right, repeat and wrong come from the identity, then the list', () => {
    expect(judge(dir, list, new Set(), 'Orlen')).toEqual({ kind: 'right', slot: 1, eid: 'p-orlen' });
    expect(judge(dir, list, new Set([1]), 'Tarin Orlen')).toEqual({ kind: 'repeat', slot: 1, eid: 'p-orlen' });
    expect(judge(dir, list.filter((e) => e !== 'p-geo'), new Set(), 'Dzneladze')).toEqual({ kind: 'wrong', eid: 'p-geo' });
    // Davi Orlen is on the list, but "Orlen" means Tarin: Davi needs his full name.
    expect(judge(dir, list, new Set([1]), 'Orlen')).toEqual({ kind: 'repeat', slot: 1, eid: 'p-orlen' });
    expect(judge(dir, list, new Set(), 'Davi Orlen')).toEqual({ kind: 'right', slot: 9, eid: 'p-orlen2' });
  });

  it('a picked suggestion settles the identity; an unknown id falls back to the text', () => {
    expect(judge(dir, list, new Set(), 'Juan Perel', 'p-twin-a')).toEqual({ kind: 'right', slot: 6, eid: 'p-twin-a' });
    expect(judge(dir, list, new Set(), 'Juan Perel', 'p-twin-b')).toEqual({ kind: 'wrong', eid: 'p-twin-b' });
    expect(judge(dir, list, new Set(), 'Juan Perel', 'p-nobody')).toEqual({ kind: 'ambiguous' });
  });

  it('every verdict other than right/wrong/repeat is the same whatever the list holds (no oracle)', () => {
    // Every name and word of every entity, mangled by one and two edits in several places, plus hand-picked cases.
    const mangle = (s: string, at: number, edits: number) => {
      let out = s;
      for (let k = 0; k < edits; k += 1) { const i = (at + k * 3) % Math.max(1, out.length); out = `${out.slice(0, i)}x${out.slice(i + 1)}`; }
      return out;
    };
    const forms = ROWS.flatMap((r) => [r.name, r.known, ...r.aliases, ...r.name.split(' ')]);
    const texts = [
      'Ronda', 'Juan Perel', 'de', 'Dario', 'AlvXro NesXor', 'Brandolinni', 'Orlem', 'Zzzzzz', 'ilter', 'ლუკა', 'Tobn', 'perel', 'Bkao',
      ...forms.flatMap((f) => [0, 1, 2, 4].flatMap((at) => [mangle(f, at, 1), mangle(f, at, 2)])),
    ];
    const lists = [list, ['p-twin-b', 'p-ronda2', 'p-mark'], [], ROWS.map((r) => r.eid)];
    const free = (v: Verdict) => (v.kind === 'ambiguous' || v.kind === 'unknown' ? v.kind : 'judged');
    for (const text of texts) {
      const seen = new Set(lists.map((l) => free(judge(dir, l, new Set(), text))));
      expect(seen.size, text).toBe(1);
    }
  });
});

describe('suggest', () => {
  it('prefix search over names and identifying words, best known first, with qualifiers', () => {
    expect(dir.suggest('or').map((s) => s.eid)).toEqual(['p-orlen', 'p-orlen2']);
    expect(dir.suggest('juan p')).toEqual([
      { eid: 'p-twin-a', label: 'Juan Perel', qualifier: 'ARG · 1990' },
      { eid: 'p-twin-b', label: 'Juan Perel', qualifier: 'URU · 1994' },
    ]);
    expect(dir.suggest('ro').map((s) => s.eid)).toEqual(['p-ronda', 'p-ronda2']);
    expect(dir.suggest('d')).toEqual([]);
    expect(dir.suggest('ლუკ').map((s) => s.eid)).toEqual(['p-geo']);
  });

  it('never returns more than the limit', () => {
    const many = buildDirectory('player', 'rel-2', Array.from({ length: 30 }, (_, i) => E(`p-${i}`, `Saro Test${i}`, `Test${i}`, i)));
    expect(many.suggest('saro')).toHaveLength(8);
    expect(many.suggest('saro')[0].eid).toBe('p-29');
  });

  it('a short prefix gives the best known first, whether a full name or only a surname matches', () => {
    const rows = [...Array.from({ length: 12 }, (_, i) => E(`p-s${i}`, `Saro Vintel ${i}`, `Vintel ${i}`, 10 + i)), E('p-sarm', 'Pedro Sarmiento', 'Sarmiento', 99)];
    const d = buildDirectory('player', 'rel-s', rows);
    for (const q of ['sa', 'sar', 'sarm']) expect(d.suggest(q)[0].eid).toBe('p-sarm');
    expect(d.suggest('sa')).toHaveLength(8);
    expect(d.suggest('sa').map((s) => s.eid)).toEqual(['p-sarm', 'p-s11', 'p-s10', 'p-s9', 'p-s8', 'p-s7', 'p-s6', 'p-s5']);
    expect(d.suggest('sa', 3)).toHaveLength(3);
  });

  it('names whose shown words match come before ones matched only by an alias, best known first within each', () => {
    const d = buildDirectory('club', 'rel-c', [
      E('c-tot', 'Totten Rovers', 'Totten Rovers', 100, ['Spurtons']),
      E('c-laz', 'SS Lavio', 'SS Lavio', 95, ['Sportiva Lavio']),
      E('c-spo', 'Sporta CP', 'Sporta CP', 70),
      E('c-hay', 'HNK Hayduk Splet', 'HNK Hayduk Splet', 40),
      E('c-mon', 'Montrel Sport Club', 'Montrel Sport Club', 30),
    ]);
    expect(d.suggest('sp').map((s) => s.eid)).toEqual(['c-spo', 'c-hay', 'c-mon', 'c-tot', 'c-laz']);
    expect(d.suggest('spor').map((s) => s.eid)).toEqual(['c-spo', 'c-mon', 'c-laz']);
    expect(d.suggest('sp', 2).map((s) => s.eid)).toEqual(['c-spo', 'c-hay']);
    expect(d.suggest('spurt').map((s) => s.eid)).toEqual(['c-tot']);
    expect(d.suggest('tot').map((s) => s.eid)).toEqual(['c-tot']);
  });

  it('matches a plain search for every short and longer prefix: shown-name matches first, then alias-only, by fame', () => {
    const first = ['Saro', 'Sami', 'Tavo', 'Sandro', 'Mirel'];
    const last = ['Santin', 'Sarvel', 'Tobin', 'Mareno', 'de Savo'];
    const rows = Array.from({ length: 60 }, (_, i) => E(
      `p-${String(i).padStart(2, '0')}`,
      `${first[i % 5]} ${last[(i * 3) % 5]} ${i % 4 === 0 ? 'Sallen' : ''}`.trim(),
      i % 6 === 0 ? `Sam${i}` : i === 7 || i === 13 ? 'Torres' : last[(i * 3) % 5],
      (i * 7) % 11,
      i % 3 === 0 ? [`Sapo${i % 5}`, `Tasar Mel${i}`, `Torno${i % 4}`] : [],
    ));
    const d = buildDirectory('player', 'rel-o', rows);
    const keysOf = (e: TenableEntity) => {
      const whole = [e.name, e.known, ...e.aliases].map(normalizeName);
      const keys = whole.filter((k) => k.includes(' ')).flatMap((k) => [k, k.replace(/ /g, '')]);
      for (const w of [surnameOf(e.name), ...whole.filter((k) => !k.includes(' '))]) if (w.length >= 3 && !['de'].includes(w)) keys.push(w);
      return keys;
    };
    const shownOf = (e: TenableEntity) => [e.name, e.known].map(normalizeName).flatMap((n) => [n, n.replace(/ /g, ''), ...n.split(' ').filter((w) => w !== 'de')]);
    const byFame = (a: TenableEntity, b: TenableEntity) => b.fame - a.fame || (a.eid < b.eid ? -1 : 1);
    const prefixes = new Set(rows.flatMap((e) => [...keysOf(e), ...shownOf(e)]).flatMap((k) => [2, 3, 4].map((n) => k.slice(0, n))).filter((q) => q.trim().length >= 2 && q === normalizeName(q)));
    expect(prefixes.size).toBeGreaterThan(30);
    let mixed = 0;
    for (const q of prefixes) {
      const shown = rows.filter((e) => shownOf(e).some((k) => k.startsWith(q))).sort(byFame);
      const alias = rows.filter((e) => !shown.includes(e) && keysOf(e).some((k) => k.startsWith(q))).sort(byFame);
      expect(d.suggest(q).map((s) => s.eid), q).toEqual([...shown, ...alias].slice(0, 8).map((e) => e.eid));
      if (shown.length && shown.length < 8 && alias.length) mixed += 1;
    }
    expect(mixed).toBeGreaterThan(0);
  });

  it('refuses a release with a duplicate id', () => {
    expect(() => buildDirectory('player', 'r', [ROWS[0], ROWS[0]])).toThrow();
  });
});
