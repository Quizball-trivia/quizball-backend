import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../setup.js';

// Service rules for the Executive Director: the founder overrides his
// decisions, a person's actions count as approval for 'act' agents, and the
// chat endpoints talk to the right rows. The repo is mocked; the SQL side is
// covered by hq.sql.integration.test.ts.
const h = vi.hoisted(() => {
  const NOW = new Date('2026-11-10T08:00:00Z');
  const human = {
    id: 'h1', slug: 'founder', kind: 'human', is_founder: true, user_id: 'u1', name: 'Founder', title: '', avatar: '🙂', color: 'slate',
    description: '', instructions: '', model: null, tools: [], autonomy: 'autonomous', runtime: 'none', status: 'active',
    department: 'leadership', max_turns: 25, tier: 'read', role: 'agent', effort: null, daily_run_limit: null,
    last_active_at: null, created_at: NOW, updated_at: NOW,
  };
  const director = {
    ...human, id: 'd1', slug: 'director', kind: 'agent', name: 'Executive Director', runtime: 'hq', role: 'director',
    model: 'claude-fable-5-2', effort: 'medium', open_tasks: 0, runs_today: 0, cost_today_cents: 0, current_task: null, last_run: null,
  };
  const task = (over: Record<string, unknown> = {}) => ({
    id: 't1', number: '7', title: 'Idea', body: '', status: 'proposed', priority: 2, assignee_id: 'a1', created_by_id: 'a1',
    parent_id: null, depth: 1, schedule_id: null, result: null, position: 1, attempts: 0, claimed_by: null, claimed_at: null,
    claim_token: null, kind: 'proposal', goal_id: null, proposal: { effort: 's' }, due_at: null, completed_at: null,
    created_at: NOW, updated_at: NOW, assignee: { id: 'a1', slug: 'growth', name: 'Growth', kind: 'agent', avatar: '🤖', color: 'slate' },
    created_by: null, assignee_runtime: 'hq', assignee_status: 'active', assignee_department: 'growth', message_count: 0,
    founder_approved_at: null, director_decision: null, director_note: null, decided_at: null, escalated_at: null,
    review_state: null, review_note: null, reviewed_at: null, reopen_count: 0, ...over,
  });
  const repo = {
    getMemberByUserId: vi.fn(async () => human),
    ensureHumanForUser: vi.fn(async () => human),
    getTask: vi.fn(async () => task()),
    transitionTask: vi.fn(async () => true),
    updateTask: vi.fn(async () => true),
    insertTask: vi.fn(async () => 't9'),
    insertEvent: vi.fn(async () => {}),
    getDirector: vi.fn(async () => director as unknown),
    listNeedsYou: vi.fn(async () => []),
    listRunningNow: vi.fn(async () => []),
    listTodayPlan: vi.fn(async () => []),
    latestBrief: vi.fn(async () => undefined),
    listDirectorDecisions: vi.fn(async () => []),
    chatState: vi.fn(async () => ({ queued: true, running: false })),
    listChat: vi.fn(async () => [] as unknown[]),
    sendChat: vi.fn(async () => ({ message_id: 5, task_id: 'c1' })),
    markChatRead: vi.fn(async () => {}),
    getMember: vi.fn(async () => ({ ...human, id: 'a1', kind: 'agent', runtime: 'hq' })),
    insertAgentWithStandup: vi.fn(async (p: Record<string, unknown>) => ({ ...director, ...p, id: 'n1', role: 'agent' })),
    getMemberWithStats: vi.fn(async () => director),
  };
  return { repo, task, director, human, NOW };
});

vi.mock('../../src/modules/hq/hq.repo.js', () => ({ hqRepo: h.repo }));
vi.mock('../../src/modules/hq/hq.goals.repo.js', () => ({
  hqGoalsRepo: {},
  hqGoalsAnalyticsRepo: {},
  isUniqueViolation: () => false,
}));

const { hqService } = await import('../../src/modules/hq/hq.service.js');

const patchOf = () => h.repo.transitionTask.mock.calls.at(-1)![1] as Record<string, unknown>;
const guardOf = () => h.repo.transitionTask.mock.calls.at(-1)![2] as { statuses: string[] };

beforeEach(() => {
  vi.clearAllMocks();
  h.repo.getTask.mockImplementation(async () => h.task());
  h.repo.getDirector.mockImplementation(async () => h.director);
});

