import { describe, expect, it, vi } from 'vitest';
import { createContentStore, indexDay } from '../../src/modules/buscaminas/buscaminas.content.js';
import { toDayRow } from '../../src/modules/buscaminas/buscaminas.seed.js';
import type { BuscaminasDayRow } from '../../src/modules/buscaminas/buscaminas.types.js';
import { makeDay, mineCards, okCards } from './fixtures.js';

const row = (day = '2026-09-27', variant = 0): BuscaminasDayRow => toDayRow(makeDay(day, variant));

describe('buscaminas day content', () => {
  it('builds the public board field by field and keeps the answers server-side', () => {
    const stored = row();
    // A stray field in the stored board (e.g. an ok flag) never reaches the public board.
    (stored.board.rounds[0].cards[0] as unknown as Record<string, unknown>).ok = true;
    (stored.board.rounds[0] as unknown as Record<string, unknown>).notes = 'internal';
    const day = indexDay(stored)!;
    expect(day.board).toMatchObject({ day: '2026-09-27', number: 2, contentVersion: stored.contentVersion });
    expect(day.board.rounds[0]).toEqual({
      id: 'r0', difficulty: 'easy', prompt: { es: 'pista 0', en: 'clue 0', ka: 'მინიშნება 0', tr: 'ipucu 0' },
      cards: stored.board.rounds[0].cards.map(({ id, name, img }) => ({ id, name, img })),
    });
    expect(JSON.stringify(day.board)).not.toMatch(/"ok"|"notes"|"answers"/);
    expect(day.rounds[3]).toMatchObject({ id: 'r3', ok: okCards(3), mines: mineCards(3) });
    expect(day.rounds[3].okIds.has('r3c0')).toBe(true);
    expect(day.rounds[3].cardIds.size).toBe(16);
  });

  it('refuses a malformed row instead of serving it', () => {
    const noAnswers = row();
    delete noAnswers.answers.r4;
    expect(indexDay(noAnswers)).toBeNull();
    const foreignAnswer = row();
    foreignAnswer.answers.r0 = ['not-a-card'];
    expect(indexDay(foreignAnswer)).toBeNull();
    const badLocale = row();
    (badLocale.board.rounds[0].prompt as Record<string, string>).tr = '';
    expect(indexDay(badLocale)).toBeNull();
    expect(indexDay({ ...row(), board: {} as never })).toBeNull();
  });
});

describe('buscaminas content store', () => {
  function setup(rows: BuscaminasDayRow[]) {
    const clock = { now: 1_000_000 };
    const state = { fingerprint: 'a', rows, fail: false };
    const source = {
      fingerprint: vi.fn(async () => { if (state.fail) throw new Error('db down'); return state.fingerprint; }),
      load: vi.fn(async () => state.rows),
    };
    const log = { warn: vi.fn(), error: vi.fn() };
    const store = createContentStore(source, { refreshMs: 30_000, now: () => clock.now, log });
    return { store, source, state, clock, log };
  }

  it('loads once, then only re-checks the fingerprint after the refresh interval and reloads when it changed', async () => {
    const { store, source, state, clock } = setup([row('2026-09-27')]);
    const [a, b] = await Promise.all([store.get(), store.get()]);
    expect(a).toBe(b);
    expect([...a.keys()]).toEqual(['2026-09-27']);
    expect(source.load).toHaveBeenCalledTimes(1);
    expect(source.fingerprint).toHaveBeenCalledTimes(1);

    clock.now += 29_999;
    await store.get();
    expect(source.fingerprint).toHaveBeenCalledTimes(1);

    clock.now += 1;
    expect(await store.get()).toBe(a);
    expect(source.fingerprint).toHaveBeenCalledTimes(2);
    expect(source.load).toHaveBeenCalledTimes(1);

    state.fingerprint = 'b';
    state.rows = [row('2026-09-27', 1), row('2026-09-28')];
    clock.now += 30_000;
    const reloaded = await store.get();
    expect([...reloaded.keys()]).toEqual(['2026-09-27', '2026-09-28']);
    expect(reloaded.get('2026-09-27')!.contentVersion).toBe(row('2026-09-27', 1).contentVersion);
    expect(source.load).toHaveBeenCalledTimes(2);
  });

  it('invalidate() makes the next read re-check the database at once', async () => {
    const { store, source, state } = setup([row('2026-09-27')]);
    await store.get();
    state.fingerprint = 'b';
    state.rows = [row('2026-09-27', 1)];
    expect((await store.get()).get('2026-09-27')!.contentVersion).toBe(row('2026-09-27').contentVersion);
    store.invalidate();
    expect((await store.get()).get('2026-09-27')!.contentVersion).toBe(row('2026-09-27', 1).contentVersion);
    expect(source.fingerprint).toHaveBeenCalledTimes(2);
  });

  it('skips a malformed day with an error log; an empty table is an empty index', async () => {
    const bad = row('2026-09-28');
    bad.answers = {};
    const { store, log } = setup([row('2026-09-27'), bad]);
    expect([...(await store.get()).keys()]).toEqual(['2026-09-27']);
    expect(log.error).toHaveBeenCalledWith({ day: '2026-09-28' }, expect.any(String));
    expect((await setup([]).store.get()).size).toBe(0);
  });

  it('keeps serving the loaded days when a re-check fails; with nothing loaded the failure surfaces', async () => {
    const { store, state, clock, log } = setup([row()]);
    const first = await store.get();
    state.fail = true;
    clock.now += 30_000;
    expect(await store.get()).toBe(first);
    expect(log.warn).toHaveBeenCalledTimes(1);

    const cold = setup([row()]);
    cold.state.fail = true;
    await expect(cold.store.get()).rejects.toThrow('db down');
  });
});
