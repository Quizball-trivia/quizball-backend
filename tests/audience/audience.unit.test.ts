import { beforeEach, describe, expect, it, vi } from 'vitest';

const repo = vi.hoisted(() => ({ refreshDays: vi.fn(), incompleteDays: vi.fn() }));
vi.mock('../../src/modules/audience/audience.repo.js', () => ({ audienceRepo: repo }));
vi.mock('../../src/db/index.js', () => ({ sql: vi.fn() }));
const { periodRanges, georgiaToday, COVERAGE_START } = await import('../../src/modules/audience/audience.service.js');
const { runAudienceRefresh } = await import('../../src/modules/audience/audience.worker.js');

describe('audience periods', () => {
  it('uses Georgia dates: 19:59 UTC is still the same day, 20:00 UTC is the next', () => {
    expect(georgiaToday(new Date('2026-11-03T19:59:59Z'))).toBe('2026-11-03');
    expect(georgiaToday(new Date('2026-11-03T20:00:00Z'))).toBe('2026-11-04');
  });

  it('covers complete days ending yesterday, with an equal previous window', () => {
    expect(periodRanges('today', '2026-11-04')).toEqual({ current: { from: '2026-11-04', to: '2026-11-04' }, previous: null });
    expect(periodRanges('yesterday', '2026-11-04')).toEqual({
      current: { from: '2026-11-03', to: '2026-11-03' }, previous: { from: '2026-11-02', to: '2026-11-02' } });
    expect(periodRanges('7d', '2026-11-04')).toEqual({
      current: { from: '2026-10-28', to: '2026-11-03' }, previous: { from: '2026-10-21', to: '2026-10-27' } });
    expect(periodRanges('30d', '2026-11-04').current).toEqual({ from: '2026-10-05', to: '2026-11-03' });
  });
});

describe('audience refresh worker', () => {
  beforeEach(() => { repo.refreshDays.mockReset(); repo.incompleteDays.mockReset(); });

  it('refreshes today, then the newest days that are not final yet', async () => {
    repo.refreshDays.mockResolvedValue(10);
    repo.incompleteDays.mockResolvedValue(['2026-11-03', '2026-10-20']);
    await runAudienceRefresh(new Date('2026-11-04T08:00:00Z'));
    expect(repo.refreshDays.mock.calls).toEqual([
      ['2026-11-04', '2026-11-04', false], ['2026-11-03', '2026-11-03', false], ['2026-10-20', '2026-10-20', false],
    ]);
    expect(repo.incompleteDays).toHaveBeenCalledWith(COVERAGE_START, '2026-11-03', 6);
  });

  it('keeps going when today was just refreshed by another replica (-2)', async () => {
    repo.refreshDays.mockResolvedValueOnce(-2).mockResolvedValue(5);
    repo.incompleteDays.mockResolvedValue(['2026-11-03']);
    await runAudienceRefresh(new Date('2026-11-04T08:00:00Z'));
    expect(repo.refreshDays).toHaveBeenCalledTimes(2);
  });

  it('stops when another replica holds the refresh lock (-1)', async () => {
    repo.refreshDays.mockResolvedValue(-1);
    await runAudienceRefresh(new Date('2026-11-04T08:00:00Z'));
    expect(repo.refreshDays).toHaveBeenCalledTimes(1);
    expect(repo.incompleteDays).not.toHaveBeenCalled();
  });
});
