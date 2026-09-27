import { describe, expect, it } from 'vitest';
import { LAST_DAY, LAUNCH_DAY, addDays, boardDay, dayEndsAt, isArchiveDay, isPlayableDay, puzzleDayFor, rankedDay, releaseDay } from '../../src/modules/buscaminas/buscaminas.days.js';

describe('buscaminas release calendar', () => {
  it('rolls over at Buenos Aires midnight', () => {
    expect(releaseDay(new Date('2026-09-28T02:00:00Z'))).toBe('2026-09-27');
    expect(releaseDay(new Date('2026-09-28T03:30:00Z'))).toBe('2026-09-28');
  });

  it('clamps before launch to the first puzzle and after the 30th to the last', () => {
    expect(LAUNCH_DAY).toBe('2026-09-26');
    expect(LAST_DAY).toBe('2026-12-24');
    expect(puzzleDayFor('2026-09-25')).toBe('2026-09-26');
    expect(puzzleDayFor('2026-09-26')).toBe('2026-09-26');
    expect(puzzleDayFor('2026-10-10')).toBe('2026-10-10');
    expect(puzzleDayFor('2026-12-24')).toBe('2026-12-24');
    expect(puzzleDayFor('2026-12-25')).toBe('2026-12-24');
    expect(puzzleDayFor('2027-01-01')).toBe('2026-12-24');
  });

  it('ranks only launch … last published day; before launch the launch puzzle is a preview', () => {
    const preLaunch = new Date('2026-09-25T12:00:00Z');
    expect(rankedDay(preLaunch)).toBeNull();
    expect(boardDay(preLaunch)).toBe('2026-09-26');
    expect(isPlayableDay('2026-09-26', preLaunch)).toBe(true);
    expect(isPlayableDay('2026-09-27', preLaunch)).toBe(false);
    expect(isPlayableDay('2026-09-25', preLaunch)).toBe(false);

    expect(rankedDay(new Date('2026-09-26T12:00:00Z'))).toBe('2026-09-26');
    expect(rankedDay(new Date('2026-09-28T02:59:59Z'))).toBe('2026-09-27');
    const oct5 = new Date('2026-10-05T15:00:00Z');
    expect(rankedDay(oct5)).toBe('2026-10-05');
    expect(isPlayableDay('2026-09-30', oct5)).toBe(true);
    expect(isPlayableDay('2026-10-06', oct5)).toBe(false);

    expect(rankedDay(new Date('2026-12-24T15:00:00Z'))).toBe('2026-12-24');
    const after = new Date('2026-12-25T15:00:00Z');
    expect(rankedDay(after)).toBeNull();
    expect(boardDay(after)).toBe('2026-12-24');
    expect(isPlayableDay('2026-12-24', after)).toBe(true);
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
