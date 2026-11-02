import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../setup.js';

const repo = vi.hoisted(() => ({
  getMemberByUserId: vi.fn(),
  ensureHumanForUser: vi.fn(),
  getMember: vi.fn(),
  getTask: vi.fn(),
  updateTask: vi.fn(),
  transitionTask: vi.fn(),
  insertTask: vi.fn(),
  insertMessage: vi.fn(),
  insertEvent: vi.fn(),
  getSchedule: vi.fn(),
  insertSchedule: vi.fn(),
  updateSchedule: vi.fn(),
  runScheduleNow: vi.fn(),
  listTaskMessages: vi.fn(),
  listRuns: vi.fn(),
  listChildren: vi.fn(),
}));

vi.mock('../../src/modules/hq/hq.repo.js', () => ({ hqRepo: repo }));

const { hqService, assertValidCron, assertValidTimezone } = await import('../../src/modules/hq/hq.service.js');
const { ConflictError, BadRequestError, NotFoundError, ValidationError, AuthenticationError } = await import(
  '../../src/core/errors.js'
);

const USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const NOW = new Date('2026-11-02T08:00:00Z');

const human = {
  id: 'h1',
  slug: 'u-aaaaaaaaaaaa',
  kind: 'human',
  user_id: USER_ID,
  name: 'Nika',
  title: 'Team',
  avatar: '🧑',
  color: 'slate',
  description: '',
  instructions: '',
  model: null,
  tools: [],
  autonomy: 'autonomous',
  runtime: 'none',
  status: 'active',
  max_turns: 25,
  last_active_at: null,
  created_at: NOW,
  updated_at: NOW,
};
const agent = { ...human, id: 'a1', slug: 'ops-reporter', kind: 'agent', user_id: null, name: 'Ops Reporter', runtime: 'hq' };
const ref = (m: typeof human) => ({ id: m.id, slug: m.slug, name: m.name, avatar: m.avatar, color: m.color, kind: m.kind });

function taskRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 't1',
    number: '7',
    title: 'Daily briefing',
    body: '',
    status: 'todo',
    priority: 2,
    assignee_id: agent.id,
    created_by_id: human.id,
    parent_id: null,
    depth: 0,
    schedule_id: null,
    result: null,
    position: 1,
    attempts: 0,
    claimed_by: null,
    claimed_at: null,
    due_at: null,
    completed_at: null,
    created_at: NOW,
    updated_at: NOW,
    assignee: ref(agent),
    created_by: ref(human),
    assignee_runtime: 'hq',
    assignee_status: 'active',
    message_count: 0,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  repo.getMemberByUserId.mockResolvedValue(human);
  repo.updateTask.mockResolvedValue(true);
  repo.transitionTask.mockResolvedValue(true);
  repo.insertEvent.mockResolvedValue(undefined);
  repo.insertMessage.mockResolvedValue({
    id: '1', task_id: 't1', author: ref(human), recipient: null, kind: 'comment', body: 'x', read_at: null, created_at: NOW,
  });
});

describe('actingMember', () => {
  it('returns the existing member for the user', async () => {
    await expect(hqService.actingMember(USER_ID)).resolves.toBe(human);
    expect(repo.ensureHumanForUser).not.toHaveBeenCalled();
  });

  it('auto-creates a human member on first use', async () => {
    repo.getMemberByUserId.mockResolvedValueOnce(undefined);
    repo.ensureHumanForUser.mockResolvedValueOnce(human);
    await expect(hqService.actingMember(USER_ID)).resolves.toBe(human);
    expect(repo.ensureHumanForUser).toHaveBeenCalledWith(USER_ID);
  });

  it('rejects anonymous callers', async () => {
    await expect(hqService.actingMember(null)).rejects.toBeInstanceOf(AuthenticationError);
  });
});

