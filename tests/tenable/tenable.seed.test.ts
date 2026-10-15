import { describe, expect, it } from 'vitest';
import { overlapFailures, parseList } from '../../src/modules/tenable/tenable.seed.js';
import { TENABLE_MATCHER_VERSION } from '../../src/modules/tenable/tenable.identify.js';

const list = (id: string, topicKey: string, eids: string[], extra: Record<string, unknown> = {}) => ({
  id, kind: 'player' as const, release: 'rel', matcher: TENABLE_MATCHER_VERSION, tier: 'easy' as const, topicKey,
  title: { en: id, es: id, ka: id, tr: id }, note: null, asOf: null,
  slots: eids.map((eid, i) => ({ eid, figure: { value: 100 - i, unit: 'goals' as const } })), ...extra,
});
const ten = (p: string) => Array.from({ length: 10 }, (_, i) => `${p}${i}`);
const row = (side: string, l: ReturnType<typeof list>, supersedes: string | null = null, day: string | null = null) => ({ side, list_id: l.id, topic_key: l.topicKey, eids: l.slots.map((s) => s.eid), supersedes, day });

describe('overlap rules', () => {
  it('the same id on the other side is always refused', () => {
    const daily = list('a', 'topic-a', ten('x'));
    expect(overlapFailures([daily], 'room', [row('day', daily)])).toHaveLength(1);
  });
  it('re-seeding the same list on its own side is fine', () => {
    const daily = list('a', 'topic-a', ten('x'));
    expect(overlapFailures([daily], 'day', [row('day', daily)])).toHaveLength(0);
  });
  it('4 shared entities across sides are refused; on one side they are related lists', () => {
    const a = list('a', 'topic-a', ten('x'));
    const b = list('b', 'topic-b', [...ten('x').slice(0, 4), ...ten('y').slice(0, 6)]);
    expect(overlapFailures([b], 'room', [row('day', a)])).toHaveLength(1);
    expect(overlapFailures([b], 'day', [row('day', a)])).toHaveLength(0);
  });
  it('the same topic under another id is refused on either side, unless it supersedes it on the same side', () => {
    const a = list('a', 'topic-a', ten('x'));
    const b = list('b', 'topic-a', ten('y'));
    expect(overlapFailures([b], 'day', [row('day', a)])).toHaveLength(1);
    expect(overlapFailures([{ ...b, supersedes: 'a' }], 'day', [row('day', a)])).toHaveLength(0);
    expect(overlapFailures([{ ...b, supersedes: 'a' }], 'room', [row('day', a)])).toHaveLength(1);
  });
  it('every published version counts: an old version of a corrected list stays reserved', () => {
    const old = list('a', 'topic-a', ten('x'));
    const corrected = list('a', 'topic-a', ten('z'));
    const reuse = list('c', 'topic-c', ten('x'));
    expect(overlapFailures([reuse], 'room', [row('day', old), row('day', corrected)])).toHaveLength(1);
  });
  it('a lineage A → B → C on one side is one list', () => {
    const a = list('a', 'topic-a', ten('x'));
    const b = list('b', 'topic-a', ten('y'));
    const c = list('c', 'topic-a', ten('z'));
    expect(overlapFailures([{ ...c, supersedes: 'b' }], 'room', [row('room', a), row('room', b, 'a')])).toHaveLength(0);
    expect(overlapFailures([{ ...c, supersedes: 'b' }], 'day', [row('room', a), row('room', b, 'a')])).toHaveLength(1);
  });
  it('superseding something never published on that side is refused', () => {
    const b = list('b', 'topic-b', ten('y'));
    expect(overlapFailures([{ ...b, supersedes: 'ghost' }], 'room', [])).toHaveLength(1);
  });
  it('a daily list, or a correction of it, never moves to another day', () => {
    const a = list('a', 'topic-a', ten('x'));
    const b = list('b', 'topic-a', ten('y'));
    const ledger = [row('day', a, null, '2026-10-12')];
    expect(overlapFailures([{ ...a, day: '2026-10-12' }], 'day', ledger)).toHaveLength(0);
    expect(overlapFailures([{ ...a, day: '2026-10-13' }], 'day', ledger)).toHaveLength(1);
    expect(overlapFailures([{ ...b, supersedes: 'a', day: '2026-10-12' }], 'day', ledger)).toHaveLength(0);
    expect(overlapFailures([{ ...b, supersedes: 'a', day: '2026-10-20' }], 'day', ledger)).toHaveLength(1);
  });
});

describe('parseList', () => {
  it('accepts a list that supersedes another, and refuses superseding itself', () => {
    const l = list('b', 'topic-b', ten('y'));
    expect(parseList({ ...l, supersedes: 'a' }, 'x').supersedes).toBe('a');
    expect(() => parseList({ ...l, supersedes: 'b' }, 'x')).toThrow();
    expect(() => parseList({ ...l, extra: 1 }, 'x')).toThrow();
  });
});
