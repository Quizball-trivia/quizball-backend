import { describe, expect, it, vi } from 'vitest';
import '../setup.js';

const db = vi.hoisted(() => ({ greek: false, russian: false }));
// Invented clubs only: the repository is public.
vi.mock('../../src/db/index.js', () => {
  const mocked = {
  sql: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    if (text.includes('tenable_el_releases')) return db.greek ? [{ players_version: null, names_version: 'g' }] : [];
    if (text.includes('tenable_el_names')) return values.includes('') ? [{ eid: 'c-1', name: 'Νόρθγκεϊτ', known: 'Νόρθγκεϊτ', aliases: ['Ρόβερς'], qualifier: null }] : [];
    if (text.includes('tenable_ru_releases')) return db.russian ? [{ players_version: null, names_version: 'r' }] : [];
    if (text.includes('tenable_ru_names')) return values.includes('') ? [{ eid: 'c-1', name: 'Нортгейт', known: 'Нортгейт', aliases: [], qualifier: null }] : [];
    if (text.includes('tenable_entities')) return values.includes('') ? [{ eid: 'c-1', name: 'Northgate', known: 'Northgate', fame: 50, aliases: [], qualifier: null }] : [];
    return [];
  }),
  };
  return { ...mocked, withStatementTimeout: vi.fn((run: (tx: unknown) => Promise<unknown>) => run(mocked.sql)) };
});

import { tenableDirectories } from '../../src/modules/tenable/tenable.directories.js';
import { withStatementTimeout } from '../../src/db/index.js';

describe('a release pinned to Greek names', () => {
  it('reads Greek answers with them, Cyrillic and Latin ones as before', async () => {
    tenableDirectories.clear();
    db.greek = true;
    db.russian = true;
    const directory = await tenableDirectories.get('club', 'both');
    expect(directory.identify('Νόρθγκεϊτ')).toEqual({ kind: 'entity', eid: 'c-1' });
    expect(directory.identify('ροβερσ')).toEqual({ kind: 'entity', eid: 'c-1' });
    expect(directory.identify('Нортгейт')).toEqual({ kind: 'entity', eid: 'c-1' });
    expect(directory.identify('Northgate')).toEqual({ kind: 'entity', eid: 'c-1' });
    expect(directory.greek?.entity('c-1')?.name).toBe('Νόρθγκεϊτ');
    expect(directory.russian?.entity('c-1')?.name).toBe('Нортгейт');
  });

  it('without a Greek pin a Greek answer means no one, and Russian is unchanged', async () => {
    tenableDirectories.clear();
    db.greek = false;
    db.russian = true;
    const directory = await tenableDirectories.get('club', 'ru-only');
    expect(directory.greek).toBeUndefined();
    expect(directory.identify('Νόρθγκεϊτ')).toEqual({ kind: 'unknown' });
    expect(directory.identify('Нортгейт')).toEqual({ kind: 'entity', eid: 'c-1' });
  });

  it('keeps its first Greek answer for the life of the process', async () => {
    tenableDirectories.clear();
    db.greek = false;
    db.russian = false;
    expect((await tenableDirectories.get('club', 'first')).identify('Νόρθγκεϊτ')).toEqual({ kind: 'unknown' });
    db.greek = true;
    for (let i = 0; i < 9; i += 1) await tenableDirectories.get('club', `other-${i}`);
    expect(tenableDirectories.loaded('club', 'first')).toBe(false);
    expect((await tenableDirectories.get('club', 'first')).identify('Νόρθγκεϊτ')).toEqual({ kind: 'unknown' });
    expect((await tenableDirectories.get('club', 'other-0')).identify('Νόρθγκεϊτ')).toEqual({ kind: 'entity', eid: 'c-1' });
  });

  it('reads the Greek (and Russian) pin under a statement timeout, so a stalled lookup cannot stay cached', async () => {
    tenableDirectories.clear();
    db.greek = true;
    db.russian = true;
    vi.mocked(withStatementTimeout).mockClear();
    await tenableDirectories.get('club', 'bounded');
    const read = await Promise.all(vi.mocked(withStatementTimeout).mock.calls.map(async ([run]) => {
      const seen: string[] = [];
      await run(((strings: TemplateStringsArray) => { seen.push(strings.join('?')); return Promise.resolve([]); }) as never);
      return seen.join(' ');
    }));
    expect(read.some((text) => text.includes('tenable_el_releases'))).toBe(true);
    expect(read.some((text) => text.includes('tenable_ru_releases'))).toBe(true);
  });
});
