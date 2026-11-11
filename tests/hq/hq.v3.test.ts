import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../setup.js';

const repo = vi.hoisted(() => ({
  getMemberByUserId: vi.fn(),
  getTask: vi.fn(),
  transitionTask: vi.fn(),
  insertEvent: vi.fn(),
  listTasks: vi.fn(),
  createStandupTasks: vi.fn(),
  updateTask: vi.fn(),
  getMember: vi.fn(),
  getSchedule: vi.fn(),
  runScheduleNow: vi.fn(),
  listMembers: vi.fn(),
  listStandups: vi.fn(),
  listProposals: vi.fn(),
  listWorking: vi.fn(),
  listFinishedOn: vi.fn(),
  pulse: vi.fn(),
}));
const goalsRepo = vi.hoisted(() => ({
  listGoals: vi.fn(),
  goalExists: vi.fn(),
  getGoal: vi.fn(),
  insertGoal: vi.fn(),
  updateGoal: vi.fn(),
  deleteGoal: vi.fn(),
  newUsersBetween: vi.fn(),
  activeIdentitiesBetween: vi.fn(),
  retentionCohorts: vi.fn(),
  analyticsSnapshot: vi.fn(),
}));
const goalsAnalytics = vi.hoisted(() => ({ avgRatingBetween: vi.fn(), ratingSummary: vi.fn() }));
const stats = vi.hoisted(() => ({
  gamesPerDay: vi.fn(),
  gamesBetween: vi.fn(),
  activeIdentitiesBetween: vi.fn(),
  actives: vi.fn(),
  dauSeries: vi.fn(),
}));

vi.mock('../../src/modules/hq/hq.repo.js', () => ({ hqRepo: repo }));
vi.mock('../../src/modules/hq/hq.goals.repo.js', () => ({
  hqGoalsRepo: goalsRepo,
  hqGoalsAnalyticsRepo: goalsAnalytics,
  isUniqueViolation: (e: unknown) => (e as { code?: string })?.code === '23505',
}));
vi.mock('../../src/modules/admin-stats/admin-stats.repo.js', () => ({ adminStatsRepo: stats }));

const { hqService, proposalBody } = await import('../../src/modules/hq/hq.service.js');
const goals = await import('../../src/modules/hq/hq.goals.service.js');
const { assembleStandup, hqStandupService, kpisFromSeries } = await import('../../src/modules/hq/hq.standup.service.js');
const { buildAnalytics, MODE_LABELS, hqAnalyticsService, RETENTION_WEEKS, friendlyModeLabel } = await import('../../src/modules/hq/hq.analytics.service.js');
const posthog = await import('../../src/modules/hq/hq.posthog.js');
const { ConflictError, ValidationError, NotFoundError } = await import('../../src/core/errors.js');
const { StandupRequeueRefused } = await import('../../src/modules/hq/hq.errors.js');

const NOW = new Date('2026-11-04T08:00:00Z'); // Wednesday, 12:00 Tbilisi
const TODAY = '2026-11-04';
const USER = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const human = { id: 'h1', slug: 'u-1', kind: 'human', is_founder: true, name: 'Nika', avatar: '🧑', color: 'slate', runtime: 'none', status: 'active' };
const ref = (m: { id: string; slug: string; name: string; avatar: string; color: string; kind: string }) => ({
  id: m.id, slug: m.slug, name: m.name, avatar: m.avatar, color: m.color, kind: m.kind,
});

function goalRow(over: Record<string, unknown> = {}) {
  return {
    id: 'g1', horizon: 'week', title: 'Goal', description: '', metric: null, target: null, manual_progress: null,
    period_start: '2026-11-02', period_end: '2026-11-08', status: 'active', department: null, position: 1,
    created_by_id: null, created_at: NOW, updated_at: NOW, ...over,
  };
}

function member(over: Record<string, unknown>) {
  return {
    id: 'm', slug: 'm', kind: 'agent', user_id: null, name: 'M', title: 'Role', avatar: '🤖', color: 'slate',
    description: '', instructions: '', model: null, tools: [], autonomy: 'autonomous', runtime: 'hq',
    status: 'active', department: 'growth', max_turns: 25, last_active_at: null, created_at: NOW, updated_at: NOW,
    open_tasks: 0, runs_today: 0, cost_today_cents: 0, current_task: null, last_run: null, ...over,
  };
}

function taskRow(over: Record<string, unknown> = {}) {
  return {
    id: 't1', number: '5', title: 'Run a TikTok challenge', body: '', status: 'proposed', priority: 2,
    assignee_id: 'a1', created_by_id: 'a1', parent_id: null, depth: 0, schedule_id: null, result: null, position: 1,
    attempts: 0, claimed_by: null, claimed_at: null, claim_token: null, kind: 'proposal', goal_id: null,
    proposal: { why: 'reach', plan: 'post daily', expectedImpact: '+500 players', effort: 's' },
    due_at: null, completed_at: null, created_at: NOW, updated_at: NOW,
    assignee: { id: 'a1', slug: 'social', name: 'Social', avatar: '📱', color: 'sky', kind: 'agent' },
    created_by: null, assignee_runtime: 'hq', assignee_status: 'active', assignee_department: 'growth',
    message_count: 0, ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  goals.progressCache.clear();
  repo.getMemberByUserId.mockResolvedValue(human);
  repo.transitionTask.mockResolvedValue(true);
  repo.insertEvent.mockResolvedValue(undefined);
});

// ── goals ───────────────────────────────────────────────────────────────────
describe('goal dates', () => {
  it('defaults periods per horizon (Tbilisi dates)', () => {
    expect(goals.defaultPeriod('day', TODAY)).toEqual({ start: TODAY, end: TODAY });
    expect(goals.defaultPeriod('week', TODAY)).toEqual({ start: '2026-11-02', end: '2026-11-08' });
    expect(goals.defaultPeriod('week', '2026-11-08')).toEqual({ start: '2026-11-02', end: '2026-11-08' }); // Sunday
    expect(goals.defaultPeriod('north_star', TODAY)).toEqual({ start: TODAY, end: '2027-02-02' });
  });

  it('computes clamped percentages', () => {
    expect(goals.progressPct(2500, 10000)).toBe(25);
    expect(goals.progressPct(15000, 10000)).toBe(100);
    expect(goals.progressPct(null, 100)).toBeNull();
    expect(goals.progressPct(5, null)).toBeNull();
  });
});

describe('goal progress', () => {
  it('manual goals report manual progress', async () => {
    const [g] = await goals.withProgress([goalRow({ manual_progress: 40 }) as never], NOW);
    expect(g.progress).toEqual({ current: null, pct: 40 });
  });

  it('future goals have not started', async () => {
    const [g] = await goals.withProgress(
      [goalRow({ metric: 'new_users', target: '100', period_start: '2026-11-10', period_end: '2026-11-16' }) as never],
      NOW
    );
    expect(g.progress).toEqual({ current: null, pct: 0 });
    expect(goalsRepo.newUsersBetween).not.toHaveBeenCalled();
  });

  it('measures each metric over the period capped at today', async () => {
    goalsRepo.newUsersBetween.mockResolvedValue(30);
    goalsRepo.activeIdentitiesBetween.mockResolvedValue(2500);
    stats.gamesBetween.mockResolvedValue(15);
    goalsRepo.retentionCohorts.mockResolvedValue([
      { cohort_start: '2026-10-05', size: 10, d1: 0.5, d7: '0.2', d30: null },
      { cohort_start: '2026-10-12', size: 10, d1: 0.4, d7: '0.256', d30: null },
      { cohort_start: '2026-10-19', size: 10, d1: 0.4, d7: null, d30: null },
    ]);
    goalsAnalytics.avgRatingBetween.mockResolvedValue(4.2);
    const rows = [
      goalRow({ id: 'a', metric: 'new_users', target: '60' }),
      goalRow({ id: 'b', horizon: 'north_star', metric: 'active_players', target: '10000', period_start: '2026-11-03', period_end: '2027-02-01' }),
      goalRow({ id: 'c', metric: 'matches', target: '30' }),
      goalRow({ id: 'd', metric: 'd7_retention', target: '30' }),
      goalRow({ id: 'e', metric: 'avg_rating', target: '4.5' }),
    ];
    const out = await goals.withProgress(rows as never, NOW);
    expect(goalsRepo.newUsersBetween).toHaveBeenCalledWith('2026-11-02', TODAY);
    expect(out[0].progress).toEqual({ current: 30, pct: 50 });
    // weekly active = last 7 days ending today, but not before the period start
    expect(goalsRepo.activeIdentitiesBetween).toHaveBeenCalledWith('2026-11-03', TODAY);
    expect(out[1].progress).toEqual({ current: 2500, pct: 25 });
    expect(out[2].progress).toEqual({ current: 15, pct: 50 });
    expect(stats.gamesBetween).toHaveBeenCalledWith('2026-11-02', TODAY);
    expect(stats.gamesPerDay).not.toHaveBeenCalled();
    expect(out[3].progress).toEqual({ current: 25.6, pct: 85 }); // latest elapsed cohort, as a %
    expect(out[4].progress).toEqual({ current: 4.2, pct: 93 });
    expect(out[1].target).toBe(10000);
  });

  it('tolerates a failing source (progress unknown, not a 500)', async () => {
    goalsRepo.newUsersBetween.mockRejectedValue(new Error('db down'));
    const [g] = await goals.withProgress([goalRow({ metric: 'new_users', target: '10' }) as never], NOW);
    expect(g.progress).toEqual({ current: null, pct: null });
  });
});

