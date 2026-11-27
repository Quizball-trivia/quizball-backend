import { describe, expect, it } from 'vitest';
import '../setup.js';

const { windows, traction, periodStart, reportView, REPORT_AGENTS } = await import('../../src/modules/harness/harness.reports.js');
const { createReportBodySchema, EDITABLE_POLICIES } = await import('../../src/modules/harness/harness.schemas.js');

// Oldest first, ending today (27 Nov): the last row is the unfinished day.
const series = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    date: new Date(Date.UTC(2026, 10, 27 - (n - 1 - i))).toISOString().slice(0, 10),
    newUsers: i >= n - 8 ? 20 : 10,
    activePlayers: i >= n - 8 ? 300 : 200,
    matches: i >= n - 8 ? 150 : 100,
  }));
const analytics = (n = 90) =>
  ({
    generatedAt: '2026-11-27T06:00:00Z', days: n, series: series(n),
    actives: { dau: 213, wau: 10616, mau: 40934 }, totals: { registeredUsers: 25167 },
    modes: [{ mode: 'ranked', matches: 9000, share: 0.4 }, { mode: 'daily', matches: 6000, share: 0.27 }],
    modesByDay: [], modeLabels: { ranked: 'Ranked', daily: 'Daily games' },
    countries: Array.from({ length: 12 }, (_, i) => ({ country: `C${i}`, players: 1000 - i, registered: 500 - i })),
    countriesTotalPlayers: 11000, countriesTotalRegistered: 5000,
    retention: Array.from({ length: 16 }, (_, i) => ({ cohortStart: `2026-11-${String(23 - i).padStart(2, '0')}`, size: 2000, d1: 0.14, d7: i > 2 ? 0.16 : null, d30: null })),
  }) as never;
const games = {
  generatedAt: '2026-11-27T06:00:00Z',
  games: [
    { key: 'ranked', name: 'Ranked match', group: 'match', what: '', state: 'on', route: null, preview: null, stats: { started: null, finished: null, played: { now: 9450, before: 10800 } } },
    { key: 'pistas', name: 'Football Clues', group: 'daily', what: '', state: 'on', route: null, preview: null, stats: { started: { now: 956, before: 1103 }, finished: { now: 278, before: 295 }, played: null } },
    { key: 'old', name: 'Road to Goal', group: 'solo', what: '', state: 'retired', route: null, preview: null, stats: { started: null, finished: null, played: { now: 0, before: 3 } } },
  ],
} as never;

