import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../setup.js';

const repo = vi.hoisted(() => ({
  getMemberByUserId: vi.fn(),
  listMembers: vi.fn(),
  departmentCounts: vi.fn(),
  lastResultPerDepartment: vi.fn(),
  listTasks: vi.fn(),
  pulse: vi.fn(),
  insertAgent: vi.fn(),
  insertAgentWithStandup: vi.fn(),
  getMemberWithStats: vi.fn(),
  insertEvent: vi.fn(),
  ensureStandupSchedule: vi.fn(),
  getMember: vi.fn(),
  updateMember: vi.fn(),
}));

vi.mock('../../src/modules/hq/hq.repo.js', () => ({ hqRepo: repo }));

const { hqService, buildPulse, buildDepartments, dateRange, tbilisiDate } = await import(
  '../../src/modules/hq/hq.service.js'
);
const { DEPARTMENTS } = await import('../../src/modules/hq/hq.schemas.js');

const NOW = new Date('2026-11-02T08:00:00Z'); // 12:00 in Tbilisi

function member(over: Record<string, unknown>) {
  return {
    id: 'm', slug: 'm', kind: 'agent', user_id: null, name: 'M', title: '', avatar: '🤖', color: 'slate',
    description: '', instructions: '', model: null, tools: [], autonomy: 'autonomous', runtime: 'hq',
    status: 'active', department: 'leadership', max_turns: 25, last_active_at: null, created_at: NOW, updated_at: NOW,
    open_tasks: 0, runs_today: 0, cost_today_cents: 0, current_task: null, last_run: null,
    ...over,
  };
}
const ref = (m: ReturnType<typeof member>) => ({ id: m.id, slug: m.slug, name: m.name, avatar: m.avatar, color: m.color, kind: m.kind });

function task(over: Record<string, unknown>) {
  return {
    id: 't', number: '1', title: 'T', body: '', status: 'todo', priority: 2, assignee_id: null, created_by_id: null,
    parent_id: null, depth: 0, schedule_id: null, result: null, position: 1, attempts: 0, claimed_by: null,
    claimed_at: null, claim_token: null, due_at: null, completed_at: null, created_at: NOW, updated_at: NOW,
    assignee: null, created_by: null, assignee_runtime: null, assignee_status: null, assignee_department: null,
    message_count: 0,
    ...over,
  };
}

beforeEach(() => vi.clearAllMocks());

describe('date helpers', () => {
  it('uses the Tbilisi calendar day', () => {
    expect(tbilisiDate(new Date('2026-11-01T19:59:00Z'))).toBe('2026-11-01');
    expect(tbilisiDate(new Date('2026-11-01T20:00:00Z'))).toBe('2026-11-02'); // midnight UTC+4
  });

  it('builds consecutive dates across month boundaries, oldest first', () => {
    expect(dateRange('2026-03-02', 4)).toEqual(['2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02']);
  });
});