describe('goals CRUD', () => {
  it('creates with horizon defaults and logs the event in the same insert', async () => {
    goalsRepo.insertGoal.mockResolvedValue('g9');
    goalsRepo.getGoal.mockResolvedValue(goalRow({ id: 'g9', horizon: 'day', period_start: TODAY, period_end: TODAY }));
    const g = await goals.hqGoalsService.create({ horizon: 'day', title: 'Fix login' }, USER, NOW);
    const args = goalsRepo.insertGoal.mock.calls[0][0];
    expect(args).toMatchObject({ horizon: 'day', periodStart: TODAY, periodEnd: TODAY, metric: null, target: null, createdById: 'h1' });
    expect(args.event('g9')).toMatchObject({ type: 'goal_created' });
    expect(g.id).toBe('g9');
  });

  it('derives the default end from a supplied future start (week and north star)', async () => {
    goalsRepo.insertGoal.mockReset().mockResolvedValue('g10');
    goalsRepo.getGoal.mockResolvedValue(goalRow({ id: 'g10' }));
    // NOW is in the week of 2026-11-02 (Mon); next Monday is 2026-11-09.
    await goals.hqGoalsService.create({ horizon: 'week', title: 'Next week', periodStart: '2026-11-09' }, USER, NOW);
    expect(goalsRepo.insertGoal.mock.calls[0][0]).toMatchObject({ periodStart: '2026-11-09', periodEnd: '2026-11-15' });
    await goals.hqGoalsService.create({ horizon: 'north_star', title: 'Later', periodStart: '2027-03-01' }, USER, NOW);
    expect(goalsRepo.insertGoal.mock.calls[1][0]).toMatchObject({ periodStart: '2027-03-01', periodEnd: '2027-05-30' });
  });

  it('409s on a second active North Star', async () => {
    goalsRepo.insertGoal.mockRejectedValue(Object.assign(new Error('dup'), { code: '23505' }));
    await expect(
      goals.hqGoalsService.create({ horizon: 'north_star', title: 'x', metric: 'new_users', target: 5 }, USER, NOW)
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('validates period order and metric targets', async () => {
    await expect(
      goals.hqGoalsService.create({ horizon: 'week', title: 'x', periodStart: '2026-11-08', periodEnd: '2026-11-02' }, USER, NOW)
    ).rejects.toBeInstanceOf(ValidationError);
    goalsRepo.getGoal.mockResolvedValue(goalRow());
    await expect(goals.hqGoalsService.update('g1', { metric: 'matches' }, USER, NOW)).rejects.toThrow(/needs a target/);
  });

  it('switching to manual clears the target; status changes are logged', async () => {
    goalsRepo.getGoal.mockResolvedValue(goalRow({ metric: 'new_users', target: '10' }));
    goalsRepo.updateGoal.mockResolvedValue(true);
    await goals.hqGoalsService.update('g1', { metric: null, manualProgress: 20, status: 'achieved' }, USER, NOW);
    expect(goalsRepo.updateGoal.mock.calls[0][1]).toMatchObject({ metric: null, target: null, manual_progress: 20, status: 'achieved' });
    expect(repo.insertEvent).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('achieved') }));
  });

  it('404s deleting a missing goal', async () => {
    goalsRepo.getGoal.mockResolvedValue(undefined);
    await expect(goals.hqGoalsService.remove('nope', USER)).rejects.toBeInstanceOf(NotFoundError);
  });
});

// ── proposals ───────────────────────────────────────────────────────────────
describe('proposals', () => {
  it('accept: proposed → todo in one guarded transaction, merging edits', async () => {
    repo.getTask.mockResolvedValueOnce(taskRow());
    repo.getTask.mockResolvedValueOnce(taskRow({ status: 'todo', title: 'Run a TikTok challenge (week 1)' }));
    const t = await hqService.acceptProposal('t1', { title: 'Run a TikTok challenge (week 1)', proposal: { effort: 'm' } }, USER);
    expect(t.status).toBe('todo');
    expect(t.kind).toBe('proposal');
    const [, patch, guard, extras] = repo.transitionTask.mock.calls[0];
    expect(patch).toMatchObject({ status: 'todo', title: 'Run a TikTok challenge (week 1)', attempts: 0, claim_token: null });
    expect(guard).toEqual({ statuses: ['proposed'], assigneeId: 'a1' });
    expect(extras.event).toMatchObject({ type: 'proposal_accepted', data: { edited: true } });
    expect(JSON.stringify(patch.proposal)).toContain('"effort":"m"');
    expect(JSON.stringify(patch.proposal)).toContain('"why":"reach"');
  });

  it('accept: 409 unless proposed, 409 on a lost race, 409 on a title collision', async () => {
    repo.getTask.mockResolvedValueOnce(taskRow({ status: 'todo' }));
    await expect(hqService.acceptProposal('t1', {}, USER)).rejects.toBeInstanceOf(ConflictError);
    repo.getTask.mockResolvedValueOnce(taskRow());
    repo.transitionTask.mockResolvedValueOnce(false);
    await expect(hqService.acceptProposal('t1', {}, USER)).rejects.toBeInstanceOf(ConflictError);
    repo.getTask.mockResolvedValueOnce(taskRow());
    repo.transitionTask.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }));
    await expect(hqService.acceptProposal('t1', { title: 'Other' }, USER)).rejects.toThrow('Another open idea from this agent has the same title');
  });

  it('decline: proposed → cancelled with the note addressed to the assignee', async () => {
    repo.getTask.mockResolvedValueOnce(taskRow());
    repo.getTask.mockResolvedValueOnce(taskRow({ status: 'cancelled' }));
    await hqService.declineProposal('t1', { note: 'Not before the season starts' }, USER);
    const [, patch, guard, extras] = repo.transitionTask.mock.calls[0];
    expect(patch.status).toBe('cancelled');
    expect(patch.completed_at).toBeInstanceOf(Date);
    expect(guard.statuses).toEqual(['proposed']);
    expect(extras.message).toMatchObject({ recipientId: 'a1', authorId: 'h1', body: 'Not before the season starts' });
    expect(extras.event.type).toBe('proposal_declined');
  });

  it('decline without a note writes no message', async () => {
    repo.getTask.mockResolvedValueOnce(taskRow());
    repo.getTask.mockResolvedValueOnce(taskRow({ status: 'cancelled' }));
    await hqService.declineProposal('t1', {}, USER);
    expect(repo.transitionTask.mock.calls[0][3].message).toBeUndefined();
  });

  it('task lists hide standup reports by default', async () => {
    repo.listTasks.mockResolvedValue([]);
    await hqService.listTasks({ limit: 10 });
    expect(repo.listTasks.mock.calls[0][0].kinds).toEqual(['task', 'proposal']);
    await hqService.listTasks({ limit: 10, kind: ['standup'] });
    expect(repo.listTasks.mock.calls[1][0].kinds).toEqual(['standup']);
  });
});

