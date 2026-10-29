import { describe, expect, it } from 'vitest';
import { conflict, keysOf, sharedFinish, type LedgerRow } from '../../src/modules/darts501/darts501.seed.js';
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

  it('across sides: the same club and competition in another unit, or shared pairs, are refused', () => {
    expect(conflict('room', { category: { ...daily, topicKey: 'GB1:11:goals' }, day: null }, row({ side: 'daily', topic_key: 'GB1:11:apps', day: '2026-11-01' }))).toMatch(/topic family GB1:11/);
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
