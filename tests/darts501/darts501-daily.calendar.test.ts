import { describe, expect, it } from 'vitest';
import { category, coverage, directory } from './fixture.js';
import { createDarts501DailyService, type D501CalendarReads } from '../../src/modules/darts501-daily/darts501-daily.service.js';
import { dayEndsAt } from '../../src/modules/daily/daily.calendar.js';
import { daysMaxAge } from '../../src/modules/darts501-daily/darts501-daily.controller.js';
import type { D501Category } from '../../src/modules/darts501/darts501.content.js';

// Buenos Aires is UTC-3: 2026-11-25 runs 03:00Z → 03:00Z next day.
const TODAY = '2026-11-25';
const NOON = new Date('2026-11-25T15:00:00Z');

type Served = { day: string; number: number; contentVersion: number; category: D501Category; directory: typeof directory; coverage: typeof coverage };
const dayNumber = (day: string) => Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse('2026-10-24T00:00:00Z')) / 86_400_000) + 1;
const served = (day: string, id = `cat-${day}`, tier: D501Category['tier'] = 'medium'): Served =>
  ({ day, number: dayNumber(day), contentVersion: 7, category: { ...category(id, tier) }, directory, coverage });

function service(opts: { days: string[]; hydrated?: string[]; now?: Date; dbNow?: Date | (() => Date); reads?: Partial<D501CalendarReads> }) {
  const index = new Map(opts.days.map((d) => [d, served(d)]));
  const boards: string[] = [];
  const content = new Map([...index].filter(([d]) => !opts.hydrated || opts.hydrated.includes(d)));
  const dbNow = typeof opts.dbNow === 'function' ? opts.dbNow : () => (opts.dbNow as Date | undefined) ?? opts.now ?? NOON;
  const now = opts.now ?? NOON;
  const reads: D501CalendarReads = {
    clock: async () => dbNow().getTime(),
    cards: async () => [
      { categoryId: 'cat-2026-11-24', card: { kind: 'apps', competition: 'XX1', subject: { en: 'Invented FC', es: 'Inventado FC' }, crest: 'Invented FC' } },
      { categoryId: `cat-${TODAY}`, card: { kind: 'nt', competition: 'NT', subject: { en: 'Secretland' }, flag: 'zz' } },
      { categoryId: 'cat-2026-11-23', card: { kind: 'nonsense' } },
    ],
    dayStats: async () => [{ day: '2026-11-24', players: 12, checkouts: 5, bestDarts: 4 }],
    myRuns: async () => [],
    ...opts.reads,
  };
  return Object.assign(createDarts501DailyService({
    repo: {
      leaderboard: async (day: string) => { boards.push(day); return { players: 1, top: [] }; },
      rankOf: async () => null,
    } as never,
    calendar: reads,
    index: async () => index,
    content: async () => content,
    contentStale: () => undefined,
    now: () => now,
    reports: { file: async () => undefined },
  }), { boards });
}

describe('GET /darts501/days', () => {
  it("lists seeded days up to today; today's category stays secret (number and tier only), no future day is listed", async () => {
    const res = (await service({ days: ['2026-11-23', '2026-11-24', TODAY, '2026-11-26', '2026-11-27', '2026-12-10'] }).days('es')).response;
    expect(res.days.map((d) => d.day)).toEqual(['2026-11-23', '2026-11-24', TODAY]);
    const today = res.days.at(-1)!;
    expect(Object.keys(today).sort()).toEqual(['closed', 'day', 'number', 'tier']);
    expect(JSON.stringify(res)).not.toContain('Secretland');
    expect(JSON.stringify(res)).not.toContain('cat-2026-11-26');
    expect(res).toMatchObject({ today: TODAY, todaySeeded: true, tomorrowSeeded: true, seededThrough: '2026-11-27', nextOpensAt: dayEndsAt(TODAY).toISOString() });
  });

  it('a closed day carries its localized title, unit, card (subject in the locale) and the leaderboard stats', async () => {
    const res = (await service({ days: ['2026-11-23', '2026-11-24', TODAY] }).days('es')).response;
    expect(res.days[1]).toEqual({
      day: '2026-11-24', number: 32, tier: 'medium', closed: true, title: 'Invented League apps for cat-2026-11-24', unit: 'apps',
      card: { kind: 'apps', competition: 'XX1', subject: 'Inventado FC', crest: 'Invented FC' },
      stats: { players: 12, checkouts: 5, bestDarts: 4 },
    });
    // An invalid card is dropped, the day still shows; a day nobody finished has zero stats.
    expect(res.days[0]).toMatchObject({ card: null, stats: { players: 0, checkouts: 0, bestDarts: null } });
  });


  it('a gap: no board today means no runway and no secret; tomorrow seeded still opens at midnight', async () => {
    const res = (await service({ days: ['2026-11-24', '2026-11-26'] }).days('en')).response;
    expect(res).toMatchObject({ todaySeeded: false, tomorrowSeeded: true, seededThrough: null });
    expect(res.days.map((d) => d.day)).toEqual(['2026-11-24']);
    const none = (await service({ days: ['2026-11-24'] }).days('en')).response;
    expect(none).toMatchObject({ todaySeeded: false, tomorrowSeeded: false, seededThrough: null, nextOpensAt: null });
  });

  it('failing card or stats reads only drop those fields, mark the body partial, and are not retried for a minute', async () => {
    let calls = 0;
    const svc = service({ days: ['2026-11-24', TODAY], reads: { cards: async () => { throw new Error('down'); }, dayStats: async () => { calls += 1; throw new Error('down'); } } });
    const out = await svc.days('en');
    expect(out.partial).toBe(true);
    expect(out.response.days[0]).toMatchObject({ closed: true, card: null, stats: null });
    await svc.days('en');
    expect(calls).toBe(1);
  });

  it("a replica whose clock is ahead of the database's never opens the next day early", async () => {
    const res = (await service({ days: ['2026-11-24', TODAY], now: new Date('2026-11-25T03:00:05Z'), dbNow: new Date('2026-11-25T02:59:58Z') }).days('en')).response;
    expect(res.today).toBe('2026-11-24');
    expect(res.days.map((d) => d.day)).toEqual(['2026-11-24']);
    expect(res.days[0]).toEqual({ day: '2026-11-24', number: 32, tier: 'medium', closed: false });
    expect(res).toMatchObject({ todaySeeded: true, tomorrowSeeded: true, seededThrough: TODAY });
  });

  it('a directory or coverage outage on a later day is not a gap: the runway reads the seeded index', async () => {
    const res = (await service({ days: ['2026-11-24', TODAY, '2026-11-26', '2026-11-27'], hydrated: ['2026-11-24', TODAY] }).days('en')).response;
    expect(res).toMatchObject({ tomorrowSeeded: true, seededThrough: '2026-11-27' });
  });
});

