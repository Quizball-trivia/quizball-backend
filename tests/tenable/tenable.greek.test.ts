import { describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ rows: [] as Array<{ locale: string; kind: string; eid: string; name: string }> }));
vi.mock('../../src/db/index.js', () => ({ sql: vi.fn(async () => db.rows) }));
const dirs = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('../../src/modules/tenable/tenable.directories.js', () => ({
  tenableDirectories: { loaded: () => true, get: async () => dirs.current },
}));
vi.mock('../../src/modules/tenable-daily/tenable-daily.service.js', () => ({ tenableDailyContent: { get: async () => new Map() }, tenableRoomPairs: async () => [] }));

import type { TenableList } from '../../src/modules/tenable/tenable.content.js';
import { listProblems } from '../../src/modules/tenable/tenable.content.js';
import { buildDirectory, judge, withGreek, withRussian, type TenableEntity } from '../../src/modules/tenable/tenable.identify.js';
import { setDisplayNames, shownName } from '../../src/modules/tenable/tenable.names.js';
import { suggest } from '../../src/modules/tenable/tenable.suggest.js';
import { tenableGap } from '../../src/modules/tenable/tenable.gaps.js';
import { entriesOf, readDart, type Board } from '../../src/modules/darts501/darts501.rules.js';
import * as rules from '../../src/modules/tenable-daily/tenable-daily.rules.js';
import * as darts from '../../src/modules/darts501-daily/darts501-daily.rules.js';
import type { D501Category } from '../../src/modules/darts501/darts501.content.js';

// Invented clubs and footballers only: the repository is public.
const E = (eid: string, name: string, known: string, fame: number, aliases: string[] = [], qualifier: string | null = null): TenableEntity =>
  ({ eid, name, known, fame, aliases, qualifier });
const LATIN = [
  E('c-north', 'Northgate Rovers', 'Northgate', 90, ['Rovers']),
  E('c-vale', 'Vale Athletic', 'Vale', 70),
  E('c-lyon', 'Old Lyonsford', 'Lyonsford', 60),
  E('c-dun', 'Dunmore Town', 'Dunmore', 40, [], 'Scotland'),
  E('c-dun2', 'Dunmore United', 'Dunmore', 35, [], 'Ireland'),
];
const RUSSIAN = [
  E('c-north', 'Нортгейт Роверс', 'Нортгейт', 90, ['Роверс']),
  E('c-vale', 'Вейл Атлетик', 'Вейл', 70),
  E('c-lyon', 'Олд Лайонсфорд', 'Лайонсфорд', 60),
  E('c-dun', 'Данмор Таун', 'Данмор', 40, [], 'Шотландия'),
  E('c-dun2', 'Данмор Юнайтед', 'Данмор', 35, [], 'Ирландия'),
];
const GREEK = [
  E('c-north', 'Νόρθγκεϊτ Ρόβερς', 'Νόρθγκεϊτ', 90, ['Ρόβερς']),
  E('c-vale', 'Βέιλ Αθλέτικ', 'Βέιλ', 70),
  E('c-lyon', 'Όλντ Λάιονσφορντ', 'Λάιονσφορντ', 60),
  E('c-dun', 'Ντάνμορ Τάουν', 'Ντάνμορ', 40, [], 'Σκωτία'),
  E('c-dun2', 'Ντάνμορ Γιουνάιτεντ', 'Ντάνμορ', 35, [], 'Ιρλανδία'),
];
const latin = buildDirectory('club', 'rel', LATIN);
const russian = withRussian(latin, buildDirectory('club', 'rel', RUSSIAN, 'cyrillic'));
const all = withGreek(russian, buildDirectory('club', 'rel', GREEK, 'greek'));