// ── standup ─────────────────────────────────────────────────────────────────
describe('assembleStandup', () => {
  const kpis = {
    newUsers: { today: 3, yesterday: 5 }, activePlayers: { today: 40, yesterday: 50 }, matches: { today: 9, yesterday: 12 },
    rating: { current: 4.1, previous: 3.9, lowRatings7d: 2 },
  };
  const ops = member({ id: 'ops', slug: 'ops-reporter', name: 'Ops Reporter', department: 'leadership' });
  const social = member({ id: 'a1', slug: 'social', name: 'Social', department: 'growth' });
  const growth = member({ id: 'gw', slug: 'growth-writer', name: 'Growth Writer', department: 'growth' });
  const paused = member({ id: 'p', slug: 'paused', name: 'Paused', department: 'engineering', status: 'paused' });
  const bugfixer = member({ id: 'b', slug: 'bug-fixer', name: 'Bug Fixer', runtime: 'bug_triage', department: 'engineering' });

  const g = (over: Record<string, unknown>) => ({
    ...goals.toGoal(goalRow(over) as never, { current: null, pct: null }),
  });

  it('orders agents by department then name, splits reported vs waiting, groups proposals', () => {
    const out = assembleStandup({
      date: TODAY,
      goals: [
        g({ id: 'ns', horizon: 'north_star', period_start: '2026-11-01', period_end: '2027-01-30' }),
        g({ id: 'w1', horizon: 'week' }),
        g({ id: 'w-next', horizon: 'week', period_start: '2026-11-09', period_end: '2026-11-15' }),
        g({ id: 'd1', horizon: 'day', period_start: TODAY, period_end: TODAY }),
        g({ id: 'd-old', horizon: 'day', period_start: '2026-11-03', period_end: '2026-11-03' }),
      ],
      members: [growth, ops, social, paused, bugfixer, member({ id: 'h', kind: 'human', runtime: 'none' })] as never,
      standups: [
        { id: 's1', member_id: 'a1', standup_date: TODAY, headline: 'Ready to launch', yesterday: 'Drafted', today: 'Post', blockers: '', task_id: null, run_id: null, created_at: NOW, updated_at: NOW },
        { id: 's2', member_id: 'p', standup_date: TODAY, headline: 'Paused later', yesterday: '', today: '', blockers: 'Need API key', task_id: null, run_id: null, created_at: NOW, updated_at: NOW },
      ],
      proposals: [taskRow(), taskRow({ id: 't2', title: 'Ask ops', assignee_id: 'ops', created_by_id: 'a1', assignee: ref(ops as never) })] as never,
      working: [{ assignee_id: 'gw', id: 'w', number: '7', title: 'Push copy' }],
      finishedYesterday: [taskRow({ id: 'f1', status: 'done', kind: 'task', assignee_id: 'gw' })] as never,
      kpis,
    });
    expect(out.entries.map((e) => e.member.slug)).toEqual(['ops-reporter', 'growth-writer', 'social', 'paused']);
    expect(out.waitingOn.map((m) => m.slug)).toEqual(['ops-reporter', 'growth-writer']);
    const socialEntry = out.entries.find((e) => e.member.slug === 'social')!;
    expect(socialEntry.standup).toMatchObject({ headline: 'Ready to launch', blockers: '' });
    expect(socialEntry.member).toMatchObject({ title: 'Role', department: 'growth' });
    // proposals by or for the member
    expect(socialEntry.proposals.map((p) => p.id)).toEqual(['t1', 't2']);
    expect(out.entries.find((e) => e.member.slug === 'ops-reporter')!.proposals.map((p) => p.id)).toEqual(['t2']);
    const gw = out.entries.find((e) => e.member.slug === 'growth-writer')!;
    expect(gw.working).toEqual({ id: 'w', number: 7, title: 'Push copy' });
    expect(gw.finishedYesterday.map((t) => t.id)).toEqual(['f1']);
    expect(gw.standup).toBeNull();
    expect(out.proposals).toHaveLength(2);
    expect(out.goals.northStar?.id).toBe('ns');
    expect(out.goals.week.map((x) => x.id)).toEqual(['w1']);
    expect(out.goals.day.map((x) => x.id)).toEqual(['d1']);
    expect(out.kpis).toBe(kpis);
  });

  it('run() creates missing standup tasks idempotently and only logs when it did something', async () => {
    repo.createStandupTasks.mockResolvedValueOnce(4).mockResolvedValueOnce(0);
    expect(await hqStandupService.run(USER, NOW)).toEqual({ created: 4 });
    expect(repo.createStandupTasks).toHaveBeenCalledWith(TODAY, 'h1');
    expect(repo.insertEvent).toHaveBeenCalledTimes(1);
    expect(await hqStandupService.run(USER, NOW)).toEqual({ created: 0 });
    expect(repo.insertEvent).toHaveBeenCalledTimes(1);
  });
});

// ── analytics ───────────────────────────────────────────────────────────────
describe('buildAnalytics', () => {
  const snapshot = {
    generated_at: '2026-11-04T08:00:00+00:00', timezone: 'Asia/Tbilisi', days: 3, total_registered_users: 120,
    series: [
      { date: '2026-11-02', new_users: 1, active_players: 4, active_all: 8, matches: 2 },
      { date: '2026-11-03', new_users: 0, active_players: 0, active_all: 0, matches: 0 },
      { date: '2026-11-04', new_users: 2, active_players: 5, active_all: 11, matches: 1 },
    ],
    actives: { dau: 5, wau: 9, mau: 20 }, actives_all: { dau: 11, wau: 30, mau: 70 }, modes: [], modes_by_day: [],
    countries: [
      { country: 'GE', players: 3, registered: 50 }, { country: 'unknown', players: 0, registered: 60 },
      { country: 'TR', players: 7, registered: 10 },
    ],
  };
  const games = [
    { day: '2026-11-01', mode: 'ranked', games: 100 }, // outside the window
    ...['ranked', 'friendly', 'grid', 'daily', 'auction', 'party_quiz', 'squad_spin', 'trivia_mines'].map((mode, i) => ({
      day: '2026-11-02', mode, games: 10 - i,
    })),
    { day: '2026-11-04', mode: 'ranked', games: 5 },
  ];

  it('merges sources into the API shape', () => {
    const a = buildAnalytics({
      days: 3, snapshot: snapshot as never, games,
      retention: [{ cohort_start: '2026-10-26', size: 4, d1: '0.25', d7: null, d30: null }],
    });
    expect(a.series).toEqual([
      { date: '2026-11-02', newUsers: 1, activePlayers: 8, matches: 52 },
      { date: '2026-11-03', newUsers: 0, activePlayers: 0, matches: 0 },
      { date: '2026-11-04', newUsers: 2, activePlayers: 11, matches: 5 },
    ]);
    expect(a.actives).toEqual({ dau: 11, wau: 30, mau: 70 });
    expect(a.totals).toEqual({ registeredUsers: 120 });
    expect(a.modes[0]).toEqual({ mode: 'ranked', matches: 15, share: 0.263 });
    expect(a.modes).toHaveLength(8);
    // top 6 + other, zero-filled for every day
    expect(Object.keys(a.modesByDay[0]).sort()).toEqual(
      ['date', 'ranked', 'friendly', 'grid', 'daily', 'auction', 'party_quiz', 'other'].sort()
    );
    expect(a.modesByDay[0].other).toBe(3 + 4);
    expect(a.modesByDay[1]).toMatchObject({ ranked: 0, other: 0 });
    expect(a.modesByDay[2].ranked).toBe(5);
    expect(a.modeLabels).toMatchObject({ ranked: 'Ranked', grid: 'Football Grid', other: 'Other' });
    expect(a.countries.map((c) => c.country)).toEqual(['TR', 'GE', 'unknown']);
    expect(a.retention).toEqual([{ cohortStart: '2026-10-26', size: 4, d1: 0.25, d7: null, d30: null }]);
    expect(a.generatedAt).toBe('2026-11-04T08:00:00.000Z');
  });

  it('labels unknown modes readably', () => {
    const a = buildAnalytics({
      days: 3, snapshot: snapshot as never,
      games: [{ day: '2026-11-02', mode: 'penalty_shootout', games: 1 }], retention: [],
    });
    expect(a.modeLabels).toEqual({ penalty_shootout: 'Penalty shootout' });
    expect(MODE_LABELS.daily).toBe('Daily games');
    expect(MODE_LABELS.duel).toBe('Duels');
    expect(MODE_LABELS.room_codenames).toBe('Codenames (room)');
  });
});

