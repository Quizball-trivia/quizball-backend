import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ rows: [] as Array<{ locale: string; kind: string; eid: string; name: string }>, fail: false, reads: 0 }));
vi.mock('../../src/db/index.js', () => ({
  sql: vi.fn(async () => {
    db.reads += 1;
    if (db.fail) throw new Error('down');
    return db.rows;
  }),
}));
const dirs = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('../../src/modules/tenable/tenable.directories.js', () => ({
  tenableDirectories: { loaded: () => true, get: async () => dirs.current },
}));
vi.mock('../../src/modules/tenable-daily/tenable-daily.service.js', () => ({ tenableDailyContent: { get: async () => new Map() }, tenableRoomPairs: async () => [] }));

import { buildDirectory, TENABLE_MATCHER_VERSION, withRussian, type TenableEntity } from '../../src/modules/tenable/tenable.identify.js';
import type { TenableList } from '../../src/modules/tenable/tenable.content.js';
import { refreshDisplayNames, setDisplayNames, shownName } from '../../src/modules/tenable/tenable.names.js';
import { suggest } from '../../src/modules/tenable/tenable.suggest.js';
import * as rules from '../../src/modules/tenable-daily/tenable-daily.rules.js';
import { applyCommand, INTRO_MS, startMatch, tick, viewOf, type TenableContent } from '../../src/modules/room/games/tenable/tenable.engine.js';

// Invented clubs only: the repository is public.
const CLUBS = ['Vardo Munich', 'Pellin Rovers', 'Ostra United', 'Kelmar Athletic', 'Brisk Town', 'Corvel City', 'Danto Wanderers', 'Ferro Albion', 'Gessa Rangers', 'Hollin Vale', 'Ilmar County'];
const rows: TenableEntity[] = CLUBS.map((name, i) => ({ eid: `c${i}`, name, known: name, fame: 80 - i, aliases: i === 0 ? ['Vardo München'] : [], qualifier: null }));
const dir = buildDirectory('club', 'rel', rows);
const list: TenableList = {
  id: 'l', kind: 'club', release: 'rel', matcher: TENABLE_MATCHER_VERSION, tier: 'easy', topicKey: 't',
  title: { en: 'x', es: 'x', ka: 'x', tr: 'x' }, note: null, asOf: null,
  slots: rows.slice(0, 10).map((r, i) => ({ eid: r.eid, figure: { value: 10 - i, unit: 'titles' } })),
} as TenableList;
const GERMAN = [
  { locale: 'de', kind: 'club', eid: 'c0', name: 'Vardo München' },
  // Read as another club by this release: never shown.
  { locale: 'de', kind: 'club', eid: 'c1', name: 'Ostra United' },
  { locale: 'pt', kind: 'club', eid: 'c0', name: 'Vardo Munique' },
];

beforeEach(() => { db.rows = GERMAN; db.fail = false; db.reads = 0; setDisplayNames(GERMAN); });

