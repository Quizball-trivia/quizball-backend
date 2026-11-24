import { describe, expect, it } from 'vitest';
import { wlHostRunShowAt, wlHostRunUpcoming, wlHostRunWeek } from '../../src/modules/weekend-league/wl-week.js';

const ms = (iso: string) => Date.parse(iso);

describe('wlHostRunWeek (weekly Orshabatoba)', () => {
  it('maps a Monday evening in Georgia to that Monday', () => {
    const w = wlHostRunWeek(ms('2026-11-23T21:00:00+04:00'));
    expect(w.eventDate).toBe('2026-11-23');
    expect(w.entryOpensAtMs).toBe(ms('2026-11-23T00:00:00+04:00'));
    expect(w.entryClosesAtMs).toBe(ms('2026-11-30T00:00:00+04:00'));
  });

  it('opens exactly at Monday 00:00 Georgian time', () => {
    expect(wlHostRunWeek(ms('2026-11-22T23:59:59+04:00')).eventDate).toBe('2026-11-16');
    expect(wlHostRunWeek(ms('2026-11-23T00:00:00+04:00')).eventDate).toBe('2026-11-23');
  });

  it('keeps Sunday in the week that started the previous Monday', () => {
    expect(wlHostRunWeek(ms('2026-11-29T22:00:00+04:00')).eventDate).toBe('2026-11-23');
  });

  it('uses Georgian, not UTC, days (Sunday 21:00 UTC is already Monday in Tbilisi)', () => {
    expect(wlHostRunWeek(ms('2026-11-29T21:00:00Z')).eventDate).toBe('2026-11-30');
  });
});

describe('wlHostRunUpcoming / wlHostRunShowAt', () => {
  it('keeps this week while the show has not finished', () => {
    const w = wlHostRunUpcoming(ms('2026-11-23T21:00:00+04:00'), false);
    expect(w.eventDate).toBe('2026-11-23');
  });

  it('moves to next Monday, open from now, once this week finished', () => {
    const now = ms('2026-11-23T23:30:00+04:00');
    const w = wlHostRunUpcoming(now, true);
    expect(w.eventDate).toBe('2026-11-30');
    expect(w.entryOpensAtMs).toBe(now);
    expect(w.entryClosesAtMs).toBe(ms('2026-12-07T00:00:00+04:00'));
  });

  it('airs at 22:00 Georgian time on the event Monday', () => {
    expect(wlHostRunShowAt('2026-11-30')).toBe('2026-11-30T18:00:00.000Z');
  });
});