// ── PostHog ─────────────────────────────────────────────────────────────────
describe('PostHog client', () => {
  const settings = { apiKey: 'phx_secret', projectId: '123', host: 'https://us.posthog.com' };
  beforeEach(() => posthog.clearPosthogCache());

  it('is not connected without a key and project id', async () => {
    expect(posthog.posthogSettings({})).toBeNull();
    expect(posthog.posthogSettings({ POSTHOG_PERSONAL_API_KEY: 'k' })).toBeNull();
    await expect(posthog.fetchPosthogAnalytics(30, { settings: null })).resolves.toEqual({ connected: false });
  });

  it('derives the app host from the ingestion host', () => {
    expect(posthog.deriveApiHost('https://us.i.posthog.com')).toBe('https://us.posthog.com');
    expect(posthog.deriveApiHost('https://eu.i.posthog.com/')).toBe('https://eu.posthog.com');
    expect(posthog.deriveApiHost(undefined)).toBe('https://us.posthog.com');
    expect(
      posthog.posthogSettings({ POSTHOG_PERSONAL_API_KEY: 'k', POSTHOG_PROJECT_ID: '1', POSTHOG_API_HOST: 'https://ph.example.com/' })?.host
    ).toBe('https://ph.example.com');
  });

  it('runs HogQL queries, shapes results and caches for 10 minutes', async () => {
    const answers: Record<string, unknown[][]> = {
      day: [['2026-11-03', 40, 120], ['2026-11-04', 55, 150]],
      geoip: [['GE', 30], [null, 5]],
      referring: [['google.com', 20]],
      pathname: [['/', 300]],
      first_match: [[95, 12, 7]],
    };
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      const q = JSON.parse(String(init.body)).query;
      expect(q.kind).toBe('HogQLQuery');
      expect(url).toBe('https://us.posthog.com/api/projects/123/query/');
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer phx_secret');
      const key = Object.keys(answers).find((k) => q.query.includes(k))!;
      return new Response(JSON.stringify({ results: answers[key] }), { status: 200 });
    });
    let t = 0;
    const res = await posthog.fetchPosthogAnalytics(30, { settings, fetchImpl: fetchImpl as never, now: () => t });
    expect(res).toEqual({
      connected: true,
      visitorsByDay: [{ date: '2026-11-03', visitors: 40, pageviews: 120 }, { date: '2026-11-04', visitors: 55, pageviews: 150 }],
      topCountries: [{ country: 'GE', visitors: 30 }, { country: 'unknown', visitors: 5 }],
      topReferrers: [{ source: 'google.com', visitors: 20 }],
      topPages: [{ path: '/', views: 300 }],
      funnel: { visitors: 95, signups: 12, firstMatch: 7 },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    const funnelQuery = fetchImpl.mock.calls.map((c) => JSON.parse(String(c[1].body)).query.query).find((q: string) => q.includes('first_match'));
    expect(funnelQuery).toContain("'account_created'");
    expect(funnelQuery).toContain("'match_started'");
    t = 9 * 60_000;
    await posthog.fetchPosthogAnalytics(30, { settings, fetchImpl: fetchImpl as never, now: () => t });
    expect(fetchImpl).toHaveBeenCalledTimes(5); // cached
    t = 11 * 60_000;
    await posthog.fetchPosthogAnalytics(30, { settings, fetchImpl: fetchImpl as never, now: () => t });
    expect(fetchImpl).toHaveBeenCalledTimes(10);
  });

  it('turns failures into { connected: true, error } without leaking the key', async () => {
    const unauthorized = vi.fn(async () => new Response('{"detail":"bad key phx_secret"}', { status: 401 }));
    const r1 = await posthog.fetchPosthogAnalytics(7, { settings, fetchImpl: unauthorized as never });
    expect(r1).toEqual({ connected: true, error: expect.stringContaining('rejected the API key') });
    expect(JSON.stringify(r1)).not.toContain('phx_secret');
    const down = vi.fn(async () => { throw new TypeError('fetch failed'); });
    expect(await posthog.fetchPosthogAnalytics(7, { settings, fetchImpl: down as never })).toEqual({
      connected: true, error: 'Could not reach PostHog',
    });
    // errors are not cached
    const ok = vi.fn(async () => new Response(JSON.stringify({ results: [] }), { status: 200 }));
    const r3 = await posthog.fetchPosthogAnalytics(7, { settings, fetchImpl: ok as never });
    expect(r3).toMatchObject({ connected: true, funnel: { visitors: 0 } });
  });
});