describe('Tenable in Greek', () => {
  it('a Greek answer is read with the Greek names, a Cyrillic one with the Russian names, every other text as before', () => {
    expect(all.identify('Νόρθγκεϊτ Ρόβερς')).toEqual({ kind: 'entity', eid: 'c-north' });
    // Accents and final sigma are optional, small typos forgiven.
    expect(all.identify('νορθγκειτ ροβερσ')).toEqual({ kind: 'entity', eid: 'c-north' });
    expect(all.identify('ΡΟΒΕΡΣ')).toEqual({ kind: 'entity', eid: 'c-north' });
    expect(all.identify('Βέιλ Αθλέτκ')).toEqual({ kind: 'entity', eid: 'c-vale' });
    expect(all.identify('Ντάνμορ')).toEqual({ kind: 'ambiguous' });
    for (const text of ['Нортгейт Роверс', 'Вейл', 'Данмор', 'Роверс']) expect(all.identify(text)).toEqual(russian.identify(text));
    for (const text of ['Northgate Rovers', 'Vale', 'Dunmore', 'nobody', 'Lyonsford']) expect(all.identify(text)).toEqual(latin.identify(text));
    expect(russian.identify('Βέιλ')).toEqual({ kind: 'unknown' });
    expect(all.russian).toBe(russian.russian);
  });

  it('suggestions, candidates and namesakes follow the alphabet typed', () => {
    expect(all.suggest('Ντάν').map((s) => [s.eid, s.label, s.qualifier])).toEqual([['c-dun', 'Ντάνμορ Τάουν', 'Σκωτία'], ['c-dun2', 'Ντάνμορ Γιουνάιτεντ', 'Ιρλανδία']]);
    expect(all.suggest('Дан').map((s) => s.label)).toEqual(['Данмор Таун', 'Данмор Юнайтед']);
    expect(all.suggest('Dun').map((s) => s.label)).toEqual(['Dunmore Town', 'Dunmore United']);
    expect(all.candidates?.('Ντάνμορ')).toEqual(['c-dun', 'c-dun2']);
    expect([...all.namesakes('Ντάνμορ')]).toEqual(['c-dun', 'c-dun2']);
    expect(all.named('Βέιλ Αθλέτικ')).toEqual(['c-vale']);
    expect(all.identifyingKeys()).toEqual(expect.arrayContaining(['βειλ αθλετικ', 'веил атлетик', 'vale athletic']));
  });

  it('judging looks at the list only after the identity: a Greek off-list club is a wrong answer', () => {
    const slots = ['c-north', 'c-vale'];
    expect(judge(all, slots, new Set(), 'Βέιλ')).toEqual({ kind: 'right', slot: 1, eid: 'c-vale' });
    expect(judge(all, slots, new Set(), 'Όλντ Λάιονσφορντ')).toEqual({ kind: 'wrong', eid: 'c-lyon' });
  });

  it('Greek names must cover the release; a list is checked in Greek against the Greek names themselves', () => {
    expect(() => withGreek(russian, buildDirectory('club', 'rel', GREEK.slice(1), 'greek'))).toThrow();
    const list = { id: 'l', kind: 'club', release: 'rel', slots: ['c-north', 'c-dun'].map((eid) => ({ eid, figure: { value: 1, unit: 'titles' } })) } as TenableList;
    expect(listProblems(list, all.greek!)).toEqual([]);
  });
});

describe('a shared Greek name keeps the board-first rule (namesakes go through the Greek wrapper)', () => {
  const ROWS = [E('star', 'Alvo Bressan', 'Alvo', 95), E('other', 'Alvo Carrel', 'Alvo', 20), E('third', 'Alvo Denner', 'Alvo', 15), E('solo', 'Pim Quaid', 'Quaid', 40)];
  const EL: Record<string, [string, string]> = { star: ['Άλβο Μπρεσάν', 'Άλβο'], other: ['Άλβο Καρέλ', 'Άλβο'], third: ['Άλβο Ντένερ', 'Άλβο'], solo: ['Πιμ Κουέιντ', 'Κουέιντ'] };
  const dir = withGreek(buildDirectory('player', 'rel', ROWS), buildDirectory('player', 'rel', ROWS.map((r) => ({ ...r, name: EL[r.eid][0], known: EL[r.eid][1] })), 'greek'));

  it('the one holder of the typed Greek name on the board is right, like the Latin name', () => {
    expect(dir.identify('Άλβο')).toEqual({ kind: 'entity', eid: 'star' });
    expect([...dir.namesakes('Άλβο')].sort()).toEqual(['other', 'star', 'third']);
    expect(judge(dir, ['other', 'solo'], new Set(), 'Άλβο')).toEqual({ kind: 'right', slot: 0, eid: 'other' });
    expect(judge(dir, ['other', 'solo'], new Set(), 'Alvo')).toEqual({ kind: 'right', slot: 0, eid: 'other' });
    expect(judge(dir, ['star', 'other'], new Set(), 'αλβο')).toEqual({ kind: 'right', slot: 0, eid: 'star' });
    expect(judge(dir, ['solo'], new Set(), 'Άλβο')).toEqual({ kind: 'wrong', eid: 'star' });
  });

  it('two Greek holders with different Latin names are never chosen between by the board', () => {
    const merged = withGreek(buildDirectory('player', 'rel', ROWS), buildDirectory('player', 'rel', ROWS.map((r) => ({ ...r, name: r.eid === 'solo' ? 'Άλβο Κουέιντ' : EL[r.eid][0], known: r.eid === 'solo' ? 'Άλβο' : EL[r.eid][1] })), 'greek'));
    expect(judge(merged, ['solo'], new Set(), 'Άλβο')).toEqual({ kind: 'wrong', eid: 'star' });
  });
});

