import { describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ rows: [] as Array<{ list_id: string; src: string; title: string; note: string | null }>, reads: 0 }));
vi.mock('../../src/db/index.js', () => ({ sql: vi.fn(async () => { db.reads += 1; return db.rows; }) }));

import { listProblems, type TenableList } from '../../src/modules/tenable/tenable.content.js';
import { formatFigure } from '../../src/modules/tenable/tenable.figures.js';
import { buildDirectory, displayName, judge, withRussian, type TenableEntity } from '../../src/modules/tenable/tenable.identify.js';
import { forgetRussianText, refreshRussianText, russianTextSource, textIn, withRussianText } from '../../src/modules/tenable/tenable.text.js';
import * as rules from '../../src/modules/tenable-daily/tenable-daily.rules.js';

// Invented clubs only: the repository is public.
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
  E('c-lyon', 'Олд Лайонсфорд', 'Лайонсфорд', 60, ['Лайонсфорд Ёлки']),
  E('c-dun', 'Данмор Таун', 'Данмор', 40, [], 'Шотландия'),
  E('c-dun2', 'Данмор Юнайтед', 'Данмор', 35, [], 'Ирландия'),
];
const latin = buildDirectory('club', 'rel', LATIN);
const both = withRussian(latin, buildDirectory('club', 'rel', RUSSIAN, 'cyrillic'));

describe('Tenable in Cyrillic', () => {
  it('a Cyrillic answer is read with the Russian names; every other text exactly as before', () => {
    expect(both.identify('Нортгейт Роверс')).toEqual({ kind: 'entity', eid: 'c-north' });
    expect(both.identify('роверс')).toEqual({ kind: 'entity', eid: 'c-north' });
    expect(both.identify('Данмор')).toEqual({ kind: 'ambiguous' });
    for (const text of ['Northgate Rovers', 'Vale', 'Dunmore', 'nobody', 'Lyonsford']) expect(both.identify(text)).toEqual(latin.identify(text));
    expect(latin.identify('Нортгейт')).toEqual({ kind: 'unknown' });
  });

  it('ё is е and й is и, small typos are forgiven, particles mean no one', () => {
    expect(both.identify('лаионсфорд елки')).toEqual({ kind: 'entity', eid: 'c-lyon' });
    expect(both.identify('Вейл Атлетк')).toEqual({ kind: 'entity', eid: 'c-vale' });
    expect(both.identify('фк')).toEqual({ kind: 'unknown' });
  });

  it('suggestions follow the alphabet typed, with Russian qualifiers', () => {
    expect(both.suggest('Дан').map((s) => [s.eid, s.label, s.qualifier])).toEqual([['c-dun', 'Данмор Таун', 'Шотландия'], ['c-dun2', 'Данмор Юнайтед', 'Ирландия']]);
    expect(both.suggest('Dun').map((s) => s.label)).toEqual(['Dunmore Town', 'Dunmore United']);
  });

  it('judging looks at the list only after the identity: a Cyrillic off-list club is a wrong answer', () => {
    const slots = ['c-north', 'c-vale'];
    expect(judge(both, slots, new Set(), 'Вейл')).toEqual({ kind: 'right', slot: 1, eid: 'c-vale' });
    expect(judge(both, slots, new Set(), 'Олд Лайонсфорд')).toEqual({ kind: 'wrong', eid: 'c-lyon' });
    expect(judge(both, slots, new Set(), 'Данмор', 'c-dun2')).toEqual({ kind: 'wrong', eid: 'c-dun2' });
  });

  it('Russian names must cover the release, and are shown only to Russian players', () => {
    expect(() => withRussian(latin, buildDirectory('club', 'rel', RUSSIAN.slice(1), 'cyrillic'))).toThrow();
    expect(displayName(both, 'c-vale', true)).toBe('Вейл Атлетик');
    expect(displayName(both, 'c-vale', false)).toBe('Vale Athletic');
    expect(displayName(latin, 'c-vale', true)).toBe('Vale Athletic');
  });

  it('a list is checked for reachability in Russian against the Russian names themselves', () => {
    const list = { id: 'l', kind: 'club', release: 'rel', slots: ['c-north', 'c-dun'].map((eid) => ({ eid, figure: { value: 1, unit: 'titles' } })) } as TenableList;
    expect(listProblems(list, both.russian!)).toEqual([]);
    const twins = buildDirectory('club', 'rel', RUSSIAN.map((e) => (e.eid === 'c-dun2' ? { ...e, name: 'Данмор Таун', qualifier: 'Шотландия' } : e)), 'cyrillic');
    expect(listProblems(list, twins).some((p) => p.includes('namesake'))).toBe(true);
  });
});