describe('reports', () => {
  it('compares two windows of whole days and leaves today out', () => {
    const w = windows(series(90), 7)!;
    expect(w.now).toEqual({ from: '2026-11-20', to: '2026-11-26', newPlayers: 140, gamesPlayed: 1050, averagePlayersPerDay: 300 });
    expect(w.before).toEqual({ from: '2026-11-13', to: '2026-11-19', newPlayers: 70, gamesPlayed: 700, averagePlayersPerDay: 200 });
    expect(windows(series(90), 30)!.now.from).toBe('2026-10-28');
    // Not enough whole days for two windows: nothing, rather than a lopsided comparison.
    expect(windows(series(14), 7)).toBeNull();
    expect(windows(series(15), 7)).not.toBeNull();
  });

  it('hands an agent only numbers that exist, cut to what fits', () => {
    const t = traction(analytics());
    expect(t).toMatchObject({ registeredPlayers: 25167, activeLast7Days: 10616, activeLast30Days: 40934 });
    expect(t.topCountries).toHaveLength(8);
    expect(t.retentionByJoinWeek).toHaveLength(8);
    expect(t.retentionByJoinWeek[0]).toEqual({ joinedWeekOf: '2026-11-23', players: 2000, nextDay: 0.14, week2: null, month2: null });
  });

  it('gives each agent its department, its schedule and its input', () => {
    expect(REPORT_AGENTS.map((a) => [a.slug, a.department, a.every])).toEqual([
      ['growth-analyst', 'marketing', 'week'],
      ['investor-update-writer', 'investors', 'month'],
      ['investor-scout', 'investors', 'month'],
    ]);
    const s = { today: '2026-11-27', profile: 'QuizBall is a football trivia game.', analytics: analytics(), games };
    const growth = REPORT_AGENTS[0]!.input(s) as Record<string, any>;
    expect(growth.company).toBe('QuizBall is a football trivia game.');
    expect(growth.daily).toHaveLength(30);
    expect(growth.daily.at(-1).date).toBe('2026-11-26');
    expect(growth.last7DaysAgainstThe7Before.now.newPlayers).toBe(140);
    // Only games players can play; a daily game by players, the others by games played.
    expect(growth.games).toEqual([
      { name: 'Ranked match', kind: 'match', played: { now: 9450, before: 10800 } },
      { name: 'Football Clues', kind: 'daily', playersStarted: { now: 956, before: 1103 }, playersFinished: { now: 278, before: 295 } },
    ]);
    expect(growth.shareOfGamesByMode[0]).toEqual({ mode: 'Ranked', share: 0.4 });
    expect(REPORT_AGENTS[0]!.title('2026-11-27')).toBe('Growth read, week to 2026-11-27');
    expect(REPORT_AGENTS[1]!.title('2026-11-27')).toBe('Investor update draft, November 2026');
    const update = REPORT_AGENTS[1]!.input(s) as Record<string, any>;
    expect(update.gamesLive).toBe(2);
    expect(update.daily).toBeUndefined();
    const scout = REPORT_AGENTS[2]!.input(s) as Record<string, any>;
    expect(Object.keys(scout).sort()).toEqual(['activeLast30Days', 'activeLast7Days', 'company', 'note', 'registeredPlayers', 'retentionByJoinWeek', 'today', 'topCountries']);
  });

  it('knows when a week (from Monday) and a month begin', () => {
    expect(periodStart('2026-11-27', 'week')).toBe('2026-11-23');
    expect(periodStart('2026-11-23', 'week')).toBe('2026-11-23');
    expect(periodStart('2026-11-29', 'week')).toBe('2026-11-23');
    expect(periodStart('2026-12-01', 'week')).toBe('2026-11-30');
    expect(periodStart('2026-11-27', 'month')).toBe('2026-11-01');
    expect(periodStart('2027-01-01', 'week')).toBe('2026-12-28');
  });

  it('shows a report with its agent named and its dates as text', () => {
    const row = { id: 'r1', number: 3, agent_slug: 'growth-analyst', agent_name: 'Growth Analyst', department: 'marketing', title: 'Growth read', status: 'ready', body: { summary: 's', sections: [], leads: [], questions: [] }, requested_by: 'schedule', error: null, created_at: new Date('2026-11-27T08:00:00Z'), updated_at: '2026-11-27T08:05:00Z' } as never;
    expect(reportView(row)).toMatchObject({ number: 3, agent: 'growth-analyst', agentName: 'Growth Analyst', department: 'marketing', status: 'ready', requestedBy: 'schedule', createdAt: '2026-11-27T08:00:00.000Z' });
    expect(reportView({ ...(row as object), agent_name: null } as never).agentName).toBe('growth-analyst');
  });

  it('takes an agent slug, and a company profile of a sensible length', () => {
    expect(createReportBodySchema.safeParse({ agent: 'growth-analyst' }).success).toBe(true);
    expect(createReportBodySchema.safeParse({ agent: 'Growth Analyst' }).success).toBe(false);
    expect(createReportBodySchema.safeParse({}).success).toBe(false);
    const profile = EDITABLE_POLICIES['company.profile'];
    expect(profile.safeParse('QuizBall is a football trivia game on the web.').success).toBe(true);
    expect(profile.safeParse('too short').success).toBe(false);
    expect(profile.safeParse('x'.repeat(4001)).success).toBe(false);
  });
});
