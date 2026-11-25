import { describe, expect, it } from 'vitest';
import { batchRefusal, conflict, exposedCheckout, keysOf, pairsComparable, pairsLimit, scopeOf, sharedFinish, topicProblem, type LedgerRow } from '../../src/modules/darts501/darts501.seed.js';
import type { D501Category } from '../../src/modules/darts501/darts501.content.js';
import { category } from './fixture.js';

const row = (over: Partial<LedgerRow> & Pick<LedgerRow, 'side'>): LedgerRow => ({ category_id: 'other', topic_key: 'XX:9:apps', entry_keys: [], day: null, ...over });
const daily = category('today');

describe('what may stand next to published content', () => {
  it('the same category or topic as the daily on another date is refused, even under a new topic label', () => {
    expect(conflict('daily', { category: daily, day: '2026-11-02' }, row({ side: 'daily', category_id: 'today', topic_key: 'YY:1:goals', day: '2026-11-01' }))).toMatch(/already the daily/);
    expect(conflict('daily', { category: daily, day: '2026-11-02' }, row({ side: 'daily', topic_key: daily.topicKey, day: '2026-11-01' }))).toMatch(/already the daily/);
  });

  it('identical answers on another date are refused whatever the labels say', () => {
    expect(conflict('daily', { category: { ...daily, id: 'renamed', topicKey: 'ZZ:2:apps' }, day: '2026-11-02' }, row({ side: 'daily', entry_keys: keysOf(daily), day: '2026-11-01' }))).toMatch(/same footballer-and-number pairs/);
  });

  it("a day's own earlier revision may overlap (a correction), and rooms may overlap each other", () => {
    expect(conflict('daily', { category: daily, day: '2026-11-01' }, row({ side: 'daily', category_id: 'today', entry_keys: keysOf(daily), day: '2026-11-01' }))).toBeNull();
    expect(conflict('room', { category: daily, day: null }, row({ side: 'room', entry_keys: keysOf(daily) }))).toBeNull();
  });

  it('across sides: the same topic, or shared pairs, are refused; the same club in another unit is not', () => {
    expect(conflict('room', { category: { ...daily, topicKey: 'IL1:77:apps' }, day: null }, row({ side: 'daily', topic_key: 'IL1:77:apps', day: '2026-11-01' }))).toMatch(/topic IL1:77:apps was shown on the daily side/);
    expect(conflict('daily', { category: { ...daily, topicKey: 'IL1:77:apps' }, day: '2026-12-20' }, row({ side: 'room', topic_key: 'IL1:77:apps' }))).toMatch(/shown on the room side/);
    expect(conflict('room', { category: { ...daily, topicKey: 'IL1:77:goals' }, day: null }, row({ side: 'daily', topic_key: 'IL1:77:apps', day: '2026-11-01' }))).toBeNull();
    expect(conflict('daily', { category: { ...daily, topicKey: 'CL:77:apps' }, day: '2026-12-20' }, row({ side: 'room', topic_key: 'IL1:77:apps' }))).toBeNull();
    expect(conflict('room', { category: daily, day: null }, row({ side: 'daily', entry_keys: keysOf(daily).slice(0, 5), day: '2026-11-01' }))).toMatch(/5 of the same/);
    expect(conflict('room', { category: daily, day: null }, row({ side: 'daily', entry_keys: keysOf(daily).slice(0, 4), day: '2026-11-01' }))).toBeNull();
  });
});