describe('founder overrides the director', () => {
  it('"Do it" works on an idea the director declined, and records the approval', async () => {
    h.repo.getTask.mockImplementation(async () => h.task({ status: 'cancelled', director_decision: 'declined' }));
    await hqService.acceptProposal('t1', {}, 'u1');
    expect(patchOf()).toMatchObject({ status: 'todo', escalated_at: null });
    expect(patchOf().founder_approved_at).toBeInstanceOf(Date);
    expect(guardOf().statuses).toEqual(['cancelled']);
  });

  it('"Do it" still refuses a cancelled idea nobody declined on the director\'s behalf', async () => {
    h.repo.getTask.mockImplementation(async () => h.task({ status: 'cancelled' }));
    await expect(hqService.acceptProposal('t1', {}, 'u1')).rejects.toThrow(/Only proposed ideas/);
  });

  it('"Not now" stops an idea the director approved, even while it runs', async () => {
    h.repo.getTask.mockImplementation(async () => h.task({ status: 'in_progress', director_decision: 'approved', claim_token: 'tok' }));
    await hqService.declineProposal('t1', { note: 'not this week' }, 'u1');
    expect(patchOf()).toMatchObject({ status: 'cancelled', claim_token: null });
    expect(guardOf().statuses).toEqual(['in_progress']);
  });

  it('"Not now" refuses finished work', async () => {
    h.repo.getTask.mockImplementation(async () => h.task({ status: 'done', director_decision: 'approved' }));
    await expect(hqService.declineProposal('t1', {}, 'u1')).rejects.toThrow(/Only proposed ideas/);
  });
});

describe("a person's action is their approval", () => {
  it('creating a task and running one both approve it', async () => {
    h.repo.getTask.mockImplementation(async () => h.task({ status: 'todo', kind: 'task' }));
    await hqService.createTask({ title: 'Check the funnel' } as never, 'u1');
    expect(h.repo.insertTask.mock.calls[0][0]).toMatchObject({ founderApproved: true });

    h.repo.getTask.mockImplementation(async () => h.task({ status: 'blocked', kind: 'task' }));
    await hqService.runTask('t1', 'u1');
    expect(patchOf().founder_approved_at).toBeInstanceOf(Date);
  });
});

describe('only the founder authorises work', () => {
  const asAlfred = () => h.repo.getMemberByUserId.mockImplementation(async () => ({ ...h.human, id: 'h2', name: 'Alfred', is_founder: false }) as never);
  afterEach(() => h.repo.getMemberByUserId.mockImplementation(async () => h.human as never));

  it('refuses every approving, running and configuring action from anyone else', async () => {
    asAlfred();
    h.repo.getTask.mockImplementation(async () => h.task({ status: 'needs_approval', kind: 'task', escalated_at: h.NOW }));
    const refused = [
      () => hqService.approveTask('t1', {} as never, 'u2'),
      () => hqService.rejectTask('t1', { note: 'redo' } as never, 'u2'),
      () => hqService.runTask('t1', 'u2'),
      () => hqService.acceptProposal('t1', {} as never, 'u2'),
      () => hqService.declineProposal('t1', {} as never, 'u2'),
      () => hqService.resolveEscalation('t1', 'u2'),
      () => hqService.updateMember('a1', { status: 'active' } as never, 'u2'),
      () => hqService.createMember({ name: 'X' } as never, 'u2'),
      () => hqService.updateSettings({} as never, 'u2'),
    ];
    for (const call of refused) await expect(call()).rejects.toThrow(/Only the founder can/);
    expect(h.repo.transitionTask).not.toHaveBeenCalled();
  });

  it('lets anyone file a task and chat, without approving it; their requeue withdraws an approval', async () => {
    asAlfred();
    h.repo.getTask.mockImplementation(async () => h.task({ status: 'todo', kind: 'task' }));
    await hqService.createTask({ title: 'Build a new mode' } as never, 'u2');
    expect(h.repo.insertTask.mock.calls[0][0]).toMatchObject({ founderApproved: false });
    await expect(hqService.sendDirectorChat({ body: 'Please look at this' }, 'u2')).resolves.toBeDefined();
  });
});

describe('escalations', () => {
  it('handling one accepts finished work and clears the flag', async () => {
    h.repo.getTask.mockImplementation(async () => h.task({ status: 'done', kind: 'task', escalated_at: h.NOW }));
    await hqService.resolveEscalation('t1', 'u1');
    expect(patchOf()).toMatchObject({ escalated_at: null, review_state: 'accepted' });
  });

  it('refuses something that is not waiting for the founder', async () => {
    await expect(hqService.resolveEscalation('t1', 'u1')).rejects.toThrow(/not waiting for you/);
  });
});

