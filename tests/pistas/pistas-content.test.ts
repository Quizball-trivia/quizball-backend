import { describe, expect, it, vi } from 'vitest';
import { createContentStore, indexDay } from '../../src/modules/pistas/pistas.content.js';
import { toDayRow } from '../../src/modules/pistas/pistas.seed.js';
import type { PistasDayRow } from '../../src/modules/pistas/pistas.types.js';
import { makeDay } from './fixtures.js';

const row = (day = '2026-09-27', variant = 0): PistasDayRow => structuredClone(toDayRow(makeDay(day, variant)));

describe('pistas day content', () => {
  it('builds clues field by field and keeps the normalised accepted answers server-side', () => {
    const stored = row();
    (stored.rounds[0].clues[0] as unknown as Record<string, unknown>).source = 'question 123';
    (stored.rounds[0].clues[0].text as unknown as Record<string, unknown>).de = 'hinweis';
    const day = indexDay(stored)!;
    expect(day).toMatchObject({ day: '2026-09-27', number: 1, contentVersion: stored.contentVersion });
    expect(day.rounds[0].clues[0]).toEqual({ kind: 'confed', icon: 'confed:uefa', text: { es: 'pista 0.0', en: 'clue 0.0', ka: 'მინიშნება 0.0', tr: 'ipucu 0.0' } });
    expect(day.rounds[0].display).toEqual({ es: 'Número 0', en: 'Numero 0', ka: 'ნომერი 0', tr: 'Numara 0' });
    expect([...day.rounds[0].accepted]).toEqual(['numero 0', 'ნომერი 0', 'numara 0', 'n 0']);
    expect(JSON.stringify(day.rounds[0].clues)).not.toMatch(/source|hinweis/);
  });

  it('refuses a malformed row instead of serving it', () => {
    const shortDay = row();
    shortDay.rounds.pop();
    expect(indexDay(shortDay)).toBeNull();
    const shortRound = row();
    shortRound.rounds[3].clues.pop();
    expect(indexDay(shortRound)).toBeNull();
    const badKind = row();
    (badKind.rounds[0].clues[2] as { kind: string }).kind = 'club';
    expect(indexDay(badKind)).toBeNull();
    const badLocale = row();
    badLocale.rounds[0].clues[1].text.tr = ' ';
    expect(indexDay(badLocale)).toBeNull();
    const noAnswers = row();
    noAnswers.rounds[5].answer.accepted = ['?!'];
    expect(indexDay(noAnswers)).toBeNull();
    const noDisplay = row();
    delete (noDisplay.rounds[5].answer.display as Partial<Record<string, string>>).ka;
    expect(indexDay(noDisplay)).toBeNull();
    expect(indexDay({ ...row(), rounds: {} as never })).toBeNull();
  });
});

describe('pistas content store', () => {
  function setup(rows: PistasDayRow[]) {
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

  it('loads once, re-checks the fingerprint after the refresh interval and reloads when it changed', async () => {
    const { store, source, state, clock } = setup([row('2026-09-27')]);
    const [a, b] = await Promise.all([store.get(), store.get()]);
    expect(a).toBe(b);
    expect(source.load).toHaveBeenCalledTimes(1);
    clock.now += 29_999;
    await store.get();
    expect(source.fingerprint).toHaveBeenCalledTimes(1);
    clock.now += 1;
    expect(await store.get()).toBe(a);
    expect(source.fingerprint).toHaveBeenCalledTimes(2);
    state.fingerprint = 'b';
    state.rows = [row('2026-09-27', 1), row('2026-09-28')];
    clock.now += 30_000;
    const reloaded = await store.get();
    expect([...reloaded.keys()]).toEqual(['2026-09-27', '2026-09-28']);
    expect(reloaded.get('2026-09-27')!.contentVersion).toBe(makeDay('2026-09-27', 1).contentVersion);
  });

  it('invalidate() re-checks at once; a malformed day is skipped with an error log; a failed re-check keeps the old copy', async () => {
    const bad = row('2026-09-28');
    bad.rounds = [];
    const { store, source, state, log, clock } = setup([row('2026-09-27'), bad]);
    expect([...(await store.get()).keys()]).toEqual(['2026-09-27']);
    expect(log.error).toHaveBeenCalledWith({ day: '2026-09-28' }, expect.any(String));
    state.fingerprint = 'b';
    state.rows = [row('2026-09-27', 1)];
    store.invalidate();
    expect((await store.get()).get('2026-09-27')!.contentVersion).toBe(makeDay('2026-09-27', 1).contentVersion);
    expect(source.load).toHaveBeenCalledTimes(2);
    state.fail = true;
    clock.now += 30_000;
    expect((await store.get()).size).toBe(1);
    expect(log.warn).toHaveBeenCalledTimes(1);
    const cold = setup([row()]);
    cold.state.fail = true;
    await expect(cold.store.get()).rejects.toThrow('db down');
  });
});
