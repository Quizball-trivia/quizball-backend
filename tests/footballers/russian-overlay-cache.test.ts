import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../setup.js';

const db = vi.hoisted(() => ({ sql: vi.fn(), failNext: new Set<string>(), gate: new Map<string, Promise<void>>() }));
vi.mock('../../src/db/index.js', () => ({ sql: db.sql }));

import { forgetRussian, heldRussianIndex, RoomContentUnavailable, roomRussianView, russianIndex } from '../../src/modules/footballers/footballers.russian.js';

// The two reads a version load makes: its row count, then its names (one page).
db.sql.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
  const text = strings.join('?');
  const version = String(values[0]);
  await db.gate.get(version);
  if (text.includes('FROM wordgame_ru_versions')) {
    if (db.failNext.delete(version)) throw new Error('CONNECTION_CLOSED');
    return [{ players: 1 }];
  }
  return [{ pid: `p-${version}`, name_ru: 'Лионель Месси', game_name_ru: 'Месси', fame: 90 }];
});
const loadsOf = (version: string) => db.sql.mock.calls.filter((c) => (c[0] as TemplateStringsArray).join('?').includes('FROM wordgame_ru_versions') && c[1] === version).length;

describe('word game Russian names: the per-process cache', () => {
  beforeEach(() => {
    forgetRussian();
    db.sql.mockClear();
    db.failNext.clear();
    db.gate.clear();
  });

  it('holds two versions; the oldest is evicted and loaded again when asked for', async () => {
    await russianIndex('a');
    await russianIndex('b');
    expect(heldRussianIndex('a')).toBeDefined();
    await russianIndex('c');
    expect(heldRussianIndex('b')).toBeUndefined();
    expect(heldRussianIndex('a')).toBeDefined();
    await russianIndex('b');
    expect(loadsOf('b')).toBe(2);
  });

  it('a load in flight is shared, even after other versions loaded meanwhile', async () => {
    let open!: () => void;
    db.gate.set('a', new Promise<void>((resolve) => { open = resolve; }));
    const first = russianIndex('a');
    await russianIndex('b');
    await russianIndex('c');
    const again = russianIndex('a');
    expect(again).toBe(first);
    open();
    expect(await again).toBe(await first);
    expect(loadsOf('a')).toBe(1);
  });

  it('a failed load is not remembered: the next caller loads again', async () => {
    db.failNext.add('a');
    await expect(russianIndex('a')).rejects.toThrow('CONNECTION_CLOSED');
    expect(heldRussianIndex('a')).toBeUndefined();
    const index = await russianIndex('a');
    expect(index.resolve('Месси')).toEqual(['p-a']);
  });

  it('a room hydrating under its match lock never reads the database: a held view is reused, a missing version refuses', async () => {
    const universe = { releaseId: 'rel', player: () => ({ pid: 'p-a' }) } as never;
    const view = { releaseId: 'rel' } as never;
    expect(await roomRussianView(universe, view, 'a', true)).toBe(view);
    await expect(roomRussianView(universe, null, 'a', true)).rejects.toBeInstanceOf(RoomContentUnavailable);
    expect(loadsOf('a')).toBe(0);
    await roomRussianView(universe, null, 'a', false);
    expect(loadsOf('a')).toBe(1);
    db.sql.mockClear();
    await roomRussianView(universe, null, 'a', true);
    expect(db.sql).not.toHaveBeenCalled();
  });
});