describe('buildPulse', () => {
  const row = {
    metrics: {
      generated_at: '2026-11-02T08:00:00+00:00',
      timezone: 'Asia/Tbilisi',
      days: 14,
      total_registered_users: 1234,
      new_users_by_day: { '2026-11-02': 5, '2026-11-01': 10, '2026-10-26': 4 },
      matches_by_day: { '2026-11-02': 20, '2026-11-01': 70, '2026-10-20': 999 },
      active_players_by_day: { '2026-11-01': 7 },
    },
    feedback: { count_7d: 9, avg_rating_7d: '3.456', low_ratings_7d: 2, count_prev_7d: 4, avg_rating_prev_7d: null },
  };

  it('fills every day with zeros, oldest → newest, ending today', () => {
    const p = buildPulse(row, 14, NOW);
    expect(p.series).toHaveLength(14);
    expect(p.series[0].date).toBe('2026-10-20');
    expect(p.series[13]).toEqual({ date: '2026-11-02', newUsers: 5, matches: 20, activePlayers: 0 });
    expect(p.series.find((d) => d.date === '2026-10-30')).toEqual({
      date: '2026-10-30', newUsers: 0, matches: 0, activePlayers: 0,
    });
  });

  it('computes today, yesterday and the 7 full days before today', () => {
    const p = buildPulse(row, 14, NOW);
    expect(p.today).toEqual({ newUsers: 5, matches: 20, activePlayers: 0 });
    expect(p.yesterday).toEqual({ newUsers: 10, matches: 70, activePlayers: 7 });
    // window = 10-26 … 11-01 → newUsers 4 + 10 = 14 / 7 = 2; matches 70 / 7 = 10; today and 10-20 excluded
    expect(p.avg7d).toEqual({ newUsers: 2, matches: 10, activePlayers: 1 });
  });

  it('camel-cases feedback and rounds ratings', () => {
    const p = buildPulse(row, 14, NOW);
    expect(p.totals.registeredUsers).toBe(1234);
    expect(p.feedback).toEqual({ count7d: 9, avgRating7d: 3.46, lowRatings7d: 2, countPrev7d: 4, avgRatingPrev7d: null });
    expect(p.generatedAt).toBe('2026-11-02T08:00:00.000Z');
  });

  it('labels days from the snapshot time, not the request time (midnight boundary)', () => {
    // Request started 23:59:59 Tbilisi on 11-01; the snapshot was taken after midnight (11-02).
    const requestAt = new Date('2026-11-01T19:59:59Z');
    const p = buildPulse({ ...row, metrics: { ...row.metrics, generated_at: '2026-11-01T20:00:01+00:00' } }, 14, requestAt);
    expect(p.series[13].date).toBe('2026-11-02');
    expect(p.today).toEqual({ newUsers: 5, matches: 20, activePlayers: 0 });
  });
});

describe('buildDepartments', () => {
  const ops = member({ id: 'ops', slug: 'ops-reporter', name: 'Ops', department: 'leadership' });
  const writer = member({ id: 'gw', slug: 'growth-writer', name: 'Growth Writer', department: 'growth' });
  const nika = member({ id: 'h', slug: 'u-1', kind: 'human', runtime: 'none', name: 'Nika', department: 'leadership' });

  it('returns every department in order, with members, counts, last result and in-flight work', () => {
    const counts = [{ department: 'growth', open: 3, todo: 1, in_progress: 1, needs_approval: 1, blocked: 0, done_today: 2 }];
    const last = [task({ id: 'r1', status: 'done', assignee: ref(writer), assignee_department: 'growth', result: '# Posts' })];
    const running = [task({ id: 'w1', number: '9', title: 'Plan', status: 'in_progress', assignee: ref(writer), assignee_department: 'growth' })];
    const depts = buildDepartments([ops, writer, nika] as never, counts, last as never, running as never);

    expect(depts.map((d) => d.key)).toEqual(DEPARTMENTS.map((d) => d.key));
    const leadership = depts.find((d) => d.key === 'leadership')!;
    expect(leadership.members.map((m) => m.slug)).toEqual(['ops-reporter', 'u-1']);
    expect(leadership.counts).toEqual({ open: 0, todo: 0, inProgress: 0, needsApproval: 0, blocked: 0, doneToday: 0 });
    expect(leadership.lastResult).toBeNull();

    const growth = depts.find((d) => d.key === 'growth')!;
    expect(growth).toMatchObject({ name: 'Growth', emoji: '📈' });
    expect(growth.counts).toEqual({ open: 3, todo: 1, inProgress: 1, needsApproval: 1, blocked: 0, doneToday: 2 });
    expect(growth.lastResult?.id).toBe('r1');
    expect(growth.working).toEqual([{ member: ref(writer), task: { id: 'w1', number: 9, title: 'Plan' } }]);
  });

  it('leaves out unassigned in-progress tasks', () => {
    const depts = buildDepartments([], [], [], [task({ status: 'in_progress' })] as never);
    expect(depts.every((d) => d.working.length === 0)).toBe(true);
  });
});