describe('shared pairs that add up to a checkout', () => {
  it('three shared pairs (180 + 141 + 180) are refused though fewer than the per-row limit', () => {
    const three = keysOf({ entries: daily.entries.filter((e) => ['p0', 'p1', 'p8'].includes(e.eid)) });
    expect(conflict('room', { category: daily, day: null }, row({ side: 'daily', entry_keys: three, day: '2026-11-01' }))).toBeNull();
    expect(sharedFinish('room', { category: daily, day: null }, [row({ side: 'daily', entry_keys: three, day: '2026-11-01' })])).toMatch(/check out on their own/);
  });
  it('pairs spread over several rows count together; pairs that cannot finish are allowed', () => {
    const rows = ['p0', 'p1', 'p8'].map((eid, i) => row({ side: 'daily', category_id: `d${i}`, entry_keys: keysOf({ entries: daily.entries.filter((e) => e.eid === eid) }), day: `2026-11-0${i + 1}` }));
    expect(sharedFinish('room', { category: daily, day: null }, rows)).toMatch(/check out/);
    expect(sharedFinish('room', { category: daily, day: null }, rows.slice(0, 2))).toBeNull();
  });
  it('rooms among themselves and a day\'s own revision do not count', () => {
    expect(sharedFinish('room', { category: daily, day: null }, [row({ side: 'room', entry_keys: keysOf(daily) })])).toBeNull();
    expect(sharedFinish('daily', { category: daily, day: '2026-11-01' }, [row({ side: 'daily', entry_keys: keysOf(daily), day: '2026-11-01' })])).toBeNull();
  });
});

describe("an existing category's exposure", () => {
  const keysOfValues = (prefix: string, values: number[]) => new Set(values.map((v, i) => `${prefix}${i}=${v}`));
  it('two room categories that each show part of a daily checkout are refused together (Codex: three 170s)', () => {
    const daily = { id: 'D', side: 'daily' as const, day: '2026-11-01', topicKey: 'XX:1:apps', keys: new Set(['a=170', 'b=170', 'c=170', 'x=1']) };
    const roomA = { id: 'A', side: 'room' as const, day: null, topicKey: 'XX:2:apps', keys: new Set(['a=170', 'b=170', 'q=2']) };
    const roomB = { id: 'B', side: 'room' as const, day: null, topicKey: 'XX:3:apps', keys: new Set(['c=170', 'r=3']) };
    expect(exposedCheckout([daily, roomA])).toBeNull();
    expect(exposedCheckout([daily, roomA, roomB])).toMatch(/^D \(daily 2026-11-01\)/);
  });
  it('rooms showing each other, and pairs that cannot finish, are fine', () => {
    const roomA = { id: 'A', side: 'room' as const, day: null, topicKey: 'XX:2:apps', keys: keysOfValues('p', [180, 141, 180]) };
    const roomB = { id: 'B', side: 'room' as const, day: null, topicKey: 'XX:3:apps', keys: keysOfValues('p', [180, 141, 180]) };
    const daily = { id: 'D', side: 'daily' as const, day: '2026-11-01', topicKey: 'XX:1:apps', keys: keysOfValues('p', [180, 141]) };
    expect(exposedCheckout([roomA, roomB])).toBeNull();
    expect(exposedCheckout([daily, roomA])).toBeNull();
  });
});