describe('Russian figures', () => {
  const ru = (value: number, unit: 'goals' | 'points' | 'eur_m' | 'assists') => formatFigure({ value, unit }, 'ru');
  it('three forms by the last digits, the "few" form for a fraction', () => {
    expect([0, 1, 2, 5, 11, 21, 22, 111, 141].map((n) => ru(n, 'goals'))).toEqual(['0 голов', '1 гол', '2 гола', '5 голов', '11 голов', '21 гол', '22 гола', '111 голов', '141 гол']);
    expect(ru(2.5, 'points')).toBe('2,5 очка');
    expect(ru(3, 'assists')).toBe('3 ассиста');
    expect(ru(222, 'eur_m')).toBe('222 млн €');
  });
});

describe('Russian titles and notes', () => {
  const list = { id: 'l-1', title: { en: 'Top scorers', es: 'x', ka: 'x', tr: 'x' }, note: { en: 'All competitions', es: 'x', ka: 'x', tr: 'x' } } as Pick<TenableList, 'id' | 'title' | 'note'>;

  it('come from the translation of the same English text; English stands in until then', async () => {
    forgetRussianText();
    db.rows = [{ list_id: 'l-1', src: russianTextSource(list), title: 'Лучшие бомбардиры', note: 'Все турниры' }];
    expect(textIn(list, 'ru')).toEqual({ title: 'Top scorers', note: 'All competitions' });
    await refreshRussianText();
    expect(textIn(list, 'ru')).toEqual({ title: 'Лучшие бомбардиры', note: 'Все турниры' });
    expect(withRussianText(list).title).toMatchObject({ en: 'Top scorers', ru: 'Лучшие бомбардиры' });
    expect(textIn(list, 'es').title).toBe('x');
  });

  it('a list corrected in English shows English, never the old translation', async () => {
    forgetRussianText();
    db.rows = [{ list_id: 'l-1', src: russianTextSource(list), title: 'Лучшие бомбардиры', note: null }];
    await refreshRussianText();
    const corrected = { ...list, title: { ...list.title, en: 'Top scorers (league only)' } };
    expect(textIn(corrected, 'ru').title).toBe('Top scorers (league only)');
  });

  it('title and note each keep the list\'s own Russian; the translation fills only what is missing', async () => {
    forgetRussianText();
    db.rows = [{ list_id: 'l-1', src: russianTextSource(list), title: 'Перевод', note: 'Перевод правила' }];
    await refreshRussianText();
    expect(textIn({ ...list, title: { ...list.title, ru: 'Свой' } }, 'ru')).toEqual({ title: 'Свой', note: 'Перевод правила' });
    expect(textIn({ ...list, note: { ...list.note!, ru: 'Своё правило' } }, 'ru')).toEqual({ title: 'Перевод', note: 'Своё правило' });
  });

  it('a failed read is retried after the refresh interval, never on every view', async () => {
    forgetRussianText();
    const { sql } = await import('../../src/db/index.js');
    const read = vi.mocked(sql as unknown as () => Promise<unknown>);
    read.mockRejectedValueOnce(new Error('relation does not exist'));
    await refreshRussianText();
    const before = db.reads;
    for (let i = 0; i < 5; i += 1) withRussianText(list);
    await new Promise((r) => setTimeout(r, 0));
    expect(db.reads).toBe(before);
  });

  it("a list's own Russian wins", async () => {
    forgetRussianText();
    db.rows = [{ list_id: 'l-1', src: russianTextSource(list), title: 'Перевод', note: null }];
    await refreshRussianText();
    expect(textIn({ ...list, title: { ...list.title, ru: 'Свой' } }, 'ru').title).toBe('Свой');
  });
});

