import { describe, expect, it, vi } from 'vitest';
import '../setup.js';

vi.mock('../../src/modules/hq/hq.repo.js', () => ({ hqRepo: {} }));
const { buildPulse } = await import('../../src/modules/hq/hq.service.js');
const { buildAnalytics } = await import('../../src/modules/hq/hq.analytics.service.js');

// Table Derby's counts (partner_daily_stats) inside HQ's figures.
const td = {
  day: '2026-11-02', updatedAt: '2026-11-02T07:30:00.000Z', totalUsers: 500, newUsers: 3, dau: 40, wau: 90, mau: 200,
  matches: 70,
  days: [
    { day: '2026-11-01', newUsers: 6, activeUsers: 50, matches: 80 },
    { day: '2026-11-02', newUsers: 3, activeUsers: 40, matches: 70 },
  ],
};

describe('HQ with Table Derby', () => {
  it('pulse adds its new and active players per day and its players to the totals', () => {
    const row = {
      metrics: {
        generated_at: '2026-11-02T08:00:00+00:00', timezone: 'Asia/Tbilisi', days: 3, total_registered_users: 1234,
        new_users_by_day: { '2026-11-02': 5, '2026-11-01': 10 }, matches_by_day: {},
        active_players_by_day: { '2026-11-01': 7 },
      },
      feedback: {},
    };
    const p = buildPulse(row as never, 3, new Date('2026-11-02T08:00:00Z'), td);
    expect(p.series.map((d) => [d.date, d.newUsers, d.activePlayers])).toEqual([
      ['2026-10-31', 0, 0], ['2026-11-01', 16, 57], ['2026-11-02', 8, 40],
    ]);
    expect(p.totals).toEqual({ registeredUsers: 1234, tableDerbyUsers: 500, usersInclPartners: 1734 });
    expect(p.tableDerby).toEqual({ day: '2026-11-02', updatedAt: '2026-11-02T07:30:00.000Z' });
    expect(buildPulse(row as never, 3, new Date('2026-11-02T08:00:00Z')).tableDerby).toBeNull();
  });

  it('analytics adds it to actives, series and totals', () => {
    const snapshot = {
      generated_at: '2026-11-02T08:00:00+00:00', total_registered_users: 120,
      series: [
        { date: '2026-11-01', new_users: 1, active_players: 4, active_all: 8 },
        { date: '2026-11-02', new_users: 2, active_players: 5, active_all: 11 },
      ],
      actives: { dau: 5, wau: 9, mau: 20 }, actives_all: { dau: 11, wau: 30, mau: 70 }, countries: [],
    };
    const a = buildAnalytics({ days: 2, snapshot: snapshot as never, games: [], retention: [], partner: td });
    expect(a.actives).toEqual({ dau: 51, wau: 120, mau: 270 });
    expect(a.series.map((d) => [d.date, d.newUsers, d.activePlayers])).toEqual([
      ['2026-11-01', 7, 58], ['2026-11-02', 5, 51],
    ]);
    expect(a.totals).toEqual({ registeredUsers: 120, tableDerbyUsers: 500, usersInclPartners: 620 });
  });
});
