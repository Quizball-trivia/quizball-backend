import { describe, expect, it } from 'vitest';
import { LAUNCH_DAY, addDays, assertUnbrokenCalendar, boardDay, boardsMaxAge, dayEndsAt, isArchiveDay, isPlayableDay, isReleasedDay, lastReleasedDay, puzzleDayFor, rankedDay, releaseDay } from '../../src/modules/buscaminas/buscaminas.days.js';

describe('buscaminas release calendar', () => {
  it('rolls over at Buenos Aires midnight', () => {
    expect(releaseDay(new Date('2026-09-28T02:00:00Z'))).toBe('2026-09-27');
    expect(releaseDay(new Date('2026-09-28T03:30:00Z'))).toBe('2026-09-28');
  });

  const LAST = '2026-12-24';

  it('clamps before launch to the first puzzle and after the last released day to that day', () => {
    expect(LAUNCH_DAY).toBe('2026-09-26');
    expect(puzzleDayFor('2026-09-25', LAST)).toBe('2026-09-26');
    expect(puzzleDayFor('2026-09-26', LAST)).toBe('2026-09-26');
    expect(puzzleDayFor('2026-10-10', LAST)).toBe('2026-10-10');
    expect(puzzleDayFor('2026-12-24', LAST)).toBe('2026-12-24');
    expect(puzzleDayFor('2026-12-25', LAST)).toBe('2026-12-24');
    expect(puzzleDayFor('2027-01-01', LAST)).toBe('2026-12-24');
  });

  it('the last released day is the end of the unbroken run of stored days from the first one', () => {
    const run = (n: number) => Array.from({ length: n }, (_, i) => addDays(LAUNCH_DAY, i));
    expect(lastReleasedDay([], LAUNCH_DAY)).toBeNull();
    expect(lastReleasedDay(['2026-09-27', '2026-09-28'], LAUNCH_DAY)).toBeNull();
    expect(lastReleasedDay(run(1), LAUNCH_DAY)).toBe('2026-09-26');
    expect(lastReleasedDay(run(90), LAUNCH_DAY)).toBe('2026-12-24');
    // One more stored day extends the calendar with no release.
    expect(lastReleasedDay(run(91), LAUNCH_DAY)).toBe('2026-12-25');
    // A hole ends it: the days stored beyond are not released.
    expect(lastReleasedDay([...run(10), '2026-10-07', '2026-10-08'], LAUNCH_DAY)).toBe('2026-10-05');
  });

  it('a board index is cached for minutes, but never past the midnight that adds a day to it', () => {
    // Buenos Aires midnight is 03:00 UTC.
    expect(boardsMaxAge(new Date('2026-10-05T15:00:00Z'))).toBe(300);
    expect(boardsMaxAge(new Date('2026-10-06T02:55:00Z'))).toBe(300);
    expect(boardsMaxAge(new Date('2026-10-06T02:58:30Z'))).toBe(90);
    expect(boardsMaxAge(new Date('2026-10-06T02:59:59.500Z'))).toBe(0);
    // The leaderboard's 15 s shared cache stops at midnight too.
    expect(boardsMaxAge(new Date('2026-10-05T15:00:00Z'), 15)).toBe(15);
    expect(boardsMaxAge(new Date('2026-10-06T02:59:58Z'), 15)).toBe(2);
    expect(boardsMaxAge(new Date('2026-10-06T03:00:00Z'))).toBe(300);
    expect(isReleasedDay('2026-10-05', '2026-10-05')).toBe(true);
    expect(isReleasedDay('2026-10-06', '2026-10-05')).toBe(false);
    expect(isReleasedDay('2026-10-05', null)).toBe(false);
  });

  it('a seed may extend the calendar but never leave a hole or start early', () => {
    const run = (n: number) => Array.from({ length: n }, (_, i) => addDays(LAUNCH_DAY, i));
    expect(() => assertUnbrokenCalendar(LAUNCH_DAY, [], run(90))).not.toThrow();
    expect(() => assertUnbrokenCalendar(LAUNCH_DAY, run(90), ['2026-12-25'])).not.toThrow();
    expect(() => assertUnbrokenCalendar(LAUNCH_DAY, run(90), ['2026-10-01'])).not.toThrow();
    expect(() => assertUnbrokenCalendar(LAUNCH_DAY, run(90), ['2026-12-26'])).toThrow(/2026-12-25 is missing/);
    expect(() => assertUnbrokenCalendar(LAUNCH_DAY, [], run(5).slice(1))).toThrow(/must start at 2026-09-26/);
    expect(() => assertUnbrokenCalendar(LAUNCH_DAY, run(3), ['2026-09-25'])).toThrow(/must start at 2026-09-26/);
    expect(() => assertUnbrokenCalendar(LAUNCH_DAY, [], [])).toThrow(/no days/);
  });

  it('ranks only launch … last published day; before launch the launch puzzle is a preview', () => {
    const preLaunch = new Date('2026-09-25T12:00:00Z');
    expect(rankedDay(LAST, preLaunch)).toBeNull();
    expect(boardDay(LAST, preLaunch)).toBe('2026-09-26');
    expect(isPlayableDay('2026-09-26', LAST, preLaunch)).toBe(true);
    expect(isPlayableDay('2026-09-27', LAST, preLaunch)).toBe(false);
    expect(isPlayableDay('2026-09-25', LAST, preLaunch)).toBe(false);

    expect(rankedDay(LAST, new Date('2026-09-26T12:00:00Z'))).toBe('2026-09-26');
    expect(rankedDay(LAST, new Date('2026-09-28T02:59:59Z'))).toBe('2026-09-27');
    const oct5 = new Date('2026-10-05T15:00:00Z');
    expect(rankedDay(LAST, oct5)).toBe('2026-10-05');
    expect(isPlayableDay('2026-09-30', LAST, oct5)).toBe(true);
    expect(isPlayableDay('2026-10-06', LAST, oct5)).toBe(false);

    expect(rankedDay(LAST, new Date('2026-12-24T15:00:00Z'))).toBe('2026-12-24');
    const after = new Date('2026-12-25T15:00:00Z');
    expect(rankedDay(LAST, after)).toBeNull();
    expect(boardDay(LAST, after)).toBe('2026-12-24');
    expect(isPlayableDay('2026-12-24', LAST, after)).toBe(true);
    // The same clock with one more stored day: that day is live and ranked, with no release.
    expect(rankedDay('2026-12-25', after)).toBe('2026-12-25');
    expect(isPlayableDay('2026-12-25', '2026-12-25', after)).toBe(true);
    // Nothing stored: nothing is playable or ranked.
    expect(rankedDay(null, oct5)).toBeNull();
    expect(isPlayableDay('2026-09-26', null, oct5)).toBe(false);
  });

  it('archive days are those already over in Buenos Aires', () => {
    const now = new Date('2026-10-05T02:00:00Z');
    expect(isArchiveDay('2026-10-03', now)).toBe(true);
    expect(isArchiveDay('2026-10-04', now)).toBe(false);
    expect(isArchiveDay('2026-09-26', new Date('2026-09-25T15:00:00Z'))).toBe(false);
  });

  it('each day ends at the next Buenos Aires midnight, exactly where releaseDay rolls over', () => {
    expect(dayEndsAt('2026-09-28').toISOString()).toBe('2026-09-29T03:00:00.000Z');
    expect(dayEndsAt('2026-12-31').toISOString()).toBe('2027-01-01T03:00:00.000Z');
    for (let i = 0; i < 90; i += 1) {
      const day = addDays(LAUNCH_DAY, i);
      const end = dayEndsAt(day).getTime();
      expect(releaseDay(new Date(end - 1))).toBe(day);
      expect(releaseDay(new Date(end))).toBe(addDays(day, 1));
    }
  });
});