// ── v3 fix round ────────────────────────────────────────────────────────────
describe('v3 fixes', () => {
  it('accept regenerates the body only when proposal fields change', async () => {
    repo.getTask.mockResolvedValue(taskRow());
    await hqService.acceptProposal('t1', { proposal: { plan: 'post twice a day', effort: 'm' } }, USER);
    expect(repo.transitionTask.mock.calls[0][1].body).toBe(
      '**Why:** reach\n\n**Plan:** post twice a day\n\n**Expected impact:** +500 players · **Effort:** M'
    );
    // title-only change: body untouched (may hold hand-edited instructions)
    await hqService.acceptProposal('t1', { title: 'New title' }, USER);
    expect(repo.transitionTask.mock.calls[1][1].body).toBeUndefined();
    expect(repo.transitionTask.mock.calls[1][1].title).toBe('New title');
    // proposal fields sent but unchanged: no rebuild either
    await hqService.acceptProposal('t1', { title: 'T', proposal: { effort: 's', why: 'reach' } }, USER);
    expect(repo.transitionTask.mock.calls[2][1].body).toBeUndefined();
  });

  it('accept keeps an explicit body, and leaves the body alone without edits', async () => {
    repo.getTask.mockResolvedValue(taskRow());
    await hqService.acceptProposal('t1', { body: 'my words', proposal: { effort: 'l' } }, USER);
    expect(repo.transitionTask.mock.calls[0][1].body).toBe('my words');
    await hqService.acceptProposal('t1', {}, USER);
    expect(repo.transitionTask.mock.calls[1][1].body).toBeUndefined();
  });

  it('proposalBody matches the worker format', () => {
    expect(proposalBody({ why: 'a', plan: 'b', expectedImpact: 'c', effort: 's' })).toBe(
      '**Why:** a\n\n**Plan:** b\n\n**Expected impact:** c · **Effort:** S'
    );
  });

  it("PATCH can't move a proposed task's status or assignee, but can edit its wording", async () => {
    repo.getTask.mockResolvedValue(taskRow());
    await expect(hqService.updateTask('t1', { status: 'todo' }, USER)).rejects.toThrow('Accept or decline this idea first');
    await expect(hqService.updateTask('t1', { status: 'cancelled' }, USER)).rejects.toThrow('Accept or decline this idea first');
    await expect(
      hqService.updateTask('t1', { assigneeId: '22222222-2222-4222-8222-222222222222' }, USER)
    ).rejects.toThrow('Accept or decline this idea first');
    expect(repo.updateTask).not.toHaveBeenCalled();
    repo.updateTask.mockResolvedValue(true);
    await hqService.updateTask('t1', { title: 'Sharper title', body: 'b', priority: 1 }, USER);
    expect(repo.updateTask.mock.calls[0][1]).toMatchObject({ title: 'Sharper title', body: 'b', priority: 1 });
    expect(repo.updateTask.mock.calls[0][2]).toEqual({ statuses: ['proposed'], assigneeId: 'a1' });
  });

  it("/run refuses a proposed task", async () => {
    repo.getTask.mockResolvedValue(taskRow());
    await expect(hqService.runTask('t1', USER)).rejects.toThrow('Accept or decline this idea first');
    expect(repo.transitionTask).not.toHaveBeenCalled();
  });

  it('PATCH title collisions with another open idea are 409, not 500', async () => {
    repo.getTask.mockResolvedValue(taskRow());
    repo.updateTask.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }));
    await expect(hqService.updateTask('t1', { title: 'Derby quiz post' }, USER)).rejects.toThrow(
      'Another open idea from this agent has the same title'
    );
    repo.updateTask.mockRejectedValueOnce(new Error('boom'));
    await expect(hqService.updateTask('t1', { title: 'x' }, USER)).rejects.toThrow('boom');
  });

  it("run-now passes today's date and 409s when the agent already has today's standup", async () => {
    const sched = {
      id: 's1', member_id: 'a1', member: { id: 'a1', slug: 'social', name: 'Social', avatar: '📱', color: 'sky', kind: 'agent' },
      name: 'Daily standup', cron: '0 8 * * *', timezone: 'Asia/Tbilisi', task_title: 'Daily standup', task_body: '',
      task_kind: 'standup', enabled: true, next_run_at: null, last_run_at: null, last_task_id: null, created_at: NOW, updated_at: NOW,
    };
    repo.getSchedule.mockResolvedValue(sched);
    repo.getMember.mockResolvedValue({ id: 'a1', kind: 'agent', runtime: 'hq', status: 'active', name: 'Social' });
    repo.runScheduleNow.mockResolvedValueOnce({ duplicate: true });
    await expect(hqService.runScheduleNow('s1', USER)).rejects.toThrow("Social already has today's standup");
    expect(repo.runScheduleNow.mock.calls[0][0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    repo.runScheduleNow.mockResolvedValueOnce({ taskId: 't7' });
    repo.getTask.mockResolvedValueOnce(taskRow({ id: 't7', kind: 'standup', status: 'todo' }));
    const t = await hqService.runScheduleNow('s1', USER);
    expect(t).toMatchObject({ id: 't7', kind: 'standup' });
  });

  it('analytics asks for enough cohorts for D30 to mature and totals countries before the cut', async () => {
    hqAnalyticsService.clearCache();
    const countries = Array.from({ length: 35 }, (_, i) => ({ country: `C${i}`, players: 1, registered: 2 }));
    goalsRepo.analyticsSnapshot.mockResolvedValue({
      generated_at: NOW.toISOString(), timezone: 'Asia/Tbilisi', days: 30, total_registered_users: 70,
      series: [{ date: TODAY, new_users: 0, active_players: 0, matches: 0 }], actives: { dau: 0, wau: 0, mau: 0 },
      modes: [], modes_by_day: [], countries,
    });
    stats.actives.mockResolvedValue({ dau: 0, wau: 0, mau: 0 });
    stats.dauSeries.mockResolvedValue([]);
    stats.gamesPerDay.mockResolvedValue([]);
    goalsRepo.retentionCohorts.mockResolvedValue([]);
    const a = await hqAnalyticsService.analytics(30);
    // D30 matures at cohort_start + 65 days → 16 weekly cohorts keep ~6 mature ones
    expect(RETENTION_WEEKS).toBeGreaterThanOrEqual(14);
    expect(goalsRepo.retentionCohorts).toHaveBeenCalledWith(RETENTION_WEEKS);
    expect(a.countries).toHaveLength(30);
    expect(a.countriesTotalPlayers).toBe(35);
    expect(a.countriesTotalRegistered).toBe(70);
  });

  it('analytics runs its heavy queries one at a time and shares one computation across concurrent requests', async () => {
    hqAnalyticsService.clearCache();
    let active = 0;
    let peak = 0;
    const slow = <T>(v: T) => async () => {
      active++; peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return v;
    };
    goalsRepo.analyticsSnapshot.mockReset().mockImplementation(slow({
      generated_at: NOW.toISOString(), timezone: 'Asia/Tbilisi', days: 7, total_registered_users: 0,
      series: [], actives: { dau: 0, wau: 0, mau: 0 }, modes: [], modes_by_day: [], countries: [],
    }));
    stats.actives.mockReset().mockImplementation(slow({ dau: 0, wau: 0, mau: 0 }));
    stats.dauSeries.mockReset().mockImplementation(slow([]));
    stats.gamesPerDay.mockReset().mockImplementation(slow([]));
    goalsRepo.retentionCohorts.mockReset().mockImplementation(slow([]));
    const [a, b] = await Promise.all([hqAnalyticsService.analytics(7), hqAnalyticsService.analytics(7)]);
    expect(peak).toBe(1);
    expect(a).toBe(b);
    expect(goalsRepo.analyticsSnapshot).toHaveBeenCalledTimes(1);
  });

  it('PostHog funnel is ordered and nested', async () => {
    posthog.clearPosthogCache();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ results: [] }), { status: 200 }));
    await posthog.fetchPosthogAnalytics(14, {
      settings: { apiKey: 'k', projectId: '1', host: 'https://us.posthog.com' }, fetchImpl: fetchImpl as never,
    });
    const funnel = (fetchImpl.mock.calls as unknown as [string, RequestInit][])
      .map((c) => JSON.parse(String(c[1].body)).query.query as string)
      .find((q) => q.includes('first_match'))!;
    expect(funnel).toContain("minIf(timestamp, event = '$pageview') AS visit_at");
    expect(funnel).toContain("minIf(timestamp, event = 'account_created') AS signup_at");
    expect(funnel).toContain("maxIf(timestamp, event = 'match_started') AS last_match_at");
    expect(funnel).toContain("HAVING countIf(event = '$pageview') > 0");
    expect(funnel).toContain('countIf(signup_at > visit_at) AS signups');
    expect(funnel).toContain('countIf(signup_at > visit_at AND last_match_at > signup_at) AS first_match');
  });

  describe('standup KPIs follow the requested date', () => {
    const pulseRow = (generatedAt: string, newUsers: Record<string, number>) => ({
      metrics: { generated_at: generatedAt, timezone: 'Asia/Tbilisi', days: 14, total_registered_users: 0,
        new_users_by_day: newUsers, matches_by_day: {}, active_players_by_day: {} },
      feedback: { count_7d: 3, avg_rating_7d: 4.4, low_ratings_7d: 1, count_prev_7d: 2, avg_rating_prev_7d: 3.9 },
    });
    beforeEach(() => {
      goalsRepo.listGoals.mockResolvedValue([]);
      repo.listMembers.mockResolvedValue([]);
      repo.listStandups.mockResolvedValue([]);
      repo.listProposals.mockResolvedValue([]);
      repo.listWorking.mockResolvedValue([]);
      repo.listFinishedOn.mockResolvedValue([]);
    });

    it('picks date and date-1 out of a series, null when missing', () => {
      const series = [{ date: '2026-11-03', newUsers: 4, matches: 2, activePlayers: 6 }];
      expect(kpisFromSeries(series, '2026-11-04')).toEqual({
        newUsers: { today: null, yesterday: 4 }, activePlayers: { today: null, yesterday: 6 }, matches: { today: null, yesterday: 2 },
      });
    });

    it('today reads counts from the pulse but rating from the same calendar windows as past dates', async () => {
      repo.pulse.mockResolvedValue(pulseRow(NOW.toISOString(), { [TODAY]: 7, '2026-11-03': 5 }));
      goalsAnalytics.ratingSummary.mockResolvedValueOnce({ avg: 4.6, low: 2 }).mockResolvedValueOnce({ avg: 4.0, low: 1 });
      const s = await hqStandupService.standup(undefined, NOW);
      expect(repo.pulse).toHaveBeenCalledWith(14);
      expect(s.kpis.newUsers).toEqual({ today: 7, yesterday: 5 });
      // not pulse.feedback (rolling timestamps) — Tbilisi calendar days
      expect(goalsAnalytics.ratingSummary).toHaveBeenNthCalledWith(1, '2026-10-29', TODAY);
      expect(goalsAnalytics.ratingSummary).toHaveBeenNthCalledWith(2, '2026-10-22', '2026-10-28');
      expect(s.kpis.rating).toEqual({ current: 4.6, previous: 4.0, lowRatings7d: 2 });
    });

    it('a past date reads a long-enough window and date-relative ratings', async () => {
      repo.pulse.mockResolvedValue(pulseRow(NOW.toISOString(), { '2026-10-15': 9, '2026-10-14': 3, [TODAY]: 99 }));
      goalsAnalytics.ratingSummary.mockResolvedValueOnce({ avg: 4.8, low: 0 }).mockResolvedValueOnce({ avg: 4.1, low: 2 });
      const s = await hqStandupService.standup('2026-10-15', NOW);
      expect(repo.pulse).toHaveBeenCalledWith(22); // 20 days back + the day before + today
      expect(s.kpis.newUsers).toEqual({ today: 9, yesterday: 3 });
      expect(goalsAnalytics.ratingSummary).toHaveBeenNthCalledWith(1, '2026-10-09', '2026-10-15');
      expect(goalsAnalytics.ratingSummary).toHaveBeenNthCalledWith(2, '2026-10-02', '2026-10-08');
      expect(s.kpis.rating).toEqual({ current: 4.8, previous: 4.1, lowRatings7d: 0 });
    });

    it('future dates and dates beyond the 90-day window get nulls', async () => {
      for (const date of ['2026-11-05', '2026-07-01']) {
        const s = await hqStandupService.standup(date, NOW);
        expect(s.kpis).toEqual({
          newUsers: { today: null, yesterday: null }, activePlayers: { today: null, yesterday: null },
          matches: { today: null, yesterday: null }, rating: { current: null, previous: null, lowRatings7d: null },
        });
      }
      expect(repo.pulse).not.toHaveBeenCalled();
    });
  });
});


