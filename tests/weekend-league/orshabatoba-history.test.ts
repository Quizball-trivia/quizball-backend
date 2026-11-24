import { describe, expect, it } from 'vitest';
import { orshabatobaEpisode, orshabatobaEpisodeDate, orshabatobaNextDate } from '../../src/modules/weekend-league/orshabatoba-history.js';

const ms = (iso: string) => Date.parse(iso);

describe('orshabatobaNextDate', () => {
  it('is tonight on a Monday before the show has finished', () => {
    expect(orshabatobaNextDate(ms('2026-11-30T12:00:00+04:00'), new Set(['2026-11-23']))).toBe('2026-11-30');
  });

  it('moves to next Monday once tonight\'s show has finished', () => {
    expect(orshabatobaNextDate(ms('2026-11-23T23:30:00+04:00'), new Set(['2026-11-23']))).toBe('2026-11-30');
  });

  it('is the coming Monday from Tuesday to Sunday', () => {
    expect(orshabatobaNextDate(ms('2026-11-24T10:00:00+04:00'), new Set(['2026-11-23']))).toBe('2026-11-30');
    expect(orshabatobaNextDate(ms('2026-11-29T23:59:00+04:00'), new Set())).toBe('2026-11-30');
  });

  it('uses Georgian days (Sunday 21:00 UTC is Monday in Tbilisi)', () => {
    expect(orshabatobaNextDate(ms('2026-11-29T21:00:00Z'), new Set())).toBe('2026-11-30');
  });
});

describe('orshabatobaEpisode', () => {
  it('numbers Mondays from 301 on 2026-11-23, one per week, both ways', () => {
    expect(orshabatobaEpisode('2026-11-23')).toBe(301);
    expect(orshabatobaEpisode('2026-11-30')).toBe(302);
    expect(orshabatobaEpisode('2027-01-04')).toBe(307);
    expect(orshabatobaEpisodeDate(307)).toBe('2027-01-04');
  });

  it('treats a cancelled Monday like a finished one', () => {
    expect(orshabatobaNextDate(ms('2026-11-30T12:00:00+04:00'), new Set(['2026-11-30']))).toBe('2026-12-07');
  });
});