describe('approveTask', () => {
  it('moves needs_approval → done with note + event in one transaction', async () => {
    repo.getTask.mockResolvedValueOnce(taskRow({ status: 'needs_approval' }));
    repo.getTask.mockResolvedValueOnce(taskRow({ status: 'done', completed_at: NOW }));
    const task = await hqService.approveTask('t1', { note: 'Ship it' }, USER_ID);
    expect(task.status).toBe('done');
    expect(task.number).toBe(7);
    expect(repo.transitionTask).toHaveBeenCalledTimes(1);
    const [, patch, expected, extras] = repo.transitionTask.mock.calls[0];
    expect(patch).toMatchObject({ status: 'done', claimed_by: null, claimed_at: null, claim_token: null });
    expect(patch.completed_at).toBeInstanceOf(Date);
    expect(expected).toEqual({ statuses: ['needs_approval'], assigneeId: agent.id });
    expect(extras.message).toMatchObject({ authorId: human.id, recipientId: agent.id, body: 'Ship it' });
    expect(extras.event).toMatchObject({ type: 'task_status', taskId: 't1' });
    // nothing written outside the transaction
    expect(repo.insertMessage).not.toHaveBeenCalled();
    expect(repo.insertEvent).not.toHaveBeenCalled();
    expect(repo.updateTask).not.toHaveBeenCalled();
  });

  it('omits the message when there is no note', async () => {
    repo.getTask.mockResolvedValueOnce(taskRow({ status: 'needs_approval' }));
    repo.getTask.mockResolvedValueOnce(taskRow({ status: 'done' }));
    await hqService.approveTask('t1', {}, USER_ID);
    expect(repo.transitionTask.mock.calls[0][3].message).toBeUndefined();
  });

  it('409s when the task is not waiting for approval', async () => {
    repo.getTask.mockResolvedValueOnce(taskRow({ status: 'todo' }));
    await expect(hqService.approveTask('t1', {}, USER_ID)).rejects.toBeInstanceOf(ConflictError);
    expect(repo.transitionTask).not.toHaveBeenCalled();
  });

  it('409s when the status changed underneath (race)', async () => {
    repo.getTask.mockResolvedValueOnce(taskRow({ status: 'needs_approval' }));
    repo.transitionTask.mockResolvedValueOnce(false);
    await expect(hqService.approveTask('t1', {}, USER_ID)).rejects.toBeInstanceOf(ConflictError);
  });

  it('404s for unknown tasks', async () => {
    repo.getTask.mockResolvedValueOnce(undefined);
    await expect(hqService.approveTask('nope', {}, USER_ID)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('rejectTask', () => {
  it.each(['needs_approval', 'done', 'blocked'])('sends %s back to todo with the note addressed to the assignee', async (status) => {
    repo.getTask.mockResolvedValueOnce(taskRow({ status }));
    repo.getTask.mockResolvedValueOnce(taskRow({ status: 'todo' }));
    const task = await hqService.rejectTask('t1', { note: 'Add retention numbers' }, USER_ID);
    expect(task.status).toBe('todo');
    const [, patch, expected, extras] = repo.transitionTask.mock.calls[0];
    expect(patch).toMatchObject({ status: 'todo', completed_at: null, claimed_by: null, claim_token: null });
    expect(patch).toMatchObject({ attempts: 0 }); // rework gets a fresh retry budget
    expect(expected).toEqual({ statuses: ['needs_approval', 'done', 'blocked'], assigneeId: agent.id });
    expect(extras.message).toMatchObject({ recipientId: agent.id, kind: 'comment', body: 'Add retention numbers' });
    expect(extras.event).toMatchObject({ type: 'task_status' });
    expect(repo.insertMessage).not.toHaveBeenCalled();
  });

  it('writes no note when the transition loses a race', async () => {
    repo.getTask.mockResolvedValueOnce(taskRow({ status: 'needs_approval' }));
    repo.transitionTask.mockResolvedValueOnce(false);
    await expect(hqService.rejectTask('t1', { note: 'x' }, USER_ID)).rejects.toBeInstanceOf(ConflictError);
    expect(repo.insertMessage).not.toHaveBeenCalled();
    expect(repo.insertEvent).not.toHaveBeenCalled();
  });

  it.each(['todo', 'in_progress', 'backlog', 'cancelled'])('409s from %s', async (status) => {
    repo.getTask.mockResolvedValueOnce(taskRow({ status }));
    await expect(hqService.rejectTask('t1', { note: 'x' }, USER_ID)).rejects.toBeInstanceOf(ConflictError);
  });
});

describe('runTask', () => {
  it('re-queues a task for an active HQ agent', async () => {
    repo.getTask.mockResolvedValueOnce(taskRow({ status: 'done', completed_at: NOW }));
    repo.getTask.mockResolvedValueOnce(taskRow({ status: 'todo' }));
    const task = await hqService.runTask('t1', USER_ID);
    expect(task.status).toBe('todo');
    const [, patch, expected, extras] = repo.transitionTask.mock.calls[0];
    expect(patch).toMatchObject({ status: 'todo', completed_at: null, claim_token: null });
    expect(patch).toMatchObject({ attempts: 0 }); // rework gets a fresh retry budget
    expect(expected.statuses).not.toContain('in_progress');
    expect(expected.assigneeId).toBe(agent.id);
    expect(extras.event).toMatchObject({ type: 'task_status' });
    expect(repo.insertEvent).not.toHaveBeenCalled();
  });

  it('409s while the task is running', async () => {
    repo.getTask.mockResolvedValueOnce(taskRow({ status: 'in_progress' }));
    await expect(hqService.runTask('t1', USER_ID)).rejects.toBeInstanceOf(ConflictError);
  });

  it('rejects tasks not assigned to an HQ agent', async () => {
    repo.getTask.mockResolvedValueOnce(taskRow({ assignee: ref(human), assignee_runtime: 'none' }));
    await expect(hqService.runTask('t1', USER_ID)).rejects.toBeInstanceOf(BadRequestError);
    repo.getTask.mockResolvedValueOnce(taskRow({ assignee_runtime: 'question_agents' }));
    await expect(hqService.runTask('t1', USER_ID)).rejects.toBeInstanceOf(BadRequestError);
    repo.getTask.mockResolvedValueOnce(taskRow({ assignee_id: null, assignee: null, assignee_runtime: null }));
    await expect(hqService.runTask('t1', USER_ID)).rejects.toBeInstanceOf(BadRequestError);
  });

  it('rejects paused agents', async () => {
    repo.getTask.mockResolvedValueOnce(taskRow({ assignee_status: 'paused' }));
    await expect(hqService.runTask('t1', USER_ID)).rejects.toThrow(/paused/);
  });
});

describe('updateTask', () => {
  it('refuses to move an HQ-agent task to in_progress (only the worker claims)', async () => {
    repo.getTask.mockResolvedValueOnce(taskRow({ status: 'todo' }));
    await expect(hqService.updateTask('t1', { status: 'in_progress' }, USER_ID)).rejects.toBeInstanceOf(ConflictError);
    expect(repo.updateTask).not.toHaveBeenCalled();
  });

  it('refuses in_progress when reassigning to an HQ agent in the same edit', async () => {
    repo.getTask.mockResolvedValueOnce(taskRow({ assignee_id: human.id, assignee: ref(human), assignee_runtime: 'none' }));
    repo.getMember.mockResolvedValueOnce(agent);
    await expect(
      hqService.updateTask('t1', { status: 'in_progress', assigneeId: agent.id }, USER_ID)
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('lets humans start their own tasks', async () => {
    repo.getTask.mockResolvedValueOnce(taskRow({ assignee_id: human.id, assignee: ref(human), assignee_runtime: 'none' }));
    repo.getTask.mockResolvedValueOnce(taskRow({ status: 'in_progress', assignee: ref(human) }));
    await hqService.updateTask('t1', { status: 'in_progress' }, USER_ID);
    const patch = repo.updateTask.mock.calls[0][1];
    expect(patch.status).toBe('in_progress');
    expect(patch).toMatchObject({ claimed_by: null, claim_token: null });
  });

  it('sets completed_at on done and clears claim fields', async () => {
    repo.getTask.mockResolvedValueOnce(taskRow({ status: 'blocked', claimed_by: 'w1' }));
    repo.getTask.mockResolvedValueOnce(taskRow({ status: 'done' }));
    await hqService.updateTask('t1', { status: 'done' }, USER_ID);
    const [, patch, expected] = repo.updateTask.mock.calls[0];
    expect(patch.completed_at).toBeInstanceOf(Date);
    expect(patch).toMatchObject({ claimed_by: null, claimed_at: null, claim_token: null });
    expect(expected).toEqual({ statuses: ['blocked'], assigneeId: agent.id });
  });

  describe('while an HQ agent is running the task', () => {
    const running = () => taskRow({ status: 'in_progress', claimed_by: 'w1', claim_token: 'tok' });

    it.each(['todo', 'backlog', 'needs_approval'])('409s moving it back to %s', async (status) => {
      repo.getTask.mockResolvedValueOnce(running());
      await expect(hqService.updateTask('t1', { status: status as never }, USER_ID)).rejects.toThrow(
        /still working on this/
      );
      expect(repo.updateTask).not.toHaveBeenCalled();
    });

    it.each(['cancelled', 'blocked', 'done'])('allows %s and releases the claim', async (status) => {
      repo.getTask.mockResolvedValueOnce(running());
      repo.getTask.mockResolvedValueOnce(taskRow({ status }));
      await hqService.updateTask('t1', { status: status as never }, USER_ID);
      const [, patch, expected] = repo.updateTask.mock.calls[0];
      expect(patch).toMatchObject({ status, claimed_by: null, claimed_at: null, claim_token: null });
      expect(expected).toEqual({ statuses: ['in_progress'], assigneeId: agent.id });
    });

    it('allows title edits without touching the claim', async () => {
      repo.getTask.mockResolvedValueOnce(running());
      repo.getTask.mockResolvedValueOnce(running());
      await hqService.updateTask('t1', { title: 'Better title' }, USER_ID);
      expect(repo.updateTask.mock.calls[0][1]).not.toHaveProperty('claim_token');
    });

    it('409s reassigning without choosing a new status', async () => {
      repo.getTask.mockResolvedValueOnce(running());
      repo.getMember.mockResolvedValueOnce(human);
      await expect(hqService.updateTask('t1', { assigneeId: human.id }, USER_ID)).rejects.toThrow(/choose a new status/);
      repo.getTask.mockResolvedValueOnce(running());
      repo.getMember.mockResolvedValueOnce(human);
      await expect(
        hqService.updateTask('t1', { assigneeId: human.id, status: 'in_progress' }, USER_ID)
      ).rejects.toThrow(/choose a new status/);
    });

    it('still applies rule 1 when reassigning with a new status', async () => {
      repo.getTask.mockResolvedValueOnce(running());
      repo.getMember.mockResolvedValueOnce(human);
      await expect(
        hqService.updateTask('t1', { assigneeId: human.id, status: 'todo' }, USER_ID)
      ).rejects.toThrow(/still working on this/);
    });

    it('allows reassigning with an allowed status and releases the claim', async () => {
      repo.getTask.mockResolvedValueOnce(running());
      repo.getMember.mockResolvedValueOnce(human);
      repo.getTask.mockResolvedValueOnce(taskRow({ status: 'blocked', assignee: ref(human) }));
      await hqService.updateTask('t1', { assigneeId: human.id, status: 'blocked' }, USER_ID);
      expect(repo.updateTask.mock.calls[0][1]).toMatchObject({
        assignee_id: human.id,
        status: 'blocked',
        claim_token: null,
      });
    });
  });

  it('lets a human move their own in_progress task back to todo', async () => {
    repo.getTask.mockResolvedValueOnce(
      taskRow({ status: 'in_progress', assignee_id: human.id, assignee: ref(human), assignee_runtime: 'none' })
    );
    repo.getTask.mockResolvedValueOnce(taskRow({ status: 'todo' }));
    await hqService.updateTask('t1', { status: 'todo' }, USER_ID);
    expect(repo.updateTask.mock.calls[0][1]).toMatchObject({ status: 'todo', claim_token: null });
  });

  it('releases the claim on a plain reassignment', async () => {
    repo.getTask.mockResolvedValueOnce(taskRow({ status: 'todo' }));
    repo.getMember.mockResolvedValueOnce(human);
    repo.getTask.mockResolvedValueOnce(taskRow({ assignee: ref(human) }));
    await hqService.updateTask('t1', { assigneeId: human.id }, USER_ID);
    expect(repo.updateTask.mock.calls[0][1]).toMatchObject({ assignee_id: human.id, claimed_by: null, claim_token: null });
  });

  it('clears completed_at when leaving done', async () => {
    repo.getTask.mockResolvedValueOnce(taskRow({ status: 'done', completed_at: NOW }));
    repo.getTask.mockResolvedValueOnce(taskRow({ status: 'backlog' }));
    await hqService.updateTask('t1', { status: 'backlog' }, USER_ID);
    expect(repo.updateTask.mock.calls[0][1].completed_at).toBeNull();
  });

  it('refuses archived assignees', async () => {
    repo.getTask.mockResolvedValueOnce(taskRow());
    repo.getMember.mockResolvedValueOnce({ ...agent, status: 'archived' });
    await expect(hqService.updateTask('t1', { assigneeId: agent.id }, USER_ID)).rejects.toBeInstanceOf(BadRequestError);
  });

  it('guards on the assignee it read, so a concurrent reassignment loses with 409', async () => {
    // A: human starts their own todo task while B reassigns it to an agent.
    repo.getTask.mockResolvedValueOnce(
      taskRow({ status: 'todo', assignee_id: human.id, assignee: ref(human), assignee_runtime: 'none' })
    );
    repo.updateTask.mockResolvedValueOnce(false); // B already changed assignee_id
    await expect(hqService.updateTask('t1', { status: 'in_progress' }, USER_ID)).rejects.toBeInstanceOf(ConflictError);
    expect(repo.updateTask.mock.calls[0][2]).toEqual({ statuses: ['todo'], assigneeId: human.id });
  });

  it('guards unassigned tasks on assignee IS NULL', async () => {
    repo.getTask.mockResolvedValueOnce(taskRow({ assignee_id: null, assignee: null, assignee_runtime: null }));
    repo.getTask.mockResolvedValueOnce(taskRow());
    await hqService.updateTask('t1', { title: 'x' }, USER_ID);
    expect(repo.updateTask.mock.calls[0][2]).toEqual({ statuses: ['todo'], assigneeId: null });
  });

  it('409s when the worker changed the task meanwhile', async () => {
    repo.getTask.mockResolvedValueOnce(taskRow());
    repo.updateTask.mockResolvedValueOnce(false);
    await expect(hqService.updateTask('t1', { title: 'New' }, USER_ID)).rejects.toBeInstanceOf(ConflictError);
  });
});

describe('createTask', () => {
  it('derives depth from the parent and records the creator', async () => {
    repo.getMember.mockResolvedValueOnce(agent);
    repo.getTask.mockResolvedValueOnce(taskRow({ id: 'p1', depth: 2 }));
    repo.insertTask.mockResolvedValueOnce('t2');
    repo.getTask.mockResolvedValueOnce(taskRow({ id: 't2', depth: 3 }));
    await hqService.createTask({ title: 'Sub', assigneeId: agent.id, parentId: 'p1' }, USER_ID);
    expect(repo.insertTask).toHaveBeenCalledWith(
      expect.objectContaining({ depth: 3, createdById: human.id, assigneeId: agent.id, status: 'todo', priority: 2 })
    );
  });
});

describe('schedules', () => {
  it('validates cron and timezone helpers', () => {
    expect(() => assertValidCron('0 8 * * *', 'Asia/Tbilisi')).not.toThrow();
    expect(() => assertValidCron('*/15 9-18 * * 1-5', 'Europe/Berlin')).not.toThrow();
    expect(() => assertValidCron('0 0 8 * * *', 'Asia/Tbilisi')).toThrow(ValidationError);
    expect(() => assertValidCron('@daily', 'Asia/Tbilisi')).toThrow(ValidationError);
    expect(() => assertValidCron('61 8 * * *', 'Asia/Tbilisi')).toThrow(ValidationError);
    expect(() => assertValidTimezone('Asia/Tbilisi')).not.toThrow();
    expect(() => assertValidTimezone('Mars/Olympus')).toThrow(ValidationError);
  });

  it.each([
    ['a human', human],
    ['a non-HQ agent', { ...agent, runtime: 'question_agents' }],
    ['an archived agent', { ...agent, status: 'archived' }],
    ['a missing member', undefined],
  ])('refuses to schedule %s (422)', async (_label, member) => {
    repo.getMember.mockResolvedValueOnce(member);
    await expect(
      hqService.createSchedule({ memberId: 'm1', name: 'x', cron: '0 8 * * *', taskTitle: 'x' }, USER_ID)
    ).rejects.toThrow('Schedules can only run HQ agents');
    expect(repo.insertSchedule).not.toHaveBeenCalled();
  });

  it('allows paused HQ agents', async () => {
    repo.getMember.mockResolvedValueOnce({ ...agent, status: 'paused' });
    repo.insertSchedule.mockResolvedValueOnce('s1');
    repo.getSchedule.mockResolvedValueOnce({
      id: 's1', member_id: agent.id, member: ref(agent), name: 'x', cron: '0 8 * * *', timezone: 'Asia/Tbilisi',
      task_title: 'x', task_body: '', enabled: true, next_run_at: null, last_run_at: null, last_task_id: null,
      created_at: NOW, updated_at: NOW,
    });
    await hqService.createSchedule({ memberId: agent.id, name: 'x', cron: '0 8 * * *', taskTitle: 'x' }, USER_ID);
    expect(repo.insertSchedule).toHaveBeenCalled();
  });

  it('run-now creates task + stamp + event in one transaction and validates the member', async () => {
    const sched = {
      id: 's1', member_id: agent.id, member: ref(agent), name: 'Morning', cron: '0 8 * * *', timezone: 'Asia/Tbilisi',
      task_title: 'Brief', task_body: '', enabled: true, next_run_at: NOW, last_run_at: null, last_task_id: null,
      created_at: NOW, updated_at: NOW,
    };
    repo.getSchedule.mockResolvedValueOnce(sched);
    repo.getMember.mockResolvedValueOnce(agent);
    repo.runScheduleNow.mockResolvedValueOnce('t9');
    repo.getTask.mockResolvedValueOnce(taskRow({ id: 't9', schedule_id: 's1' }));
    const task = await hqService.runScheduleNow('s1', USER_ID);
    expect(task.id).toBe('t9');
    const args = repo.runScheduleNow.mock.calls[0][0];
    expect(args).toMatchObject({ scheduleId: 's1', createdById: human.id });
    expect(args.event({ id: 't9', number: '12' })).toMatchObject({
      type: 'schedule_fired',
      message: expect.stringContaining('HQ-12'),
      data: { scheduleId: 's1', manual: true },
    });
    expect(repo.insertTask).not.toHaveBeenCalled();
    expect(repo.insertEvent).not.toHaveBeenCalled();
    expect(repo.updateSchedule).not.toHaveBeenCalled(); // next_run_at untouched

    repo.getSchedule.mockResolvedValueOnce(sched);
    repo.getMember.mockResolvedValueOnce({ ...agent, runtime: 'bug_triage' });
    await expect(hqService.runScheduleNow('s1', USER_ID)).rejects.toThrow('Schedules can only run HQ agents');
    expect(repo.runScheduleNow).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid cron on create', async () => {
    repo.getMember.mockResolvedValueOnce(agent);
    await expect(
      hqService.createSchedule({ memberId: agent.id, name: 'x', cron: 'every day', taskTitle: 'x' }, USER_ID)
    ).rejects.toBeInstanceOf(ValidationError);
    expect(repo.insertSchedule).not.toHaveBeenCalled();
  });

  it('resets next_run_at when the timing changes, not otherwise', async () => {
    const sched = {
      id: 's1', member_id: agent.id, member: ref(agent), name: 'Morning', cron: '0 8 * * *', timezone: 'Asia/Tbilisi',
      task_title: 'Brief', task_body: '', enabled: true, next_run_at: NOW, last_run_at: null, last_task_id: null,
      created_at: NOW, updated_at: NOW,
    };
    repo.getSchedule.mockResolvedValue(sched);
    repo.updateSchedule.mockResolvedValue(true);
    await hqService.updateSchedule('s1', { cron: '0 9 * * *' }, USER_ID);
    expect(repo.updateSchedule.mock.calls[0][1]).toMatchObject({ cron: '0 9 * * *', next_run_at: null });
    await hqService.updateSchedule('s1', { name: 'Renamed' }, USER_ID);
    expect(repo.updateSchedule.mock.calls[1][1]).not.toHaveProperty('next_run_at');
    await expect(hqService.updateSchedule('s1', { timezone: 'Nowhere/Land' }, USER_ID)).rejects.toBeInstanceOf(
      ValidationError
    );
  });
});