describe('a Russian daily run', () => {
  const list = {
    id: 'l', kind: 'club', release: 'rel', matcher: 1, tier: 'easy', topicKey: 't', asOf: null, note: null,
    title: { en: 'x', es: 'x', ka: 'x', tr: 'x' },
    slots: LATIN.slice(0, 2).map((e) => ({ eid: e.eid, figure: { value: 1, unit: 'titles' } })),
  } as unknown as TenableList;

  it('shows names in Russian, keeps its language through a correction, and judges the same either way', () => {
    const s = rules.newState({ locale: 'ru' });
    expect(s.ru).toBe(true);
    expect(rules.newState({ locale: 'en' }).ru).toBeUndefined();
    expect(rules.rebase(s).ru).toBe(true);
    const played = rules.say(rules.say(s, list, both, 'Нортгейт', null), list, both, 'Old Lyonsford', null);
    expect(played.f).toEqual(['c-north']);
    const view = rules.publicState(played, '2026-10-01', { list, directory: both }, 0, { ranked: false, disclose: false });
    expect(view.slots[0].name).toBe('Нортгейт Роверс');
    expect(view.misses).toEqual(['Олд Лайонсфорд']);
    const english = rules.publicState({ ...played, ru: undefined }, '2026-10-01', { list, directory: both }, 0, { ranked: false, disclose: false });
    expect(english.slots[0].name).toBe('Northgate Rovers');
  });
});

describe('loading a release\'s Russian names', () => {
  const fakeDb = (pinned: boolean, rows: Array<{ eid: string; name: string; known: string }>) =>
    (async (strings: TemplateStringsArray) => (strings.join('?').includes('tenable_ru_releases')
      ? (pinned ? [{ players_version: null, names_version: 'v' }] : [])
      : rows.map((r) => ({ ...r, aliases: [], qualifier: null })))) as never;

  it('a release without a pin, or a set that misses one entity, has no Russian names at all', async () => {
    const { russianPinOf, russianRows } = await import('../../src/modules/tenable/tenable.russian.js');
    const all = RUSSIAN.map(({ eid, name, known }) => ({ eid, name, known }));
    const pin = { players_version: null, names_version: 'v' };
    expect(await russianPinOf(fakeDb(false, all), 'club', 'rel')).toBeNull();
    expect(await russianPinOf(fakeDb(true, all), 'club', 'rel')).toEqual(pin);
    expect(await russianRows(fakeDb(true, all.slice(1)), 'club', 'rel', LATIN, pin)).toBeNull();
    const rows = await russianRows(fakeDb(true, all), 'club', 'rel', LATIN, pin);
    expect(rows?.map((r) => [r.eid, r.fame, r.qualifier])).toEqual(LATIN.map((e) => [e.eid, e.fame, e.qualifier]));
  });

  it('entities spelt apart in Latin but alike in Russian are told apart by their own spelling', async () => {
    const { russianRows } = await import('../../src/modules/tenable/tenable.russian.js');
    const latinTwins = [E('a', 'Kristian Vale', 'Vale', 50), E('b', 'Christian Vale', 'Vale', 40, [], 'DEN')];
    const rows = await russianRows(fakeDb(true, [{ eid: 'a', name: 'Кристиан Вейл', known: 'Вейл' }, { eid: 'b', name: 'Кристиан Вейл', known: 'Вейл' }]), 'club', 'rel', latinTwins, { players_version: null, names_version: 'v' });
    expect(rows?.map((r) => r.qualifier)).toEqual(['Kristian Vale', 'DEN · Christian Vale']);
  });
});
