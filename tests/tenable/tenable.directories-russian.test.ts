import { describe, expect, it, vi } from 'vitest';
import '../setup.js';

const db = vi.hoisted(() => ({ pinned: false }));
// Invented clubs only: the repository is public.
vi.mock('../../src/db/index.js', () => ({
  sql: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    if (text.includes('tenable_ru_releases')) return db.pinned ? [{ players_version: null, names_version: 'v' }] : [];
    if (text.includes('tenable_ru_names')) return values.includes('') ? [{ eid: 'c-1', name: 'Нортгейт', known: 'Нортгейт', aliases: [], qualifier: null }] : [];
    if (text.includes('tenable_entities')) return values.includes('') ? [{ eid: 'c-1', name: 'Northgate', known: 'Northgate', fame: 50, aliases: [], qualifier: null }] : [];
    return [];
  }),
}));

import { tenableDirectories } from '../../src/modules/tenable/tenable.directories.js';

describe('a release keeps its first Russian answer for the life of the process', () => {
  it('a pin written after the first load is not picked up when the release is evicted and loaded again', async () => {
    tenableDirectories.clear();
    db.pinned = false;
    expect((await tenableDirectories.get('club', 'first')).identify('Нортгейт')).toEqual({ kind: 'unknown' });
    db.pinned = true;
    for (let i = 0; i < 9; i += 1) await tenableDirectories.get('club', `other-${i}`);
    expect(tenableDirectories.loaded('club', 'first')).toBe(false);
    expect((await tenableDirectories.get('club', 'first')).identify('Нортгейт')).toEqual({ kind: 'unknown' });
    expect((await tenableDirectories.get('club', 'other-0')).identify('Нортгейт')).toEqual({ kind: 'entity', eid: 'c-1' });
  });
});

describe('two loads of one release in flight', () => {
  it('share one pin lookup, even when the first is evicted from the cache before it finishes', async () => {
    tenableDirectories.clear();
    const { sql } = await import('../../src/db/index.js');
    const calls = vi.mocked(sql as unknown as (s: TemplateStringsArray, ...v: unknown[]) => unknown).mock.calls;
    const lookups = () => calls.filter((c) => (c[0] as TemplateStringsArray).join('').includes('tenable_ru_releases') && c.includes('race')).length;
    const first = tenableDirectories.get('club', 'race');
    const others = Array.from({ length: 9 }, (_, i) => tenableDirectories.get('club', `crowd-${i}`));
    expect(tenableDirectories.loaded('club', 'race')).toBe(false);
    const second = tenableDirectories.get('club', 'race');
    await Promise.all([first, second, ...others]);
    expect(lookups()).toBe(1);
  });
});