describe('shownName', () => {
  it('shows a German name only when the release reads it as the same entity', () => {
    expect(shownName(dir, 'c0', 'de')).toBe('Vardo München');
    expect(shownName(dir, 'c1', 'de')).toBe('Pellin Rovers');
    expect(shownName(dir, 'c2', 'de')).toBe('Ostra United');
  });

  it('a name this release does not accept stays English (pt "Vardo Munique" is no spelling of it)', () => {
    expect(shownName(dir, 'c0', 'pt')).toBe('Vardo Munich');
  });

  it('other languages, unknown ids and players keep their own names', () => {
    expect(shownName(dir, 'c0', 'en')).toBe('Vardo Munich');
    expect(shownName(dir, 'c0', undefined)).toBe('Vardo Munich');
    expect(shownName(dir, 'nope', 'de')).toBeNull();
    const players = buildDirectory('player', 'rel', rows);
    setDisplayNames([{ locale: 'de', kind: 'player', eid: 'c0', name: 'Vardo München' }]);
    expect(shownName(players, 'c0', 'de')).toBe('Vardo Munich');
  });

  it('Russian still comes from the release\'s Russian names', () => {
    const russian = withRussian(dir, buildDirectory('club', 'rel', rows.map((r) => ({ ...r, name: `Клуб ${r.eid}`, known: `Клуб ${r.eid}`, aliases: [] })), 'cyrillic'));
    expect(shownName(russian, 'c0', 'ru')).toBe('Клуб c0');
    expect(shownName(russian, 'c0', 'de')).toBe('Vardo München');
  });

  it('views never read the database: a cold cache shows English until the timer has read the names; a failed read keeps them', async () => {
    setDisplayNames(null);
    db.reads = 0;
    expect(shownName(dir, 'c0', 'de')).toBe('Vardo Munich');
    expect(db.reads).toBe(0);
    await refreshDisplayNames();
    expect(shownName(dir, 'c0', 'de')).toBe('Vardo München');
    db.fail = true;
    await refreshDisplayNames();
    expect(shownName(dir, 'c0', 'de')).toBe('Vardo München');
  });

  it('a name another entity of the release is called is never shown (two answers would look the same)', () => {
    const withNamesake = buildDirectory('club', 'rel', [...rows, { eid: 'c11', name: 'Kelmar', known: 'Kelmar', fame: 5, aliases: [], qualifier: null }]);
    setDisplayNames([{ locale: 'de', kind: 'club', eid: 'c3', name: 'Kelmar' }]);
    expect(shownName(withNamesake, 'c3', 'de')).toBe('Kelmar Athletic');
  });

  it('concurrent refreshes share one read; a deleted row is gone after the next refresh', async () => {
    db.reads = 0;
    await Promise.all([refreshDisplayNames(), refreshDisplayNames()]);
    expect(db.reads).toBe(1);
    db.rows = [];
    await refreshDisplayNames();
    expect(shownName(dir, 'c0', 'de')).toBe('Vardo Munich');
  });
});

describe('namesakes beyond the suggestions', () => {
  it('a name another entity is called is refused even when many better-known names hide it', () => {
    const crowd = Array.from({ length: 12 }, (_, i) => ({ eid: `u${i}`, name: `Union Athletic ${String.fromCharCode(65 + i)}`, known: `Union Athletic ${String.fromCharCode(65 + i)}`, fame: 90, aliases: [], qualifier: null }));
    const d = buildDirectory('club', 'rel', [...crowd, { eid: 'lone', name: 'Union', known: 'Union', fame: 1, aliases: [], qualifier: null }, { eid: 'big', name: 'Northland', known: 'Northland', fame: 95, aliases: ['Union'], qualifier: null }]);
    setDisplayNames([{ locale: 'de', kind: 'club', eid: 'big', name: 'Union' }]);
    expect(shownName(d, 'big', 'de')).toBe('Northland');
  });
});

describe('alias sets by entity id', () => {
  it('a spelling filed under clubs is read on a nation release too', async () => {
    const { withAliases } = await import('../../src/modules/tenable/tenable.aliases.js');
    const queries: string[] = [];
    const fake = (async (strings: TemplateStringsArray) => { queries.push(strings.join('?')); return [{ eid: 'c0', aliases: ['Vardo Mönchen'] }]; }) as never;
    const nations = await withAliases(fake, 'nation', rows, ['de-x']);
    expect(nations[0].aliases).toContain('Vardo Mönchen');
    expect(queries[0]).not.toMatch(/kind = \?/);
  });
});

describe('cold start', () => {
  it('a labelled suggestion is a 503 while the names cannot be read at all (never an hour-cached English answer)', async () => {
    dirs.current = dir;
    setDisplayNames(null);
    db.fail = true;
    await expect(suggest('club', 'rel', 'Vardo', 'de')).rejects.toMatchObject({ statusCode: 503 });
    expect((await suggest('club', 'rel', 'Vardo')).length).toBeGreaterThan(0);
  });
});