describe('Football Darts 501 in Greek', () => {
  const P = (eid: string, name: string, fame: number) => E(eid, name, name.split(' ')[1], fame);
  const ROWS = [P('rik', 'Rik Zeller', 30), P('tam', 'Tam Zeller', 20), P('pol', 'Pol Zeller', 10), P('kai', 'Kai Morrow', 40)];
  const EL: Record<string, string> = { rik: 'Ρικ Ζέλερ', tam: 'Ταμ Ζέλερ', pol: 'Πολ Ζέλερ', kai: 'Κάι Μόροου' };
  const directory = withGreek(buildDirectory('player', 'rel', ROWS), buildDirectory('player', 'rel', ROWS.map((r) => ({ ...r, name: EL[r.eid], known: EL[r.eid].split(' ')[1] })), 'greek'));
  const board = (entries: Array<[string, number]>, coverage = ['rik', 'tam', 'kai']): Board =>
    ({ directory, coverage: new Set(coverage), entries: entriesOf({ entries: entries.map(([eid, value]) => ({ eid, value })) }) });

  it('a Greek name throws its footballer', () => {
    expect(readDart(board([['kai', 60]]), new Set(), 501, 'Κάι Μόροου', null)).toMatchObject({ free: false, verdict: 'score', eid: 'kai', value: 60 });
    expect(readDart(board([['kai', 60]]), new Set(['kai']), 501, 'μοροου', null)).toEqual({ free: true, verdict: 'repeat', eid: 'kai' });
  });

  it('a shared Greek surname is read against the category only when every holder is covered (as in Cyrillic)', () => {
    expect(readDart(board([['tam', 40]]), new Set(), 501, 'Zeller', null)).toMatchObject({ free: false, eid: 'tam', value: 40 });
    expect(readDart(board([['tam', 40]]), new Set(), 501, 'Ζέλερ', null)).toEqual({ free: true, verdict: 'ambiguous', eid: null });
    expect(readDart(board([['tam', 40]], ['rik', 'tam', 'pol', 'kai']), new Set(), 501, 'Ζέλερ', null)).toMatchObject({ free: false, eid: 'tam', value: 40 });
  });
});

describe('names shown to Greek players', () => {
  const list = {
    id: 'l', kind: 'club', release: 'rel', matcher: 1, tier: 'easy', topicKey: 't', asOf: null, note: null,
    title: { en: 'x', es: 'x', ka: 'x', tr: 'x' },
    slots: LATIN.slice(0, 2).map((e) => ({ eid: e.eid, figure: { value: 1, unit: 'titles' } })),
  } as unknown as TenableList;
  const view = (s: rules.RunState) => rules.publicState(s, '2026-11-01', { list, directory: all }, 0, { ranked: false, disclose: false });

  it('a Greek daily run is flagged, keeps its language through a correction and shows Greek names', () => {
    const s = rules.newState({ locale: 'el' });
    expect(s).toMatchObject({ el: true });
    expect(s.lc).toBeUndefined();
    expect(rules.rebase(s).el).toBe(true);
    const played = rules.say(rules.say(s, list, all, 'Νόρθγκεϊτ', null), list, all, 'Old Lyonsford', null);
    expect(played.f).toEqual(['c-north']);
    expect(view(played).slots[0].name).toBe('Νόρθγκεϊτ Ρόβερς');
    expect(view(played).misses).toEqual(['Όλντ Λάιονσφορντ']);
  });

  it('a Greek run from before (lc = el, no flag) keeps the names it started with', () => {
    setDisplayNames([{ locale: 'el', kind: 'club', eid: 'c-north', name: 'Νόρθγκεϊτ Ρόβερς' }]);
    const old: rules.RunState = { v: 1, f: ['c-north'], w: [], l: 3, done: false, end: null, last: null, k: 1, lc: 'el' };
    expect(view(old).slots[0].name).toBe('Northgate Rovers');
    // Without Greek names on the release, the same.
    expect(rules.publicState(old, '2026-11-01', { list, directory: russian }, 0, { ranked: false, disclose: false }).slots[0].name).toBe('Northgate Rovers');
    setDisplayNames(null);
  });

  it('shownName: Greek names to Greek readers when the release has them, the release\'s own otherwise', () => {
    expect(shownName(all, 'c-vale', 'el')).toBe('Βέιλ Αθλέτικ');
    expect(shownName(all, 'c-vale', 'el', { greekNames: false })).toBe('Vale Athletic');
    expect(shownName(all, 'c-vale', 'ru')).toBe('Вейл Атлетик');
    expect(shownName(all, 'c-vale', 'en')).toBe('Vale Athletic');
    expect(shownName(russian, 'c-vale', 'el')).toBe('Vale Athletic');
  });

  it('a Greek Darts 501 run is flagged; one from before is not', () => {
    const P = (eid: string, name: string) => E(eid, name, name.split(' ')[1], 50);
    const ROWS = [P('kai', 'Kai Morrow'), P('ono', 'Ono Brask')];
    const directory = withGreek(buildDirectory('player', 'rel', ROWS), buildDirectory('player', 'rel', [E('kai', 'Κάι Μόροου', 'Μόροου', 50), E('ono', 'Όνο Μπρασκ', 'Μπρασκ', 50)], 'greek'));
    const category = { id: 'cat', release: 'rel', entries: [{ eid: 'kai', value: 60 }, { eid: 'ono', value: 20 }], title: { en: 'x' }, note: null } as unknown as D501Category;
    const day: darts.Day = { category, directory, coverage: new Set(['kai', 'ono']) };
    const s = darts.newState({ locale: 'el' });
    expect(s).toMatchObject({ lc: 'el', el: true });
    expect(darts.newState({ locale: 'ru' }).el).toBeUndefined();
    expect(darts.rebase(s).el).toBe(true);
    const thrown = darts.say(s, day, 'Κάι Μόροου', null);
    expect(thrown.d.map((d) => d.e)).toEqual(['kai']);
    const shown = (state: darts.RunState) => darts.publicState(state, '2026-11-01', day, 0, { ranked: false, disclose: false }).darts[0].name;
    expect(shown(thrown)).toBe('Κάι Μόροου');
    expect(shown({ ...thrown, el: undefined })).toBe('Kai Morrow');
  });
});

