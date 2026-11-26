import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../setup.js';

const repo = vi.hoisted(() => ({
  totals: vi.fn(),
  actives: vi.fn(),
  dauSeries: vi.fn(),
  signupsPerDay: vi.fn(),
  gamesPerDay: vi.fn(),
  countries: vi.fn(),
  partnerDays: vi.fn(),
}));
vi.mock('../../src/modules/admin-stats/admin-stats.repo.js', () => ({ adminStatsRepo: repo }));

const { adminStatsService, addSeries, tableDerbyBreakdown } = await import('../../src/modules/admin-stats/admin-stats.service.js');
const { analyticsOverviewResponseSchema } = await import('../../src/modules/admin-stats/admin-stats.schemas.js');

const tbilisi = (at: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tbilisi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
const TODAY = tbilisi(new Date());
const dayBefore = (n: number) => {
  const d = new Date(`${TODAY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

const tdRow = (day: string, o: Partial<Record<string, number>> = {}) => ({
  day, total_users: 500, new_users: 4, active_users: 30, active_7d: 120, active_30d: 300, matches: 55,
  updated_at: '2026-11-27T08:30:00.000Z', ...o,
});

// The overview is cached for 5 minutes: each test moves the clock a few seconds past the previous one's cache.
let clock = Date.now();
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  clock += 5 * 60_000 + 1_000;
  vi.setSystemTime(clock);
  repo.totals.mockResolvedValue({ registered: 9000, playing_guests: 1000, total_users: 10_000, guests_played_30d: 0, guests_converted_30d: 0 });
  repo.actives.mockResolvedValue({ dau: 800, wau: 3000, mau: 9000 });
  repo.dauSeries.mockResolvedValue([{ day: dayBefore(1), count: 700 }, { day: TODAY, count: 800 }]);
  repo.signupsPerDay.mockResolvedValue([{ day: dayBefore(1), count: 50 }]);
  repo.gamesPerDay.mockResolvedValue([]);
  repo.countries.mockResolvedValue([]);
});

describe('analytics overview with Table Derby', () => {
  it('adds the latest Table Derby counts to total users and actives, with the parts in the breakdown', async () => {
    repo.partnerDays.mockResolvedValue([tdRow(TODAY), tdRow(dayBefore(1), { active_users: 40, new_users: 6, total_users: 496 })]);
    const value = await adminStatsService.analyticsOverview();

    expect(analyticsOverviewResponseSchema.parse(value)).toBeTruthy();
    expect(repo.partnerDays).toHaveBeenCalledWith('table-derby', 30);
    expect(value.totals).toMatchObject({ registered: 9000, playingGuests: 1000, totalUsers: 10_500 });
    expect(value.actives).toEqual({ dau: 830, wau: 3120, mau: 9300 });
    expect(value.dauSeries).toEqual([{ day: dayBefore(1), count: 740 }, { day: TODAY, count: 830 }]);
    expect(value.signupsPerDay).toEqual([{ day: dayBefore(1), count: 56 }, { day: TODAY, count: 4 }]);
    expect(value.breakdown.quizball).toEqual({ totalUsers: 10_000, dau: 800, wau: 3000, mau: 9000 });
    expect(value.breakdown.tableDerby).toMatchObject({
      day: TODAY, totalUsers: 500, newUsers: 4, dau: 30, wau: 120, mau: 300, matches: 55,
      updatedAt: '2026-11-27T08:30:00.000Z',
    });
  });

  it('keeps the last synced numbers when Table Derby has not synced today', async () => {
    repo.partnerDays.mockResolvedValue([tdRow(dayBefore(2))]);
    const value = await adminStatsService.analyticsOverview();
    expect(value.totals.totalUsers).toBe(10_500);
    expect(value.breakdown.tableDerby?.day).toBe(dayBefore(2));
  });

  it('shows Quizball alone before the first sync', async () => {
    repo.partnerDays.mockResolvedValue([]);
    const value = await adminStatsService.analyticsOverview();
    expect(value.totals.totalUsers).toBe(10_000);
    expect(value.actives).toEqual({ dau: 800, wau: 3000, mau: 9000 });
    expect(value.breakdown.tableDerby).toBeNull();
    expect(analyticsOverviewResponseSchema.parse(value)).toBeTruthy();
  });

  it('shows Quizball alone when the partner table cannot be read', async () => {
    repo.partnerDays.mockRejectedValue(new Error('relation "partner_daily_stats" does not exist'));
    const value = await adminStatsService.analyticsOverview();
    expect(value.totals.totalUsers).toBe(10_000);
    expect(value.breakdown.tableDerby).toBeNull();
  });
});

describe('series helpers', () => {
  it('adds two series by day, oldest first, keeping days only one side has', () => {
    expect(addSeries(
      [{ day: '2026-11-25', count: 1 }, { day: '2026-11-27', count: 3 }],
      [{ day: '2026-11-26', count: 10 }, { day: '2026-11-27', count: 20 }],
    )).toEqual([
      { day: '2026-11-25', count: 1 },
      { day: '2026-11-26', count: 10 },
      { day: '2026-11-27', count: 23 },
    ]);
  });

  it('puts only the days inside the window into the Table Derby series', () => {
    const td = tableDerbyBreakdown([tdRow('2026-11-27'), tdRow('2026-10-28'), tdRow('2026-10-27')], '2026-10-28');
    expect(td?.dauSeries.map((r) => r.day)).toEqual(['2026-10-28', '2026-11-27']);
  });
});
