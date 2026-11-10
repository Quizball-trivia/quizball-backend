import 'express-async-errors';
import { beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import { requestIdMiddleware, errorHandler } from '../../src/http/middleware/index.js';
import '../setup.js';

vi.mock('../../src/modules/hq/hq.service.js', () => ({
  assertValidCron: vi.fn(),
  assertValidTimezone: vi.fn(),
  hqService: {
    overview: vi.fn(),
    departments: vi.fn(),
    pulse: vi.fn(),
    acceptProposal: vi.fn(),
    declineProposal: vi.fn(),
    listMembers: vi.fn(),
    createMember: vi.fn(),
    getMember: vi.fn(),
    updateMember: vi.fn(),
    syncHumans: vi.fn(),
    listTasks: vi.fn(),
    createTask: vi.fn(),
    getTask: vi.fn(),
    updateTask: vi.fn(),
    approveTask: vi.fn(),
    rejectTask: vi.fn(),
    runTask: vi.fn(),
    postMessage: vi.fn(),
    listRuns: vi.fn(),
    getRun: vi.fn(),
    listEvents: vi.fn(),
    listSchedules: vi.fn(),
    createSchedule: vi.fn(),
    updateSchedule: vi.fn(),
    deleteSchedule: vi.fn(),
    runScheduleNow: vi.fn(),
    getSettings: vi.fn(),
    updateSettings: vi.fn(),
    inbox: vi.fn(),
    markInboxRead: vi.fn(),
    director: vi.fn(),
    directorChat: vi.fn(),
    sendDirectorChat: vi.fn(),
    resolveEscalation: vi.fn(),
  },
}));

vi.mock('../../src/modules/hq/hq.goals.service.js', () => ({
  hqGoalsService: { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() },
}));
vi.mock('../../src/modules/hq/hq.standup.service.js', () => ({
  hqStandupService: { standup: vi.fn(), run: vi.fn() },
}));
vi.mock('../../src/modules/hq/hq.analytics.service.js', () => ({
  hqAnalyticsService: { analytics: vi.fn(), posthog: vi.fn() },
}));

vi.mock('../../src/http/middleware/auth.js', () => ({
  authMiddleware: vi.fn((req, _res, next) => {
    req.user = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', role: 'admin' };
    req.identity = { provider: 'test', subject: 'test-sub' };
    next();
  }),
}));

vi.mock('../../src/http/middleware/require-role.js', () => ({
  requireRole: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
}));

import { adminHqRoutes } from '../../src/http/routes/admin-hq.routes.js';
import { hqService } from '../../src/modules/hq/hq.service.js';
import { ConflictError } from '../../src/core/errors.js';
import { hqGoalsService } from '../../src/modules/hq/hq.goals.service.js';
import { hqStandupService } from '../../src/modules/hq/hq.standup.service.js';
import { hqAnalyticsService } from '../../src/modules/hq/hq.analytics.service.js';

const USER = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TASK = '11111111-1111-4111-8111-111111111111';
const MEMBER = '22222222-2222-4222-8222-222222222222';
const svc = hqService as unknown as Record<string, Mock>;

describe('admin HQ routes', () => {
  let app: Express;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use(requestIdMiddleware);
    app.use('/api/v1/admin/hq', adminHqRoutes);
    app.use(errorHandler);
  });

  beforeEach(() => vi.clearAllMocks());

  it('GET /overview passes the acting user', async () => {
    svc.overview.mockResolvedValueOnce({ inboxUnread: 0 });
    const res = await request(app).get('/api/v1/admin/hq/overview');
    expect(res.status).toBe(200);
    expect(svc.overview).toHaveBeenCalledWith(USER);
  });

  describe('director', () => {
    it('summary and chat history pass the acting user; history validates paging', async () => {
      svc.director.mockResolvedValueOnce({ director: null });
      expect((await request(app).get('/api/v1/admin/hq/director')).status).toBe(200);
      expect(svc.director).toHaveBeenCalledWith(USER);
      svc.directorChat.mockResolvedValueOnce({ items: [] });
      expect((await request(app).get('/api/v1/admin/hq/director/chat?before=40&limit=20')).status).toBe(200);
      expect(svc.directorChat).toHaveBeenCalledWith({ before: 40, limit: 20 }, USER);
      expect((await request(app).get('/api/v1/admin/hq/director/chat?limit=500')).status).toBe(422);
    });

    it('sending trims and bounds the message', async () => {
      svc.sendDirectorChat.mockResolvedValueOnce({ items: [] });
      const ok = await request(app).post('/api/v1/admin/hq/director/chat').send({ body: '  how are we doing?  ' });
      expect(ok.status).toBe(201);
      expect(svc.sendDirectorChat).toHaveBeenCalledWith({ body: 'how are we doing?' }, USER);
      expect((await request(app).post('/api/v1/admin/hq/director/chat').send({ body: '   ' })).status).toBe(422);
      expect((await request(app).post('/api/v1/admin/hq/director/chat').send({ body: 'x'.repeat(8001) })).status).toBe(422);
    });

    it('resolving an escalation needs a task id', async () => {
      svc.resolveEscalation.mockResolvedValueOnce({ id: TASK });
      expect((await request(app).post(`/api/v1/admin/hq/tasks/${TASK}/resolve-escalation`)).status).toBe(200);
      expect((await request(app).post('/api/v1/admin/hq/tasks/nope/resolve-escalation')).status).toBe(422);
    });
  });

  describe('v3', () => {
    const goalsSvc = hqGoalsService as unknown as Record<string, Mock>;
    const standupSvc = hqStandupService as unknown as Record<string, Mock>;
    const analyticsSvc = hqAnalyticsService as unknown as Record<string, Mock>;

    it('GET /standup validates the date', async () => {
      standupSvc.standup.mockResolvedValue({ date: '2026-11-04' });
      expect((await request(app).get('/api/v1/admin/hq/standup')).status).toBe(200);
      expect(standupSvc.standup).toHaveBeenLastCalledWith(undefined);
      expect((await request(app).get('/api/v1/admin/hq/standup?date=2026-11-03')).status).toBe(200);
      expect(standupSvc.standup).toHaveBeenLastCalledWith('2026-11-03');
      expect((await request(app).get('/api/v1/admin/hq/standup?date=2026-13-40')).status).toBe(422);
    });

    it('POST /standup/run', async () => {
      standupSvc.run.mockResolvedValueOnce({ created: 3 });
      const res = await request(app).post('/api/v1/admin/hq/standup/run');
      expect(res.body).toEqual({ created: 3 });
      expect(standupSvc.run).toHaveBeenCalledWith(USER);
    });

    it('goals CRUD routes validate bodies', async () => {
      goalsSvc.list.mockResolvedValue({ items: [] });
      await request(app).get('/api/v1/admin/hq/goals');
      expect(goalsSvc.list).toHaveBeenLastCalledWith({ status: ['active'], limit: 50 }); // default: active only
      await request(app).get(`/api/v1/admin/hq/goals?status=achieved,dropped&limit=20&before=${MEMBER}`);
      expect(goalsSvc.list).toHaveBeenLastCalledWith({ status: ['achieved', 'dropped'], limit: 20, before: MEMBER });
      expect((await request(app).get('/api/v1/admin/hq/goals?limit=500')).status).toBe(422);
      expect((await request(app).get('/api/v1/admin/hq/goals?before=nope')).status).toBe(422);
      expect((await request(app).get('/api/v1/admin/hq/goals?status=')).status).toBe(200);
      goalsSvc.create.mockResolvedValue({ id: 'g' });
      expect(
        (await request(app).post('/api/v1/admin/hq/goals').send({ horizon: 'week', title: 'Ship', metric: 'matches', target: 500 })).status
      ).toBe(201);
      expect((await request(app).post('/api/v1/admin/hq/goals').send({ horizon: 'week', title: 'x', metric: 'matches' })).status).toBe(422);
      expect((await request(app).post('/api/v1/admin/hq/goals').send({ horizon: 'year', title: 'x' })).status).toBe(422);
      expect((await request(app).post('/api/v1/admin/hq/goals').send({ horizon: 'day', title: 'x', periodStart: '2026-02-30' })).status).toBe(422);
      goalsSvc.update.mockResolvedValue({ id: 'g' });
      expect((await request(app).patch(`/api/v1/admin/hq/goals/${MEMBER}`).send({ manualProgress: 101 })).status).toBe(422);
      expect((await request(app).patch(`/api/v1/admin/hq/goals/${MEMBER}`).send({ status: 'achieved' })).status).toBe(200);
      goalsSvc.remove.mockResolvedValue(undefined);
      expect((await request(app).delete(`/api/v1/admin/hq/goals/${MEMBER}`)).status).toBe(204);
    });

    it('proposal routes', async () => {
      svc.acceptProposal.mockResolvedValue({ id: TASK, status: 'todo' });
      expect((await request(app).post(`/api/v1/admin/hq/tasks/${TASK}/accept-proposal`)).status).toBe(200);
      expect(svc.acceptProposal).toHaveBeenLastCalledWith(TASK, {}, USER);
      expect(
        (await request(app).post(`/api/v1/admin/hq/tasks/${TASK}/accept-proposal`).send({ proposal: { effort: 'xl' } })).status
      ).toBe(422);
      svc.declineProposal.mockResolvedValue({ id: TASK, status: 'cancelled' });
      expect((await request(app).post(`/api/v1/admin/hq/tasks/${TASK}/decline-proposal`).send({ note: 'later' })).status).toBe(200);
      expect(svc.declineProposal).toHaveBeenLastCalledWith(TASK, { note: 'later' }, USER);
    });

    it("humans can't PATCH a task into 'proposed'", async () => {
      const res = await request(app).patch(`/api/v1/admin/hq/tasks/${TASK}`).send({ status: 'proposed' });
      expect(res.status).toBe(422);
      expect(svc.updateTask).not.toHaveBeenCalled();
    });

    it('GET /tasks accepts kind filters', async () => {
      svc.listTasks.mockResolvedValue({ items: [] });
      await request(app).get('/api/v1/admin/hq/tasks?kind=standup,proposal');
      expect(svc.listTasks).toHaveBeenLastCalledWith(expect.objectContaining({ kind: ['standup', 'proposal'] }));
      expect((await request(app).get('/api/v1/admin/hq/tasks?kind=meeting')).status).toBe(422);
    });

    it('analytics routes bound the window', async () => {
      analyticsSvc.analytics.mockResolvedValue({ days: 30 });
      analyticsSvc.posthog.mockResolvedValue({ connected: false });
      expect((await request(app).get('/api/v1/admin/hq/analytics')).status).toBe(200);
      expect(analyticsSvc.analytics).toHaveBeenLastCalledWith(30);
      expect((await request(app).get('/api/v1/admin/hq/analytics?days=90')).status).toBe(200);
      expect((await request(app).get('/api/v1/admin/hq/analytics?days=365')).status).toBe(422);
      const ph = await request(app).get('/api/v1/admin/hq/analytics/posthog?days=7');
      expect(ph.body).toEqual({ connected: false });
      expect(analyticsSvc.posthog).toHaveBeenCalledWith(7);
    });
  });

  it('GET /departments', async () => {
    svc.departments.mockResolvedValueOnce({ items: [] });
    const res = await request(app).get('/api/v1/admin/hq/departments');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [] });
  });

  it('GET /pulse defaults to 14 days and bounds the window', async () => {
    svc.pulse.mockResolvedValue({ days: 14 });
    expect((await request(app).get('/api/v1/admin/hq/pulse')).status).toBe(200);
    expect(svc.pulse).toHaveBeenLastCalledWith(14);
    await request(app).get('/api/v1/admin/hq/pulse?days=30');
    expect(svc.pulse).toHaveBeenLastCalledWith(30);
    expect((await request(app).get('/api/v1/admin/hq/pulse?days=7')).status).toBe(422);
    expect((await request(app).get('/api/v1/admin/hq/pulse?days=91')).status).toBe(422);
  });

  it('GET /tasks validates the department filter', async () => {
    svc.listTasks.mockResolvedValueOnce({ items: [] });
    expect((await request(app).get('/api/v1/admin/hq/tasks?department=growth')).status).toBe(200);
    expect(svc.listTasks).toHaveBeenCalledWith(expect.objectContaining({ department: 'growth' }));
    expect((await request(app).get('/api/v1/admin/hq/tasks?department=sales')).status).toBe(422);
  });

  it('members accept a known department only', async () => {
    svc.updateMember.mockResolvedValueOnce({ id: MEMBER });
    expect((await request(app).patch(`/api/v1/admin/hq/members/${MEMBER}`).send({ department: 'content' })).status).toBe(200);
    expect((await request(app).patch(`/api/v1/admin/hq/members/${MEMBER}`).send({ department: 'sales' })).status).toBe(422);
  });

  it('GET /tasks parses comma-separated statuses and limit', async () => {
    svc.listTasks.mockResolvedValueOnce({ items: [] });
    const res = await request(app).get(`/api/v1/admin/hq/tasks?status=todo,needs_approval&assigneeId=${MEMBER}&limit=20`);
    expect(res.status).toBe(200);
    expect(svc.listTasks).toHaveBeenCalledWith(
      expect.objectContaining({ status: ['todo', 'needs_approval'], assigneeId: MEMBER, limit: 20 })
    );
  });

  it('GET /tasks rejects unknown statuses with 422', async () => {
    const res = await request(app).get('/api/v1/admin/hq/tasks?status=todo,nope');
    expect(res.status).toBe(422);
    expect(svc.listTasks).not.toHaveBeenCalled();
  });

  it('POST /tasks validates and returns 201', async () => {
    svc.createTask.mockResolvedValueOnce({ id: TASK });
    const ok = await request(app).post('/api/v1/admin/hq/tasks').send({ title: 'Plan posts', assigneeId: MEMBER, priority: 1 });
    expect(ok.status).toBe(201);
    expect(svc.createTask).toHaveBeenCalledWith(expect.objectContaining({ title: 'Plan posts', priority: 1 }), USER);

    const bad = await request(app).post('/api/v1/admin/hq/tasks').send({ title: '', status: 'done' });
    expect(bad.status).toBe(422);
  });

  it('POST /tasks/:id/approve works without a body', async () => {
    svc.approveTask.mockResolvedValueOnce({ id: TASK, status: 'done' });
    const res = await request(app).post(`/api/v1/admin/hq/tasks/${TASK}/approve`);
    expect(res.status).toBe(200);
    expect(svc.approveTask).toHaveBeenCalledWith(TASK, {}, USER);
  });

  it('POST /tasks/:id/reject requires a note', async () => {
    const res = await request(app).post(`/api/v1/admin/hq/tasks/${TASK}/reject`).send({});
    expect(res.status).toBe(422);
  });

  it('maps service conflicts to 409', async () => {
    svc.runTask.mockRejectedValueOnce(new ConflictError('This task is already running'));
    const res = await request(app).post(`/api/v1/admin/hq/tasks/${TASK}/run`);
    expect(res.status).toBe(409);
  });

  it('rejects non-uuid ids', async () => {
    const res = await request(app).get('/api/v1/admin/hq/tasks/not-a-uuid');
    expect(res.status).toBe(422);
  });

  it('POST /members validates the slug', async () => {
    const bad = await request(app).post('/api/v1/admin/hq/members').send({ slug: 'Bad Slug', name: 'X', instructions: 'y' });
    expect(bad.status).toBe(422);
    svc.createMember.mockResolvedValueOnce({ id: MEMBER });
    const ok = await request(app)
      .post('/api/v1/admin/hq/members')
      .send({ slug: 'seo-writer', name: 'SEO Writer', instructions: 'Write', tools: ['web'] });
    expect(ok.status).toBe(201);
  });

  it('PATCH /members/:id rejects unknown tool groups', async () => {
    const res = await request(app).patch(`/api/v1/admin/hq/members/${MEMBER}`).send({ tools: ['bash'] });
    expect(res.status).toBe(422);
  });

  it('GET /members coerces includeArchived', async () => {
    svc.listMembers.mockResolvedValueOnce({ items: [] });
    await request(app).get('/api/v1/admin/hq/members?includeArchived=true');
    expect(svc.listMembers).toHaveBeenCalledWith(true);
  });

  it('DELETE /schedules/:id returns 204', async () => {
    svc.deleteSchedule.mockResolvedValueOnce(undefined);
    const res = await request(app).delete(`/api/v1/admin/hq/schedules/${TASK}`);
    expect(res.status).toBe(204);
  });

  it('PATCH /settings rejects an empty body and bounds concurrency', async () => {
    expect((await request(app).patch('/api/v1/admin/hq/settings').send({})).status).toBe(422);
    expect((await request(app).patch('/api/v1/admin/hq/settings').send({ maxConcurrentRuns: 50 })).status).toBe(422);
    svc.updateSettings.mockResolvedValueOnce({ paused: true });
    const ok = await request(app).patch('/api/v1/admin/hq/settings').send({ paused: true, pausedReason: 'night' });
    expect(ok.status).toBe(200);
  });

  it('POST /inbox/read accepts no body (mark all)', async () => {
    svc.markInboxRead.mockResolvedValueOnce(undefined);
    const res = await request(app).post('/api/v1/admin/hq/inbox/read');
    expect(res.status).toBe(204);
    expect(svc.markInboxRead).toHaveBeenCalledWith(undefined, USER);
  });
});
