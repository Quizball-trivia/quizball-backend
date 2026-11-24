import { describe, expect, it } from 'vitest';
import { orshabatobaNextDate } from '../../src/modules/weekend-league/orshabatoba-history.js';

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