describe('service wiring', () => {
  it('departments() reads in-progress tasks and groups them', async () => {
    repo.listMembers.mockResolvedValueOnce([]);
    repo.departmentCounts.mockResolvedValueOnce([]);
    repo.lastResultPerDepartment.mockResolvedValueOnce([]);
    repo.listTasks.mockResolvedValueOnce([]);
    const res = await hqService.departments();
    expect(res.items).toHaveLength(6);
    expect(repo.listMembers).toHaveBeenCalledWith(false);
    expect(repo.listTasks).toHaveBeenCalledWith(expect.objectContaining({ statuses: ['in_progress'] }));
  });

  it('listTasks forwards the department filter', async () => {
    repo.listTasks.mockResolvedValueOnce([]);
    await hqService.listTasks({ department: 'growth', limit: 50 });
    expect(repo.listTasks).toHaveBeenCalledWith(expect.objectContaining({ department: 'growth', limit: 50 }));
  });

  it('pulse() passes days to hq.pulse', async () => {
    repo.pulse.mockResolvedValueOnce({ metrics: { new_users_by_day: {}, matches_by_day: {}, active_players_by_day: {} }, feedback: {} });
    const p = await hqService.pulse(30, NOW);
    expect(repo.pulse).toHaveBeenCalledWith(30);
    expect(p.series).toHaveLength(30);
    expect(p.feedback.avgRating7d).toBeNull();
  });

  it.each([
    ['paused', 'active', true],
    ['archived', 'active', true],
    ['active', 'paused', false],
    ['active', 'active', true], // self-heal: any edit of an active HQ agent (idempotent insert)
    ['paused', 'paused', false],
  ])('updateMember %s → %s ensures the standup schedule: %s', async (from, to, expected) => {
    repo.getMemberByUserId.mockResolvedValue(member({ id: 'h', kind: 'human', runtime: 'none', name: 'Nika' }));
    repo.getMember.mockResolvedValue(member({ id: 'a', status: from }));
    repo.updateMember.mockResolvedValue(member({ id: 'a', status: to }));
    repo.getMemberWithStats.mockResolvedValue(member({ id: 'a', status: to }));
    await hqService.updateMember('a', { status: to as never, title: 'x' }, 'u');
    if (expected) expect(repo.ensureStandupSchedule).toHaveBeenCalledWith('a');
    else expect(repo.ensureStandupSchedule).not.toHaveBeenCalled();
  });

  it('reactivating a non-HQ agent (other runtime) does not add a standup', async () => {
    repo.getMemberByUserId.mockResolvedValue(member({ id: 'h', kind: 'human', runtime: 'none', name: 'Nika' }));
    repo.getMember.mockResolvedValue(member({ id: 'q', status: 'paused', runtime: 'question_agents' }));
    repo.updateMember.mockResolvedValue(member({ id: 'q', status: 'active', runtime: 'question_agents' }));
    repo.getMemberWithStats.mockResolvedValue(member({ id: 'q', status: 'active', runtime: 'question_agents' }));
    await hqService.updateMember('q', { status: 'active' }, 'u');
    expect(repo.ensureStandupSchedule).not.toHaveBeenCalled();
  });

  it('createMember defaults department to leadership and accepts one', async () => {
    repo.getMemberByUserId.mockResolvedValue(member({ id: 'h', kind: 'human', runtime: 'none', name: 'Nika' }));
    repo.insertAgentWithStandup.mockResolvedValue(member({ id: 'n' }));
    repo.getMemberWithStats.mockResolvedValue(member({ id: 'n', department: 'content' }));
    await hqService.createMember({ slug: 'a-b', name: 'A', instructions: 'x' }, 'u');
    expect(repo.insertAgentWithStandup.mock.calls[0][0].department).toBe('leadership');
    const m = await hqService.createMember({ slug: 'c-d', name: 'C', instructions: 'x', department: 'content' }, 'u');
    expect(repo.insertAgentWithStandup.mock.calls[1][0].department).toBe('content');
    expect(m.department).toBe('content');
    // agent + standup schedule are created together in one repo transaction
    expect(repo.insertAgent).not.toHaveBeenCalled();
    expect(repo.ensureStandupSchedule).not.toHaveBeenCalled();
  });
});
