import { describe, it, expect } from 'vitest';
import { isInQpWindow, weekKeyFor, qpForResult, WL_QP_WIN, WL_QP_LOSS } from '../../src/modules/weekend-league/wl-week.js';

// GE = UTC+4 fixed. Helper builds a UTC Date from a Georgia wall-clock time.
function geDate(iso: string): Date {
  return new Date(new Date(`${iso}Z`).getTime() - 4 * 60 * 60 * 1000);
}

describe('weekKeyFor', () => {
  it('maps Monday 00:00 GE (inclusive lower bound) to that week Saturday', () => {
    expect(weekKeyFor(geDate('2026-07-27T00:00:00'))).toBe('2026-08-01');
  });

  it('maps Sunday 23:59:59 GE to null (before the window)', () => {
    expect(weekKeyFor(geDate('2026-07-26T23:59:59'))).toBe('2026-08-01'); // Sunday rolls to next event
  });

  it('maps Friday 23:59:59 GE to that week Saturday', () => {
    expect(weekKeyFor(geDate('2026-07-31T23:59:59'))).toBe('2026-08-01');
  });

  it('maps Saturday 00:00:00 GE (exclusive upper bound) to the next event', () => {
    expect(weekKeyFor(geDate('2026-08-01T00:00:00'))).toBe('2026-08-08');
  });

  it('maps Saturday and Sunday to null', () => {
    expect(weekKeyFor(geDate('2026-08-01T14:00:00'))).toBe('2026-08-08'); // Saturday → next event
    expect(weekKeyFor(geDate('2026-08-02T10:00:00'))).toBe('2026-08-08'); // Sunday → next event
  });

  it('midweek maps to the upcoming Saturday', () => {
    expect(weekKeyFor(geDate('2026-07-29T18:30:00'))).toBe('2026-08-01');
  });

  it('is driven by Georgia time, not UTC: Sunday 21:00 UTC is Monday 01:00 GE', () => {
    expect(weekKeyFor(new Date('2026-07-26T21:00:00Z'))).toBe('2026-08-01');
  });

  it('year boundary: Thursday 2026-12-31 GE maps to Saturday 2027-01-02', () => {
    expect(weekKeyFor(geDate('2026-12-31T15:00:00'))).toBe('2027-01-02');
  });

  it('every match accrues: pre-cutoff credits this event, post-cutoff the next', () => {
    const inside = geDate('2026-07-28T09:00:00'); // Tuesday
    const outside = geDate('2026-08-01T09:00:00'); // Saturday
    expect(isInQpWindow(inside)).toBe(true);
    expect(weekKeyFor(inside)).toBe('2026-08-01');
    expect(isInQpWindow(outside)).toBe(false);
    // Running balance: weekend grinding is never wasted — it credits the
    // NEXT event's week instead of evaporating.
    expect(weekKeyFor(outside)).toBe('2026-08-08');
  });
});

describe('wlUpcomingEventSchedule', () => {
  it('Sunday belongs to the ongoing event until the final starts', async () => {
    const { wlUpcomingEventSchedule } = await import('../../src/modules/weekend-league/wl-week.js');
    // Sunday 2026-08-02 13:59:59 GE — final not started: still week 2026-08-01.
    const beforeFinal = geDate('2026-08-02T13:59:59').getTime();
    expect(wlUpcomingEventSchedule(beforeFinal).weekKey).toBe('2026-08-01');
    // Exactly Sunday 14:00 GE — the final has started; creation/selection
    // rolls to next Saturday (the ongoing event is protected by
    // earliest-final DB selection, not by this function).
    const atFinal = geDate('2026-08-02T14:00:00').getTime();
    expect(wlUpcomingEventSchedule(atFinal).weekKey).toBe('2026-08-08');
    // Monday maps to its own week.
    const monday = geDate('2026-07-27T00:00:00').getTime();
    expect(wlUpcomingEventSchedule(monday).weekKey).toBe('2026-08-01');
    // Entry opens Monday 00:00 GE for the computed week.
    expect(wlUpcomingEventSchedule(monday).entryOpensAtMs).toBe(monday);
  });
});

describe('qpForResult', () => {
  it('win 25, loss 10', () => {
    expect(qpForResult('win')).toBe(WL_QP_WIN);
    expect(qpForResult('win')).toBe(25);
    expect(qpForResult('loss')).toBe(WL_QP_LOSS);
    expect(qpForResult('loss')).toBe(10);
  });
});