describe('suggestions endpoint', () => {
  it('a Greek query is answered from the Greek names, unlabelled; a Latin one as before', async () => {
    dirs.current = all;
    db.rows = [];
    expect((await suggest('club', 'rel', 'Βέι', 'el')).map((s) => s.label)).toEqual(['Βέιλ Αθλέτικ']);
    expect((await suggest('club', 'rel', 'Вей', 'ru')).map((s) => s.label)).toEqual(['Вейл Атлетик']);
    expect((await suggest('club', 'rel', 'Val', 'en')).map((s) => s.label)).toEqual(['Vale Athletic']);
  });
});

describe('content gaps', () => {
  it('a release with Greek names is told apart in the gap context; one without keeps its old context', () => {
    const list = { id: 'l', kind: 'player', release: 'rel', matcher: 1, slots: [] } as unknown as TenableList;
    expect(tenableGap('unknown', 'x', null, list, all)?.context).toContain('|ru+el+|');
    expect(tenableGap('unknown', 'x', null, list, russian)?.context).toContain('|ru+|');
  });
});

describe('loading a release\'s Greek names', () => {
  const fakeDb = (pinned: boolean, rows: Array<{ eid: string; name: string; known: string }>) =>
    (async (strings: TemplateStringsArray) => (strings.join('?').includes('tenable_el_releases')
      ? (pinned ? [{ players_version: null, names_version: 'v' }] : [])
      : rows.map((r) => ({ ...r, aliases: [], qualifier: null })))) as never;

  it('a release without a pin, or a set that misses one entity, has no Greek names at all', async () => {
    const { greekPinOf, greekRows } = await import('../../src/modules/tenable/tenable.greek.js');
    const named = GREEK.map(({ eid, name, known }) => ({ eid, name, known }));
    const pin = { players_version: null, names_version: 'v' };
    expect(await greekPinOf(fakeDb(false, named), 'club', 'rel')).toBeNull();
    expect(await greekPinOf(fakeDb(true, named), 'club', 'rel')).toEqual(pin);
    expect(await greekRows(fakeDb(true, named.slice(1)), 'club', 'rel', LATIN, pin)).toBeNull();
    const rows = await greekRows(fakeDb(true, named), 'club', 'rel', LATIN, pin);
    expect(rows?.map((r) => [r.eid, r.fame, r.qualifier])).toEqual(LATIN.map((e) => [e.eid, e.fame, e.qualifier]));
  });

  it('entities spelt apart in Latin but alike in Greek are told apart by their own spelling', async () => {
    const { greekRows } = await import('../../src/modules/tenable/tenable.greek.js');
    const twins = [E('a', 'Kristian Vale', 'Vale', 50), E('b', 'Christian Vale', 'Vale', 40, [], 'DEN')];
    const rows = await greekRows(fakeDb(true, [{ eid: 'a', name: 'Κρίστιαν Βέιλ', known: 'Βέιλ' }, { eid: 'b', name: 'Κρίστιαν Βέιλ', known: 'Βέιλ' }]), 'club', 'rel', twins, { players_version: null, names_version: 'v' });
    expect(rows?.map((r) => r.qualifier)).toEqual(['Kristian Vale', 'DEN · Christian Vale']);
  });
});