// ── round 3 ─────────────────────────────────────────────────────────────────
describe('round 3', () => {
  it('measures goal progress one query at a time (no unbounded fan-out), memoising identical windows', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const slow = (v: number) => async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return v;
    };
    goalsRepo.newUsersBetween.mockImplementation(slow(3));
    stats.gamesBetween.mockImplementation(slow(4));
    goalsRepo.activeIdentitiesBetween.mockImplementation(slow(5));
    const rows = [
      goalRow({ id: 'a', metric: 'new_users', target: '10' }),
      goalRow({ id: 'b', metric: 'new_users', target: '20' }), // same window → memoised
      goalRow({ id: 'c', metric: 'matches', target: '10' }),
      goalRow({ id: 'd', metric: 'active_players', target: '10' }),
    ];
    const out = await goals.withProgress(rows as never, NOW);
    expect(maxInFlight).toBe(1);
    expect(goalsRepo.newUsersBetween).toHaveBeenCalledTimes(1);
    expect(out.map((g) => g.progress.current)).toEqual([3, 3, 4, 5]);
  });

  it('matches progress queries the explicit period, however old the goal', async () => {
    stats.gamesBetween.mockResolvedValue(1234);
    const [g] = await goals.withProgress(
      [goalRow({ metric: 'matches', target: '2000', period_start: '2024-01-01', period_end: '2024-12-31' }) as never],
      NOW
    );
    expect(stats.gamesBetween).toHaveBeenCalledWith('2024-01-01', '2024-12-31');
    expect(g.progress).toEqual({ current: 1234, pct: 62 });
  });

  it('latestMatureD7 picks the newest cohort mature on the given date', () => {
    const cohorts = [
      { cohort_start: '2026-09-28', size: 5, d7: '0.2' },
      { cohort_start: '2026-10-05', size: 5, d7: '0.3' }, // mature after 10-24
      { cohort_start: '2026-10-12', size: 5, d7: '0.4' }, // mature after 10-31
      { cohort_start: '2026-10-19', size: 0, d7: null },
    ];
    expect(goals.latestMatureD7(cohorts, '2026-11-04')).toBe(0.4);
    expect(goals.latestMatureD7(cohorts, '2026-10-31')).toBe(0.3); // 10-12 + 19 = 10-31 is not yet past
    expect(goals.latestMatureD7(cohorts, '2026-10-20')).toBe(0.2);
    expect(goals.latestMatureD7(cohorts, '2026-10-01')).toBeNull();
  });

  it('d7_retention for an expired goal reads retention as of its end date (memo keyed by end)', async () => {
    goalsRepo.retentionCohorts.mockResolvedValue([
      { cohort_start: '2026-09-21', size: 4, d1: 0.5, d7: '0.25', d30: null },
      { cohort_start: '2026-10-12', size: 4, d1: 0.5, d7: '0.75', d30: null },
    ]);
    const out = await goals.withProgress(
      [
        goalRow({ id: 'old', metric: 'd7_retention', target: '50', period_start: '2026-10-01', period_end: '2026-10-15' }),
        goalRow({ id: 'now', metric: 'd7_retention', target: '50' }),
      ] as never,
      NOW
    );
    expect(out[0].progress).toEqual({ current: 25, pct: 50 }); // as of 10-15 only the 09-21 cohort was mature
    expect(out[1].progress).toEqual({ current: 75, pct: 100 });
    expect(goalsRepo.retentionCohorts).toHaveBeenCalledTimes(2);
    // enough weeks to reach a cohort mature by the end date
    expect(goalsRepo.retentionCohorts.mock.calls[0][0]).toBeGreaterThanOrEqual(Math.ceil((20 + 20) / 7) + 1);
  });

  it('d7_retention far in the past: asks for the 26-week maximum and lets the cohorts decide (unknown here)', async () => {
    goalsRepo.retentionCohorts.mockResolvedValue([{ cohort_start: '2026-05-18', size: 5, d1: 0.4, d7: '0.3', d30: null }]);
    const [g] = await goals.withProgress(
      [goalRow({ metric: 'd7_retention', target: '50', period_start: '2025-01-01', period_end: '2025-02-01' }) as never],
      NOW
    );
    expect(goalsRepo.retentionCohorts).toHaveBeenCalledWith(26);
    expect(g.progress).toEqual({ current: null, pct: null }); // no cohort was mature by 2025-02-01
  });

  it('d7_retention: a padded estimate above 26 weeks still finds a cohort mature by the end date', async () => {
    // end 2026-06-07 → estimate ceil((150 + 19) / 7) + 2 = 27 weeks → clamped to 26;
    // the 2026-05-18 cohort (mature after 06-06) is inside that window.
    goalsRepo.retentionCohorts.mockResolvedValue([
      { cohort_start: '2026-05-18', size: 5, d1: 0.4, d7: '0.3', d30: null },
      { cohort_start: '2026-05-25', size: 5, d1: 0.4, d7: '0.9', d30: null }, // not mature by 06-07
    ]);
    const [g] = await goals.withProgress(
      [goalRow({ metric: 'd7_retention', target: '60', period_start: '2026-05-01', period_end: '2026-06-07' }) as never],
      NOW
    );
    expect(goalsRepo.retentionCohorts).toHaveBeenCalledTimes(1);
    expect(goalsRepo.retentionCohorts).toHaveBeenCalledWith(26);
    expect(g.progress).toEqual({ current: 30, pct: 50 });
  });

  describe('analytics single-flight', () => {
    const snapshot = {
      generated_at: NOW.toISOString(), timezone: 'Asia/Tbilisi', days: 30, total_registered_users: 0,
      series: [{ date: TODAY, new_users: 0, active_players: 0, matches: 0 }], actives: { dau: 0, wau: 0, mau: 0 },
      modes: [], modes_by_day: [], countries: [],
    };
    beforeEach(() => {
      hqAnalyticsService.clearCache();
      stats.actives.mockResolvedValue({ dau: 0, wau: 0, mau: 0 });
      stats.dauSeries.mockResolvedValue([]);
      stats.gamesPerDay.mockResolvedValue([]);
      goalsRepo.retentionCohorts.mockResolvedValue([]);
    });

    it('runs the queries sequentially and shares one computation between concurrent requests', async () => {
      let release!: () => void;
      goalsRepo.analyticsSnapshot.mockImplementation(() => new Promise((r) => { release = () => r(snapshot); }));
      const a = hqAnalyticsService.analytics(30);
      const b = hqAnalyticsService.analytics(30);
      await Promise.resolve();
      expect(stats.gamesPerDay).not.toHaveBeenCalled(); // waits for the snapshot query
      release();
      const [ra, rb] = await Promise.all([a, b]);
      expect(ra).toBe(rb);
      expect(goalsRepo.analyticsSnapshot).toHaveBeenCalledTimes(1);
    });

    it('clearCache also drops in-flight computations', async () => {
      goalsRepo.analyticsSnapshot.mockImplementation(() => new Promise(() => {})); // hangs
      void hqAnalyticsService.analytics(30);
      hqAnalyticsService.clearCache();
      goalsRepo.analyticsSnapshot.mockResolvedValue(snapshot);
      await hqAnalyticsService.analytics(30);
      expect(goalsRepo.analyticsSnapshot).toHaveBeenCalledTimes(2);
    });
  });
});