describe('shared pairs scale with the smaller category', () => {
  const sized = (id: string, n: number, topicKey = id) => ({ ...daily, id, topicKey, entries: Array.from({ length: n }, (_, i) => ({ eid: `q${i}`, value: i + 1 })) });
  const against = (n: number, shared: number) => row({ side: 'daily', category_id: 'big', topic_key: 'ZZ:1:goals', day: '2026-11-01', entry_keys: [...keysOf(sized('x', n)).slice(0, shared), ...Array.from({ length: 3_000 }, (_, i) => `r${i}=7`)] });
  it('the limit is 5, or 10% of the smaller category rounded up', () => {
    expect(pairsLimit(35, 3_000)).toBe(5);
    expect(pairsLimit(50, 140)).toBe(5);
    expect(pairsLimit(51, 140)).toBe(6);
    expect(pairsLimit(3_000, 140)).toBe(14);
  });
  it('exactly 5 shared is refused on a small category, 4 is not', () => {
    expect(conflict('room', { category: sized('c', 50), day: null }, against(50, 5))).toMatch(/5 of the same .* limit 5/);
    expect(conflict('room', { category: sized('c', 50), day: null }, against(50, 4))).toBeNull();
  });
  it('on 140 entries, 13 coincidences pass and 14 (10%) are refused', () => {
    expect(conflict('room', { category: sized('c', 140), day: null }, against(140, 13))).toBeNull();
    expect(conflict('room', { category: sized('c', 140), day: null }, against(140, 14))).toMatch(/14 of the same .* limit 14/);
    expect(conflict('daily', { category: sized('c', 140), day: '2026-12-20' }, against(140, 14))).toMatch(/14 of the same/);
  });
  it('the smaller side sets the limit whichever of the two is stored (51 entries: 6)', () => {
    const stored = (n: number, shared: number) => row({ side: 'daily', category_id: 'small', topic_key: 'ZZ:1:goals', day: '2026-11-01', entry_keys: [...keysOf(sized('x', n)).slice(0, shared), ...Array.from({ length: n - shared }, (_, i) => `r${i}=7`)] });
    expect(conflict('room', { category: sized('c', 3_000), day: null }, stored(51, 5))).toBeNull();
    expect(conflict('room', { category: sized('c', 3_000), day: null }, stored(51, 6))).toMatch(/6 of the same .* limit 6/);
    expect(conflict('room', { category: sized('c', 3_000), day: null }, stored(50, 5))).toMatch(/limit 5/);
  });
  it('a near copy (zero-goal footballers repeat the apps board) is still refused', () => {
    expect(conflict('room', { category: sized('c', 400), day: null }, against(400, 300))).toMatch(/300 of the same/);
  });
});

