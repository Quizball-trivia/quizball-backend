import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../setup.js';

// Every repo call is tracked: it increments an in-flight counter, waits a few
// ms, then resolves with a plausible default. Peak in-flight must never exceed
// HQ_DB_CONCURRENCY for any HQ endpoint.
const track = vi.hoisted(() => {
  const NOW = new Date('2026-11-04T08:00:00Z');
  const member = {
    id: 'm1', slug: 'ops', kind: 'agent', user_id: null, name: 'Ops', title: '', avatar: '🤖', color: 'slate',
    description: '', instructions: '', model: null, tools: [], autonomy: 'autonomous', runtime: 'hq', status: 'active',
    department: 'leadership', max_turns: 25, last_active_at: null, created_at: NOW, updated_at: NOW,
    open_tasks: 0, runs_today: 0, cost_today_cents: 0, current_task: null, last_run: null,
  };
  const task = {
    id: 't1', number: '1', title: 'T', body: '', status: 'todo', priority: 2, assignee_id: null, created_by_id: null,
    parent_id: null, depth: 0, schedule_id: null, result: null, position: 1, attempts: 0, claimed_by: null,
    claimed_at: null, claim_token: null, kind: 'task', goal_id: null, proposal: null, due_at: null, completed_at: null,
    created_at: NOW, updated_at: NOW, assignee: null, created_by: null, assignee_runtime: null, assignee_status: null,
    assignee_department: null, message_count: 0,
  };
  const defaults: Record<string, unknown> = {
    getMemberByUserId: { ...member, id: 'h1', kind: 'human', runtime: 'none' },
    getMemberWithStats: member,
    getTask: task,
    getSettings: {
      paused: false, paused_reason: null, daily_limit_cents: 0, daily_run_limit: 0, max_concurrent_runs: 2,
      updated_at: NOW, runs_today: 0, cost_today_cents: 0,
    },
    todayStats: { runs: 0, cost_cents: 0, failed_runs: 0, tasks_created: 0, tasks_done: 0 },
    countUnread: 0,
    latestDoneTaskFor: undefined,
    externalStats: null,
    pulse: {
      metrics: { generated_at: NOW.toISOString(), timezone: 'Asia/Tbilisi', days: 14, total_registered_users: 0,
        new_users_by_day: {}, matches_by_day: {}, active_players_by_day: {} },
      feedback: { count_7d: 0, avg_rating_7d: null, low_ratings_7d: 0, count_prev_7d: 0, avg_rating_prev_7d: null },
    },
    ratingSummary: { avg: null, low: 0 },
  };
  const state = { inFlight: 0, peak: 0, calls: 0 };
  const make = () =>
    new Proxy({} as Record<string, unknown>, {
      get: (_t, name: string) => async () => {
        state.calls++;
        state.inFlight++;
        state.peak = Math.max(state.peak, state.inFlight);
        await new Promise((r) => setTimeout(r, 3));
        state.inFlight--;
        return name in defaults ? defaults[name] : [];
      },
    });
  return { state, hqRepo: make(), goalsRepo: make(), goalsAnalytics: make(), NOW };
});

vi.mock('../../src/modules/hq/hq.repo.js', () => ({ hqRepo: track.hqRepo }));
vi.mock('../../src/modules/hq/hq.goals.repo.js', () => ({
  hqGoalsRepo: track.goalsRepo,
  hqGoalsAnalyticsRepo: track.goalsAnalytics,
  isUniqueViolation: () => false,
}));

const { boundedAll, HQ_DB_CONCURRENCY } = await import('../../src/modules/hq/hq.concurrency.js');
const { hqService } = await import('../../src/modules/hq/hq.service.js');
const { hqStandupService } = await import('../../src/modules/hq/hq.standup.service.js');

beforeEach(() => {
  track.state.inFlight = 0;
  track.state.peak = 0;
  track.state.calls = 0;
});

describe('boundedAll', () => {
  it('keeps order, never exceeds the limit, and propagates errors', async () => {
    let inFlight = 0;
    let peak = 0;
    const job = (v: number, ms: number) => async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, ms));
      inFlight--;
      return v;
    };
    const out = await boundedAll([job(1, 8), job(2, 1), job(3, 4), job(4, 1), job(5, 2)], 2);
    expect(out).toEqual([1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
    await expect(boundedAll([job(1, 1), async () => { throw new Error('boom'); }], 2)).rejects.toThrow('boom');
    expect(HQ_DB_CONCURRENCY).toBe(2);
  });
});

describe(`HQ endpoints keep at most ${2} DB queries in flight`, () => {
  it.each([
    ['overview', () => hqService.overview('u1')],
    ['departments', () => hqService.departments()],
    ['member detail', () => hqService.getMember('m1')],
    ['task detail', () => hqService.getTask('t1')],
    ['standup', () => hqStandupService.standup(undefined, track.NOW)],
  ])('%s', async (_name, run) => {
    await run();
    expect(track.state.calls).toBeGreaterThan(3); // it really issues several queries
    expect(track.state.peak).toBeLessThanOrEqual(2);
  });
});