// ── round 4 ─────────────────────────────────────────────────────────────────
describe('round 4', () => {
  const snapshot = {
    generated_at: NOW.toISOString(), timezone: 'Asia/Tbilisi', days: 30, total_registered_users: 0,
    series: [{ date: TODAY, new_users: 0, active_players: 2, active_all: 3, matches: 0 }],
    actives: { dau: 2, wau: 2, mau: 2 }, actives_all: { dau: 3, wau: 4, mau: 5 }, modes: [], modes_by_day: [], countries: [],
  };
  beforeEach(() => {
    hqAnalyticsService.clearCache();
    goalsRepo.analyticsSnapshot.mockResolvedValue(snapshot);
    stats.gamesPerDay.mockResolvedValue([]);
    goalsRepo.retentionCohorts.mockResolvedValue([]);
  });

  it('analytics no longer runs the raw-table admin-stats actives/DAU scans', async () => {
    const a = await hqAnalyticsService.analytics(30);
    expect(stats.actives).not.toHaveBeenCalled();
    expect(stats.dauSeries).not.toHaveBeenCalled();
    expect(a.actives).toEqual({ dau: 3, wau: 4, mau: 5 }); // guests included, from the rollup
    expect(a.series[0].activePlayers).toBe(3);
  });

  it('falls back to registered actives on an older snapshot shape', () => {
    const { actives_all: _ignored, ...old } = snapshot;
    const a = buildAnalytics({
      days: 30,
      snapshot: { ...old, series: [{ date: TODAY, new_users: 0, active_players: 2, matches: 0 }] } as never,
      games: [], retention: [],
    });
    expect(a.actives).toEqual({ dau: 2, wau: 2, mau: 2 });
    expect(a.series[0].activePlayers).toBe(2);
  });

  it('caches 5 minutes, then serves stale while revalidating (up to 30 minutes)', async () => {
    let t = 0;
    const clock = () => t;
    await hqAnalyticsService.analytics(30, clock);
    expect(goalsRepo.analyticsSnapshot).toHaveBeenCalledTimes(1);
    t = 4 * 60_000;
    await hqAnalyticsService.analytics(30, clock);
    expect(goalsRepo.analyticsSnapshot).toHaveBeenCalledTimes(1); // fresh hit
    t = 6 * 60_000;
    let release!: () => void;
    goalsRepo.analyticsSnapshot.mockImplementationOnce(
      () => new Promise((r) => { release = () => r({ ...snapshot, total_registered_users: 99 }); })
    );
    const stale = await hqAnalyticsService.analytics(30, clock); // returns at once
    expect(stale.totals.registeredUsers).toBe(0);
    expect(goalsRepo.analyticsSnapshot).toHaveBeenCalledTimes(2); // background refresh started
    release();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const fresh = await hqAnalyticsService.analytics(30, clock);
    expect(fresh.totals.registeredUsers).toBe(99);
    t = 60 * 60_000; // beyond the stale window → waits for a recompute
    await hqAnalyticsService.analytics(30, clock);
    expect(goalsRepo.analyticsSnapshot).toHaveBeenCalledTimes(3);
  });

  it('weekly active players come from the rollup function, not raw tables', async () => {
    goalsRepo.activeIdentitiesBetween.mockResolvedValue(42);
    const [g] = await goals.withProgress(
      [goalRow({ metric: 'active_players', target: '100', period_start: '2026-10-01', period_end: '2026-12-31' }) as never],
      NOW
    );
    expect(goalsRepo.activeIdentitiesBetween).toHaveBeenCalledWith('2026-10-29', TODAY);
    expect(g.progress).toEqual({ current: 42, pct: 42 });
  });

  it('daily active players: the last complete day (yesterday while the goal runs), else the goal\'s last day', async () => {
    goalsRepo.activeIdentitiesBetween.mockResolvedValue(2739);
    const [g] = await goals.withProgress(
      [goalRow({ metric: 'daily_active_players', target: '5000', period_start: '2026-10-01', period_end: '2027-03-31' }) as never],
      NOW
    );
    expect(goalsRepo.activeIdentitiesBetween).toHaveBeenCalledWith('2026-11-03', '2026-11-03');
    expect(g.progress).toEqual({ current: 2739, pct: 55 });
    goalsRepo.activeIdentitiesBetween.mockClear();
    await goals.withProgress([goalRow({ id: 'old', metric: 'daily_active_players', target: '5000', period_start: '2026-10-01', period_end: '2026-10-20' }) as never], NOW);
    expect(goalsRepo.activeIdentitiesBetween).toHaveBeenCalledWith('2026-10-20', '2026-10-20');
  });
});


// ── round 5 ─────────────────────────────────────────────────────────────────
describe('round 5: goal history is bounded and paged', () => {
  const rows = (n: number, over: Record<string, unknown> = {}) =>
    Array.from({ length: n }, (_, i) => goalRow({ id: `g${i}`, status: 'achieved', ...over }));

  it('active-only lists keep board order, honour the limit and have no cursor', async () => {
    goalsRepo.listGoals.mockResolvedValue(rows(4, { status: 'active' }));
    const page = await goals.hqGoalsService.list({ status: ['active'], limit: 3 }, NOW);
    expect(goalsRepo.listGoals).toHaveBeenCalledWith({ statuses: ['active'], horizon: undefined, limit: 3, before: undefined });
    expect(page.items).toHaveLength(3);
    expect(page.nextCursor).toBeNull();
  });

  it('history pages return a cursor when more exist, and measure progress only for the page', async () => {
    goalsRepo.newUsersBetween.mockResolvedValue(1);
    goalsRepo.listGoals.mockResolvedValue(rows(3, { metric: 'new_users', target: '10' }));
    const page = await goals.hqGoalsService.list({ status: ['achieved', 'dropped'], limit: 2 }, NOW);
    expect(page.items.map((g) => g.id)).toEqual(['g0', 'g1']);
    expect(page.nextCursor).toBe('g1');
    // the 3rd (look-ahead) row is never measured
    expect(goalsRepo.newUsersBetween).toHaveBeenCalledTimes(1); // same window for g0/g1 → memoised
  });

  it('the last history page has no cursor; an unknown cursor is a 422', async () => {
    goalsRepo.goalExists.mockResolvedValueOnce(true);
    goalsRepo.listGoals.mockResolvedValue(rows(1));
    const page = await goals.hqGoalsService.list({ status: ['achieved'], limit: 2, before: 'g9' }, NOW);
    expect(goalsRepo.listGoals).toHaveBeenLastCalledWith({ statuses: ['achieved'], horizon: undefined, limit: 2, before: 'g9' });
    expect(page.nextCursor).toBeNull();
    goalsRepo.goalExists.mockResolvedValueOnce(false);
    await expect(goals.hqGoalsService.list({ status: ['dropped'], limit: 2, before: 'gone' }, NOW)).rejects.toBeInstanceOf(
      ValidationError
    );
  });
});