describe('dailies on the same club or nation stand 21 days apart (from 2026-12-15)', () => {
  const on = (topicKey: string, day: string) => ({ category: { ...daily, id: `${topicKey}@${day}`, topicKey }, day });
  const shown = (topic_key: string, day: string) => row({ side: 'daily', category_id: `${topic_key}@${day}`, topic_key, day });
  it('20 days apart is refused, 21 is not, on either side of the earlier day', () => {
    expect(conflict('daily', on('CL:77:apps', '2027-01-05'), shown('IL1:77:goals', '2026-12-16'))).toMatch(/subject 77 was the daily 20 day\(s\) away/);
    expect(conflict('daily', on('CL:77:apps', '2027-01-05'), shown('IL1:77:goals', '2026-12-15'))).toBeNull();
    expect(conflict('daily', on('CL:77:apps', '2026-12-20'), shown('IL1:77:goals', '2027-01-09'))).toMatch(/20 day/);
    expect(conflict('daily', on('CL:77:apps', '2026-12-20'), shown('IL1:77:goals', '2027-01-10'))).toBeNull();
  });
  it('links a nation across its caps and competition boards; other subjects are free', () => {
    expect(conflict('daily', on('CLN:ZZA:apps', '2026-12-20'), shown('NT:ZZA:caps', '2026-12-18'))).toMatch(/subject ZZA/);
    expect(conflict('daily', on('CLN:ZZB:apps', '2026-12-20'), shown('NT:ZZA:caps', '2026-12-19'))).toBeNull();
    expect(conflict('daily', on('CL:all:apps', '2026-12-20'), shown('CL:all:goals', '2026-12-19'))).toMatch(/subject CL:all/);
    // Competition-wide boards of different competitions are different subjects (review be#1017).
    expect(conflict('daily', on('IL1:all:goals', '2026-12-20'), shown('CL:all:apps', '2026-12-18'))).toBeNull();
    expect(conflict('daily', on('IL1:big3:goals', '2026-12-20'), shown('ES1:big3:apps', '2026-12-18'))).toBeNull();
    expect(conflict('daily', on('IL1:big3:goals', '2026-12-20'), shown('IL1:big3:apps', '2026-12-18'))).toMatch(/subject IL1:big3/);
  });
  it('days before 2026-12-15 stay correctable; the cut is on the incoming day', () => {
    expect(conflict('daily', on('IL1:77:goals', '2026-12-14'), shown('IL1:77:apps', '2026-12-01'))).toBeNull();
    expect(conflict('daily', on('IL1:77:goals', '2026-12-15'), shown('IL1:77:apps', '2026-12-01'))).toMatch(/14 day/);
  });
  it('a correction before the cut, sent with the live later day, passes; a new later day is still bound', () => {
    const later = on('CL:77:apps', '2026-12-20');
    const correction = { category: { ...on('IL1:77:goals', '2026-12-14').category, entries: [{ eid: 'z1', value: 3 }] }, day: '2026-12-14' };
    const rev = (c: { id: string; topicKey: string }) => `rev-${c.id}-${c.topicKey}`;
    const ledger = [{ ...shown('CL:77:apps', '2026-12-20'), entry_keys: keysOf(later.category) }];
    expect(batchRefusal('daily', [correction, later], ledger, rev, new Map([['2026-12-20', rev(later.category)]]))).toBeNull();
    expect(batchRefusal('daily', [correction, later], ledger, rev)).toMatch(/subject 77 was the daily 6 day/);
    expect(batchRefusal('daily', [correction, later], ledger, rev, new Map([['2026-12-20', 'other']]))).toMatch(/subject 77/);
  });
  it('restoring a superseded revision is checked like new content (review be#1017)', () => {
    const rev = (c: { id: string; topicKey: string }) => `rev-${c.id}-${c.topicKey}`;
    const laterA = { category: { ...daily, id: 'later', topicKey: 'IL1:77:apps', entries: [{ eid: 'a1', value: 2 }] }, day: '2026-12-20' };
    const laterB = { category: { ...laterA.category, topicKey: 'IL1:88:apps' }, day: '2026-12-20' };
    const early = { category: { ...daily, id: 'early', topicKey: 'CL:77:goals', entries: [{ eid: 'e1', value: 2 }] }, day: '2026-12-14' };
    const asRow = (it: typeof laterA) => ({ side: 'daily' as const, category_id: it.category.id, topic_key: it.category.topicKey, entry_keys: keysOf(it.category), day: it.day });
    const ledger = [asRow(laterA), asRow(laterB), asRow(early)];
    // 12-20 went A → B; 12-14 was then corrected onto subject 77; putting A back on 12-20 is six days from it.
    expect(batchRefusal('daily', [laterA], ledger, rev, new Map([['2026-12-20', rev(laterB.category)]]))).toMatch(/subject 77 .*6 day/);
    expect(batchRefusal('daily', [laterB], ledger, rev, new Map([['2026-12-20', rev(laterB.category)]]))).toBeNull();
  });
  it("the room side, a day's own revision, and keys without a subject are not bound", () => {
    expect(conflict('room', on('CL:77:apps', '2026-12-20'), shown('IL1:77:goals', '2026-12-19'))).toBeNull();
    expect(conflict('daily', on('CL:77:apps', '2026-12-20'), shown('IL1:77:goals', '2026-12-20'))).toBeNull();
    expect(conflict('daily', on('solo', '2026-12-20'), shown('solo2', '2026-12-19'))).toBeNull();
  });
});