describe('director chat', () => {
  it('sends as the acting person and returns the conversation oldest first', async () => {
    h.repo.listChat.mockResolvedValueOnce([
      { id: 6, task_id: 'c1', kind: 'result', body: 'Done.', read_at: null, created_at: h.NOW, author: null, recipient: null },
      { id: 5, task_id: null, kind: 'comment', body: 'Status?', read_at: null, created_at: h.NOW, author: null, recipient: null },
    ]);
    const page = await hqService.sendDirectorChat({ body: 'Status?' }, 'u1');
    expect(h.repo.sendChat).toHaveBeenCalledWith('h1', 'Status?');
    expect(page.items.map((m) => m.id)).toEqual([5, 6]);
    expect(page.chat).toEqual({ queued: true, running: false });
  });

  it('turns a database refusal into a 400', async () => {
    h.repo.sendChat.mockRejectedValueOnce(new Error('too many messages this hour; wait a little'));
    await expect(hqService.sendDirectorChat({ body: 'hi' }, 'u1')).rejects.toMatchObject({ statusCode: 400 });
  });

  it('reading the latest page marks replies read; older pages do not', async () => {
    await hqService.directorChat({ limit: 50 }, 'u1');
    expect(h.repo.markChatRead).toHaveBeenCalledWith('d1', 'h1');
    h.repo.markChatRead.mockClear();
    await hqService.directorChat({ before: 10, limit: 50 }, 'u1');
    expect(h.repo.markChatRead).not.toHaveBeenCalled();
  });

  it('works without a director', async () => {
    h.repo.getDirector.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined);
    expect((await hqService.director('u1')).director).toBeNull();
    await expect(hqService.sendDirectorChat({ body: 'hi' }, 'u1')).rejects.toThrow(/no director/);
  });
});

describe('hardening', () => {
  it("hiring an agent keeps its tier and limits", async () => {
    await hqService.createMember(
      { slug: 'shipper', name: 'Shipper', instructions: 'Ship.', tier: 'act', effort: 'high', dailyRunLimit: 5, maxRunCents: 300 } as never,
      'u1',
    );
    expect(h.repo.insertAgentWithStandup.mock.calls[0][0]).toMatchObject({ tier: 'act', effort: 'high', dailyRunLimit: 5, maxRunCents: 300 });
  });

  it('a chat turn cannot be re-run, sent back or moved', async () => {
    h.repo.getTask.mockImplementation(async () => h.task({ kind: 'chat', status: 'done' }));
    await expect(hqService.runTask('t1', 'u1')).rejects.toThrow(/send the Director a new message/);
    await expect(hqService.rejectTask('t1', { note: 'again' }, 'u1')).rejects.toThrow(/send the Director a new message/);
    await expect(hqService.updateTask('t1', { status: 'todo' } as never, 'u1')).rejects.toThrow(/send the Director a new message/);
  });

  it('handling queued work the director assigned to an agent that changes things approves it', async () => {
    h.repo.getTask.mockImplementation(async () => h.task({ kind: 'task', status: 'todo', escalated_at: h.NOW }));
    await hqService.resolveEscalation('t1', 'u1');
    expect(patchOf()).toMatchObject({ escalated_at: null });
    expect(patchOf().founder_approved_at).toBeInstanceOf(Date);
  });
});

describe('plan status mirrors the worker gate', () => {
  it('stops at the hard share and reports the reset, urgent-only from the soft share', async () => {
    const { toPlanStatus } = await import('../../src/modules/hq/hq.service.js');
    const now = Date.parse('2026-11-10T10:00:00Z');
    const reading = (utilization: number) => ({
      five_hour: { status: 'allowed', utilization, resets_at: '2026-11-10T12:00:00Z', seen_at: '2026-11-10T09:59:00Z' },
    });
    const base = { plan_state: 'ok', plan_until: null, plan_soft_pct: 60, plan_hard_pct: 85 };
    expect(toPlanStatus({ ...base, plan_windows: reading(0.9) } as never, now)).toMatchObject({ mode: 'blocked', state: 'limit', until: '2026-11-10T12:00:00.000Z' });
    expect(toPlanStatus({ ...base, plan_windows: reading(0.7) } as never, now)).toMatchObject({ mode: 'urgent_only', state: 'ok' });
    expect(toPlanStatus({ ...base, plan_windows: reading(0.845) } as never, now)).toMatchObject({ mode: 'urgent_only' });
    expect(toPlanStatus({ ...base, plan_windows: reading(0.1) } as never, now)).toMatchObject({ mode: 'normal' });
  });
});
