import { describe, expect, it } from 'vitest';
import { batchRefusal, conflict, exposedCheckout, keysOf, pairsLimit, sharedFinish, type LedgerRow } from '../../src/modules/darts501/darts501.seed.js';
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
    const daily = { id: 'D', side: 'daily' as const, day: '2026-11-01', keys: new Set(['a=170', 'b=170', 'c=170', 'x=1']) };
    const roomA = { id: 'A', side: 'room' as const, day: null, keys: new Set(['a=170', 'b=170', 'q=2']) };
    const roomB = { id: 'B', side: 'room' as const, day: null, keys: new Set(['c=170', 'r=3']) };
    expect(exposedCheckout([daily, roomA])).toBeNull();
    expect(exposedCheckout([daily, roomA, roomB])).toMatch(/^D \(daily 2026-11-01\)/);
  });
  it('rooms showing each other, and pairs that cannot finish, are fine', () => {
    const roomA = { id: 'A', side: 'room' as const, day: null, keys: keysOfValues('p', [180, 141, 180]) };
    const roomB = { id: 'B', side: 'room' as const, day: null, keys: keysOfValues('p', [180, 141, 180]) };
    const daily = { id: 'D', side: 'daily' as const, day: '2026-11-01', keys: keysOfValues('p', [180, 141]) };
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