describe('apps and apps minus goals of one club show the same leaders (review be#1017)', () => {
  // Every footballer scored once: not one pair matches, yet the same three win both boards.
  const board = (topicKey: string, shift: number) => ({ ...daily, id: topicKey, topicKey, entries: Array.from({ length: 40 }, (_, i) => ({ eid: `s${i}`, value: (i < 3 ? 170 : 20) - shift })) });
  const apps = board('IL1:77:apps', 0);
  const minus = board('IL1:77:apps_minus_goals', 1);
  const asRow = (c: typeof apps, side: 'daily' | 'room', day: string | null) => row({ side, category_id: c.id, topic_key: c.topicKey, entry_keys: keysOf(c), day });
  it('are refused across sides and between dailies, with no shared pair', () => {
    expect(keysOf(apps).filter((k) => keysOf(minus).includes(k))).toHaveLength(0);
    expect(conflict('room', { category: minus, day: null }, asRow(apps, 'daily', '2026-11-18'))).toMatch(/same leaders as IL1:77:apps/);
    expect(conflict('daily', { category: apps, day: '2026-11-18' }, asRow(minus, 'room', null))).toMatch(/same leaders/);
    expect(conflict('daily', { category: minus, day: '2027-02-20' }, asRow(apps, 'daily', '2026-11-18'))).toMatch(/same leaders/);
  });
  it('another club, another competition, or goals are not twins; rooms among themselves stay free', () => {
    expect(conflict('room', { category: board('IL1:78:apps_minus_goals', 1), day: null }, asRow(apps, 'daily', '2026-11-18'))).toBeNull();
    expect(conflict('room', { category: board('CL:77:apps_minus_goals', 1), day: null }, asRow(apps, 'daily', '2026-11-18'))).toBeNull();
    expect(conflict('room', { category: board('IL1:77:goals', 5), day: null }, asRow(minus, 'daily', '2026-11-18'))).toBeNull();
    expect(conflict('room', { category: minus, day: null }, asRow(apps, 'room', null))).toBeNull();
  });
});

it('the pair limit is max(5, ceil(n/10)) for every category size (no float rounding surprises)', () => {
  for (let n = 1; n <= 3_000; n++) expect(pairsLimit(n, 3_000)).toBe(Math.max(5, Math.ceil(n / 10)));
});