describe('GET /darts501/me/days', () => {
  it("returns the player's own results: checkout, gave up, in progress (darts thrown so far) and a run on replaced content", async () => {
    const svc = service({
      days: ['2026-11-22', '2026-11-23', '2026-11-24', TODAY],
      reads: {
        myRuns: async () => [
          { day: '2026-11-22', contentVersion: 7, done: true, darts: 5, thrown: 5, remaining: -2, end: 'checkout' },
          { day: '2026-11-23', contentVersion: 7, done: true, darts: 3, thrown: 3, remaining: 140, end: 'gaveUp' },
          { day: '2026-11-24', contentVersion: 6, done: true, darts: 10, thrown: 10, remaining: 40, end: 'darts' },
          { day: TODAY, contentVersion: 7, done: false, darts: null, thrown: 2, remaining: 300, end: null },
          { day: '2026-11-01', contentVersion: 7, done: true, darts: 4, thrown: 4, remaining: 0, end: 'checkout' },
        ],
      },
    });
    const res = await svc.myDays({ kind: 'member', userId: 'u1' });
    expect(res.days).toEqual({
      '2026-11-22': { done: true, checkedOut: true, gaveUp: false, darts: 5, remaining: -2, stale: false },
      '2026-11-23': { done: true, checkedOut: false, gaveUp: true, darts: 3, remaining: 140, stale: false },
      '2026-11-24': { done: true, checkedOut: false, gaveUp: false, darts: 10, remaining: 40, stale: true },
      [TODAY]: { done: false, checkedOut: false, gaveUp: false, darts: 2, remaining: 300, stale: false },
    });
  });
});

describe('GET /darts501/days caching', () => {
  it('never outlives the day the body was built for, and a partial body is cached briefly', () => {
    expect(daysMaxAge(TODAY, false, NOON)).toBe(300);
    expect(daysMaxAge(TODAY, true, NOON)).toBe(30);
    expect(daysMaxAge(TODAY, false, new Date('2026-11-26T02:59:00Z'))).toBe(60);
    // A body for yesterday sent just after midnight: already expired.
    expect(daysMaxAge('2026-11-24', false, new Date('2026-11-25T03:00:02Z'))).toBe(0);
  });
});

describe('GET /darts501/leaderboard default day', () => {
  it("is today's board when today is seeded", async () => {
    const svc = service({ days: ['2026-11-24', TODAY] });
    expect((await svc.leaderboard(undefined, null)).day).toBe(TODAY);
  });

  it('falls back to the newest readable day before today on a gap, never a future one', async () => {
    const svc = service({ days: ['2026-11-20', '2026-11-23', '2026-11-27'] });
    expect((await svc.leaderboard(undefined, null)).day).toBe('2026-11-23');
    // A board whose footballers failed to load cannot be read: the one before it is shown, with its players.
    const outage = service({ days: ['2026-11-20', '2026-11-23', '2026-11-27'], hydrated: ['2026-11-20', '2026-11-27'] });
    expect(await outage.leaderboard(undefined, null)).toMatchObject({ day: '2026-11-20', players: 1 });
  });

  it('agrees with /days just after midnight on a replica running ahead of the database', async () => {
    const svc = service({ days: ['2026-11-24', TODAY], now: new Date('2026-11-25T03:00:05Z'), dbNow: new Date('2026-11-25T02:59:58Z') });
    expect((await svc.leaderboard(undefined, null)).day).toBe('2026-11-24');
  });

  it('an explicit day is never moved', async () => {
    const svc = service({ days: ['2026-11-23'] });
    expect((await svc.leaderboard('2026-11-25', null)).day).toBe('2026-11-25');
  });
});