describe('daily runs', () => {
  const now = Date.now();
  const extra = { ranked: true, disclose: false };

  it('a run started in German or Portuguese remembers it, also across a corrected list', () => {
    expect(rules.newState({ locale: 'de' }).lc).toBe('de');
    expect(rules.newState({ locale: 'pt' }).lc).toBe('pt');
    expect(rules.newState({ locale: 'en' }).lc).toBeUndefined();
    expect(rules.newState({ locale: 'ru' })).toMatchObject({ ru: true });
    expect(rules.newState({ locale: 'ru' }).lc).toBeUndefined();
    expect(rules.rebase(rules.newState({ locale: 'de' })).lc).toBe('de');
  });

  it('found slots, misses and the last answer are shown in the run\'s language; judging is the same', () => {
    const de = rules.say(rules.newState({ locale: 'de' }), list, dir, 'Vardo Munich', null);
    const en = rules.say(rules.newState(), list, dir, 'Vardo Munich', null);
    expect(de.f).toEqual(en.f);
    const shown = rules.publicState(de, '2026-10-24', { list, directory: dir }, now, extra);
    expect(shown.slots[0].name).toBe('Vardo München');
    expect(shown.slots[1].name).toBeNull();
    expect(shown.last?.name).toBe('Vardo München');
    expect(rules.publicState(en, '2026-10-24', { list, directory: dir }, now, extra).slots[0].name).toBe('Vardo Munich');
    const missed = rules.say(rules.newState({ locale: 'de' }), { ...list, slots: list.slots.map((s, i) => (i === 0 ? { ...s, eid: 'c10' } : s)) }, dir, 'Vardo München', null);
    expect(rules.publicState(missed, '2026-10-24', { list, directory: dir }, now, extra).misses).toEqual(['Vardo München']);
  });

  it('a run from before the change (no lc) stays English', () => {
    const old = rules.say({ ...rules.newState(), lc: undefined }, list, dir, 'Vardo Munich', null);
    expect(rules.publicState(old, '2026-10-24', { list, directory: dir }, now, extra).slots[0].name).toBe('Vardo Munich');
  });
});

describe('rooms', () => {
  it('each seat sees the names in its own language', () => {
    const content: TenableContent = { pack: { lists: [list, list, list], seed: 0 }, directories: [dir, dir, dir] };
    const T0 = 1_000_000;
    const s = tick(startMatch(2, content, T0), T0 + INTRO_MS);
    const r = applyCommand(s, content, s.turn, { type: 'answer', epoch: s.epoch, attempt: s.attempts, text: 'Vardo Munich' }, T0 + INTRO_MS + 1).state;
    expect(viewOf(r, content, 0, 'de').slots[0].name).toBe('Vardo München');
    expect(viewOf(r, content, 1, 'en').slots[0].name).toBe('Vardo Munich');
  });
});

describe('suggestions', () => {
  it('are labelled in German for a German page; the same entities are found', async () => {
    dirs.current = dir;
    const en = await suggest('club', 'rel', 'Vardo');
    const de = await suggest('club', 'rel', 'Vardo', 'de');
    expect(de.map((s) => s.eid)).toEqual(en.map((s) => s.eid));
    expect(en[0].label).toBe('Vardo Munich');
    expect(de[0].label).toBe('Vardo München');
  });

  it('a cold cache is read before a labelled answer (it is cached for an hour)', async () => {
    dirs.current = dir;
    setDisplayNames(null);
    expect((await suggest('club', 'rel', 'Vardo', 'de'))[0].label).toBe('Vardo München');
  });

  it('people and Russian queries keep their labels', async () => {
    const people = buildDirectory('player', 'rel', rows);
    setDisplayNames([{ locale: 'de', kind: 'player', eid: 'c0', name: 'Vardo München' }]);
    dirs.current = people;
    expect((await suggest('player', 'rel', 'Vardo', 'de'))[0].label).toBe('Vardo Munich');
    const russian = withRussian(dir, buildDirectory('club', 'rel', rows.map((r) => ({ ...r, name: `Клуб ${r.eid}`, known: `Клуб ${r.eid}`, aliases: [] })), 'cyrillic'));
    setDisplayNames(GERMAN);
    dirs.current = russian;
    expect((await suggest('club', 'rel', 'Клуб', 'de')).every((s) => s.label.startsWith('Клуб'))).toBe(true);
  });
});