describe('pairs are compared only between boards of one unit class and one scope, read from the topic (owner 2026-11-23)', () => {
  const board = (topicKey: string, over: Partial<D501Category> = {}) => ({ ...daily, id: topicKey, topicKey, ...over });
  const shownAs = (c: D501Category, side: 'daily' | 'room', day: string | null) => row({ side, category_id: c.id, topic_key: c.topicKey, entry_keys: keysOf(c), day });
  // The same footballers with the same numbers on every board: only the topics differ.
  const club = board('XX:1:apps');
  const sum = board('XX:ZZA:apps');
  const value = board('XX:7:market_value_eur_m', { unit: 'market_value_eur_m' });

  it('reads scope and unit class from the topic', () => {
    for (const topic of ['GB1:ZZA:apps', 'CLN:ZZA:apps', 'IT1:big3:apps', 'CL:all:goals', 'GB1:all:market_value_eur_m']) expect(scopeOf(topic)).toBe('combined');
    for (const topic of ['ES1:418:apps', 'CL:418:apps']) expect(scopeOf(topic)).toBe('club');
    expect(scopeOf('NT:ZZA:caps')).toBe('nation');
    for (const topic of ['solo', 'ES1:418 :apps', 'ES1:chelsea:apps', 'ES1:418-2024:goals', 'GB1:11-ZZA:apps', 'NT:zza:caps']) expect(scopeOf(topic)).toBeNull();
    expect(pairsComparable('XX:1:apps', 'YY:2:goals')).toBe(true);
    expect(pairsComparable('XX:1:apps', 'XX:ZZA:apps')).toBe(false);
    expect(pairsComparable('XX:ZZA:apps', 'XX:1:apps')).toBe(false);
    expect(pairsComparable('XX:1:apps', 'XX:1:market_value_eur_m')).toBe(false);
    expect(pairsComparable('XX:all:market_value_eur_m', 'YY:all:market_value_eur_m')).toBe(true);
  });

  it('national-team boards keep being compared with clubs and with combined boards', () => {
    expect(pairsComparable('NT:ZZA:goals', 'CLN:ZZA:goals')).toBe(true);
    expect(pairsComparable('NT:ZZA:caps', 'XX:1:apps')).toBe(true);
    const nation = board('NT:ZZA:caps', { unit: 'caps' });
    expect(conflict('room', { category: nation, day: null }, shownAs(sum, 'daily', '2026-11-01'))).toMatch(/same footballer-and-number pairs/);
    expect(conflict('daily', { category: sum, day: '2026-12-20' }, shownAs(nation, 'room', null))).toMatch(/same footballer-and-number pairs/);
  });

  it('combined boards among themselves still count toward a shared finish and exposure', () => {
    const three = keysOf({ entries: daily.entries.filter((e) => ['p0', 'p1', 'p8'].includes(e.eid)) });
    expect(sharedFinish('room', { category: sum, day: null }, [row({ side: 'daily', topic_key: 'CL:all:apps', entry_keys: three, day: '2026-11-01' })])).toMatch(/check out on their own/);
    expect(sharedFinish('room', { category: sum, day: null }, [row({ side: 'daily', topic_key: 'CL:7:apps', entry_keys: three, day: '2026-11-01' })])).toBeNull();
    const exposed = (topicKey: string, side: 'daily' | 'room', keys: string[]) => ({ id: topicKey, side, day: side === 'daily' ? '2026-11-01' : null, topicKey, keys: new Set(keys) });
    expect(exposedCheckout([exposed('CL:all:apps', 'daily', three), exposed('XX:ZZA:apps', 'room', three)])).toMatch(/^CL:all:apps/);
  });

  it('a combined board may repeat single-club pairs: no pair conflict, no shared finish, no exposure, either way round', () => {
    expect(conflict('room', { category: sum, day: null }, shownAs(club, 'daily', '2026-11-01'))).toBeNull();
    expect(conflict('daily', { category: club, day: '2026-12-20' }, shownAs(sum, 'room', null))).toBeNull();
    expect(sharedFinish('room', { category: sum, day: null }, [shownAs(club, 'daily', '2026-11-01')])).toBeNull();
    expect(batchRefusal('room', [{ category: sum, day: null }], [shownAs(club, 'daily', '2026-11-01')], (c) => c.id)).toBeNull();
    expect(batchRefusal('daily', [{ category: sum, day: '2026-12-20' }], [shownAs(club, 'daily', '2026-11-01')], (c) => c.id)).toBeNull();
  });

  it('single-club boards, and combined boards among themselves, are still refused over the limit', () => {
    expect(conflict('room', { category: board('XX:2:apps'), day: null }, shownAs(club, 'daily', '2026-11-01'))).toMatch(/same footballer-and-number pairs as XX:1:apps/);
    expect(conflict('room', { category: board('NT:ZZB:caps', { unit: 'caps' }), day: null }, shownAs(club, 'daily', '2026-11-01'))).toMatch(/same footballer-and-number pairs/);
    expect(conflict('room', { category: board('CL:all:apps'), day: null }, shownAs(sum, 'daily', '2026-11-01'))).toMatch(/same footballer-and-number pairs as XX:ZZA:apps/);
    expect(batchRefusal('room', [{ category: board('XX:2:apps'), day: null }], [shownAs(club, 'daily', '2026-11-01')], (c) => c.id)).toMatch(/same footballer-and-number pairs/);
  });

  it('incoming boards of one batch are compared by their topics too, in either order', () => {
    const mixed = [{ category: club, day: '2027-01-10' }, { category: sum, day: '2027-01-12' }];
    expect(batchRefusal('daily', mixed, [], (c) => c.id)).toBeNull();
    expect(batchRefusal('daily', [...mixed].reverse(), [], (c) => c.id)).toBeNull();
    const clubs = [{ category: club, day: '2027-01-10' }, { category: board('XX:2:apps'), day: '2027-01-12' }];
    expect(batchRefusal('daily', clubs, [], (c) => c.id)).toMatch(/same footballer-and-number pairs/);
    expect(batchRefusal('daily', [...clubs].reverse(), [], (c) => c.id)).toMatch(/same footballer-and-number pairs/);
  });

  it('the exemption covers pairs only: the same topic, or the apps / apps-minus-goals twin, is still refused', () => {
    expect(conflict('room', { category: board(sum.topicKey, { id: 'renamed' }), day: null }, shownAs(sum, 'daily', '2026-11-01'))).toMatch(/topic XX:ZZA:apps was shown/);
    expect(conflict('room', { category: board('XX:ZZA:apps_minus_goals', { unit: 'apps_minus_goals' }), day: null }, shownAs(sum, 'daily', '2026-11-01'))).toMatch(/same leaders/);
  });

  it('a market-value board is not compared with count boards, stored or incoming, but is with another market-value board', () => {
    expect(conflict('room', { category: value, day: null }, shownAs(club, 'daily', '2026-11-01'))).toBeNull();
    expect(conflict('daily', { category: club, day: '2026-12-20' }, shownAs(value, 'room', null))).toBeNull();
    expect(sharedFinish('room', { category: value, day: null }, [shownAs(club, 'daily', '2026-11-01')])).toBeNull();
    expect(batchRefusal('room', [{ category: value, day: null }], [shownAs(club, 'daily', '2026-11-01')], (c) => c.id)).toBeNull();
    expect(conflict('room', { category: board('XX:9:market_value_eur_m', { unit: 'market_value_eur_m' }), day: null }, shownAs(value, 'daily', '2026-11-01'))).toMatch(/same footballer-and-number pairs/);
  });

  it('count units still compare with each other (a footballer without a goal has the same apps and apps minus goals)', () => {
    expect(conflict('room', { category: board('YY:3:goals', { unit: 'goals' }), day: null }, shownAs(club, 'daily', '2026-11-01'))).toMatch(/same footballer-and-number pairs/);
    expect(conflict('room', { category: board('YY:3:apps_minus_goals', { unit: 'apps_minus_goals' }), day: null }, shownAs(club, 'daily', '2026-11-01'))).toMatch(/same footballer-and-number pairs/);
  });

  it('exposure: pairs only count between comparable boards', () => {
    const exposed = (c: D501Category, side: 'daily' | 'room', day: string | null) => ({ id: c.id, side, day, topicKey: c.topicKey, keys: new Set(keysOf(c)) });
    expect(exposedCheckout([exposed(club, 'daily', '2026-11-01'), exposed(sum, 'room', null)])).toBeNull();
    expect(exposedCheckout([exposed(club, 'daily', '2026-11-01'), exposed(value, 'room', null)])).toBeNull();
    expect(exposedCheckout([exposed(club, 'daily', '2026-11-01'), exposed(board('XX:2:apps'), 'room', null)])).toMatch(/^XX:1:apps \(daily 2026-11-01\)/);
  });

  it('new content must spell a known scope and its own unit in the topic', () => {
    expect(topicProblem(club)).toBeNull();
    expect(topicProblem(sum)).toBeNull();
    expect(topicProblem(value)).toBeNull();
    expect(topicProblem(board('NT:ZZA:apps'))).toBeNull();
    expect(topicProblem(board('GB1:all:peak_value_eur_m', { unit: 'market_value_eur_m' }))).toMatch(/ends in peak_value_eur_m, not its unit market_value_eur_m/);
    expect(topicProblem(board('XX:1:goals'))).toMatch(/not its unit apps/);
    for (const topic of ['solo', 'XX::apps', 'XX:1:apps:x', 'xx:1:apps', 'ES1:418 :apps', 'ES1:chelsea:apps', 'ES1:418-2024:apps', 'GB1:11-ZZA:apps']) {
      expect(topicProblem(board(topic))).toMatch(/is not <competition>:<club id, nation or group>:<unit>/);
    }
  });
});