// ── round 6 ─────────────────────────────────────────────────────────────────
describe('round 6: weekly actives outside the rollup coverage are unknown', () => {
  it('a null count from the rollup shows as unknown progress, not 0%', async () => {
    goalsRepo.activeIdentitiesBetween.mockResolvedValue(null);
    const [g] = await goals.withProgress(
      [goalRow({ metric: 'active_players', target: '100', period_start: '2024-01-01', period_end: '2024-02-01' }) as never],
      NOW
    );
    expect(goalsRepo.activeIdentitiesBetween).toHaveBeenCalledWith('2024-01-26', '2024-02-01');
    expect(g.progress).toEqual({ current: null, pct: null });
  });
});


// ── round 7 ─────────────────────────────────────────────────────────────────
describe('round 7: run-now on a schedule that disappears', () => {
  it('maps an empty repo result to 404', async () => {
    repo.getSchedule.mockResolvedValue({
      id: 's1', member_id: 'a1', member: { id: 'a1', slug: 'social', name: 'Social', avatar: '📱', color: 'sky', kind: 'agent' },
      name: 'Weekly', cron: '0 8 * * 1', timezone: 'Asia/Tbilisi', task_title: 'x', task_body: '', task_kind: 'task',
      enabled: true, next_run_at: null, last_run_at: null, last_task_id: null, created_at: NOW, updated_at: NOW,
    });
    repo.getMember.mockResolvedValue({ id: 'a1', kind: 'agent', runtime: 'hq', status: 'active', name: 'Social' });
    repo.runScheduleNow.mockResolvedValueOnce(null);
    await expect(hqService.runScheduleNow('s1', USER)).rejects.toBeInstanceOf(NotFoundError);
    expect(repo.getTask).not.toHaveBeenCalled();
  });
});


// ── round 8 ─────────────────────────────────────────────────────────────────
describe('round 8: d7 retention looks further back when the short window has no mature cohort', () => {
  it('extends to 26 weeks before returning unknown', async () => {
    goalsRepo.retentionCohorts
      .mockResolvedValueOnce([
        { cohort_start: '2026-10-05', size: 0, d1: null, d7: null, d30: null }, // mature but empty
        { cohort_start: '2026-10-19', size: 3, d1: 0.3, d7: null, d30: null },  // not mature yet
      ])
      .mockResolvedValueOnce([
        { cohort_start: '2026-08-31', size: 6, d1: 0.5, d7: '0.5', d30: null },
        { cohort_start: '2026-10-05', size: 0, d1: null, d7: null, d30: null },
      ]);
    const [g] = await goals.withProgress([goalRow({ metric: 'd7_retention', target: '40' }) as never], NOW);
    expect(goalsRepo.retentionCohorts).toHaveBeenCalledTimes(2);
    expect(goalsRepo.retentionCohorts.mock.calls[1][0]).toBe(26);
    expect(g.progress).toEqual({ current: 50, pct: 100 });
  });

  it('still unknown when even 26 weeks have no mature non-empty cohort', async () => {
    goalsRepo.retentionCohorts.mockResolvedValue([{ cohort_start: '2026-10-19', size: 0, d1: null, d7: null, d30: null }]);
    const [g] = await goals.withProgress([goalRow({ metric: 'd7_retention', target: '40' }) as never], NOW);
    expect(goalsRepo.retentionCohorts).toHaveBeenCalledTimes(2);
    expect(g.progress).toEqual({ current: null, pct: null });
  });

  it('no extra query when the short window already has an answer', async () => {
    goalsRepo.retentionCohorts.mockResolvedValue([{ cohort_start: '2026-10-05', size: 4, d1: 0.5, d7: '0.25', d30: null }]);
    await goals.withProgress([goalRow({ metric: 'd7_retention', target: '40' }) as never], NOW);
    expect(goalsRepo.retentionCohorts).toHaveBeenCalledTimes(1);
  });
});


describe('mode labels', () => {
  it('falls back to readable labels, marking future room games', () => {
    expect(friendlyModeLabel('room_penalty_kings')).toBe('Penalty kings (room)');
    expect(friendlyModeLabel('penalty_shootout')).toBe('Penalty shootout');
  });
});


// ── standup requeue guard ───────────────────────────────────────────────────
describe('requeueing a standup goes through the standup-locked check', () => {
  const standup = (over: Record<string, unknown> = {}) =>
    taskRow({ kind: 'standup', status: 'blocked', title: 'Daily standup', proposal: null, ...over });

  it('run: passes the guard for standups only', async () => {
    repo.getTask.mockResolvedValue(standup());
    await hqService.runTask('t1', USER);
    expect(repo.transitionTask.mock.calls[0][3].standupRequeue).toEqual({ date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    repo.getTask.mockResolvedValue(taskRow({ kind: 'task', status: 'blocked', proposal: null }));
    await hqService.runTask('t1', USER);
    expect(repo.transitionTask.mock.calls[1][3].standupRequeue).toBeUndefined();
  });

  it.each([
    ['run', () => hqService.runTask('t1', USER)],
    ['reject', () => hqService.rejectTask('t1', { note: 'again' }, USER)],
    ['PATCH → todo', () => hqService.updateTask('t1', { status: 'todo' }, USER)],
    ['PATCH → backlog', () => hqService.updateTask('t1', { status: 'backlog' }, USER)],
  ])('%s: a refused requeue is a 409 with the "Start standup now" hint', async (_name, run) => {
    repo.getTask.mockResolvedValue(standup({ status: 'done' }));
    repo.transitionTask.mockRejectedValueOnce(new StandupRequeueRefused());
    // One call: the service must map the repo's refusal to a ConflictError (409).
    const err = await run().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as Error).message).toBe("Use 'Start standup now' for today's standup");
    expect(repo.transitionTask.mock.calls[0][3].standupRequeue).toBeDefined();
  });

  it('PATCH: requeueing a standup uses the guarded transition; other edits and other kinds do not', async () => {
    repo.getTask.mockResolvedValue(standup());
    repo.updateTask.mockResolvedValue(true);
    await hqService.updateTask('t1', { status: 'todo' }, USER);
    expect(repo.transitionTask).toHaveBeenCalledTimes(1);
    expect(repo.updateTask).not.toHaveBeenCalled();
    await hqService.updateTask('t1', { title: 'Standup (retry)' }, USER);
    expect(repo.updateTask).toHaveBeenCalledTimes(1);
    repo.getTask.mockResolvedValue(taskRow({ kind: 'task', status: 'blocked', proposal: null }));
    await hqService.updateTask('t1', { status: 'todo' }, USER);
    // a normal task moving to todo keeps the plain guarded update
    expect(repo.transitionTask).toHaveBeenCalledTimes(1);
    expect(repo.updateTask).toHaveBeenCalledTimes(2);
  });

  it('PATCH: a standup cannot be reassigned to another agent', async () => {
    repo.getTask.mockResolvedValue(standup());
    repo.getMember.mockResolvedValue({ id: '22222222-2222-4222-8222-222222222222', kind: 'agent', runtime: 'hq', status: 'active', name: 'Other agent' });
    await expect(
      hqService.updateTask('t1', { assigneeId: '22222222-2222-4222-8222-222222222222', status: 'todo' }, USER)
    ).rejects.toThrow("A standup belongs to its agent and can't be reassigned");
    expect(repo.updateTask).not.toHaveBeenCalled();
    expect(repo.transitionTask).not.toHaveBeenCalled();
  });

  it('reject passes the guard for standups', async () => {
    repo.getTask.mockResolvedValue(standup({ status: 'done' }));
    await hqService.rejectTask('t1', { note: 'redo' }, USER);
    expect(repo.transitionTask.mock.calls[0][3].standupRequeue).toBeDefined();
  });
});
