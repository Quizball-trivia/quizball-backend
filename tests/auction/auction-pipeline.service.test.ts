import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import '../setup.js';

vi.mock('../../src/modules/auction/auction-pipeline.repo.js', () => ({
  auctionPipelineRepo: {
    getTaskStageCounts: vi.fn(),
    getTaskVariantCounts: vi.fn(),
    getVariantCardStatusCounts: vi.fn(),
    getAttemptTotals: vi.fn(),
    getAttemptErrorClasses: vi.fn(),
    getRecentFailures: vi.fn(),
    getLatestSnapshot: vi.fn(),
    getPoolCounts: vi.fn(),
    listWorkers: vi.fn(),
    listPrompts: vi.fn(),
    getRecentOutcomes: vi.fn(),
    upsertPrompt: vi.fn(),
    requeueTasks: vi.fn(),
  },
}));

vi.mock('../../src/modules/activity/audit.js', () => ({
  logAudit: vi.fn(),
}));

import { auctionPipelineService } from '../../src/modules/auction/auction-pipeline.service.js';
import { auctionPipelineRepo } from '../../src/modules/auction/auction-pipeline.repo.js';
import { logAudit } from '../../src/modules/activity/audit.js';

const ADMIN_USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

function mockRepo(overrides: {
  stages?: { stage: string; count: number }[];
  pool?: { eligible_players: number; players_with_published_card: number };
  recent2h?: { published: number; terminal: number };
  recent24h?: { published: number; terminal: number };
} = {}) {
  (auctionPipelineRepo.getTaskStageCounts as Mock).mockResolvedValue(
    overrides.stages ?? [
      { stage: 'queued', count: 3616 },
      { stage: 'published', count: 149 },
      { stage: 'rejected', count: 153 },
      { stage: 'failed', count: 35 },
    ]
  );
  (auctionPipelineRepo.getTaskVariantCounts as Mock).mockResolvedValue([]);
  (auctionPipelineRepo.getVariantCardStatusCounts as Mock).mockResolvedValue({
    published: 306,
    needs_review: 8,
    superseded: 0,
    rejected: 0,
    published_families: 153,
  });
  (auctionPipelineRepo.getAttemptTotals as Mock).mockResolvedValue({
    total: 10,
    success: 8,
    rejected: 1,
    failed: 1,
  });
  (auctionPipelineRepo.getAttemptErrorClasses as Mock).mockResolvedValue([]);
  (auctionPipelineRepo.getRecentFailures as Mock).mockResolvedValue([]);
  (auctionPipelineRepo.getLatestSnapshot as Mock).mockResolvedValue(null);
  (auctionPipelineRepo.getPoolCounts as Mock).mockResolvedValue(
    overrides.pool ?? { eligible_players: 1979, players_with_published_card: 153 }
  );
  (auctionPipelineRepo.getRecentOutcomes as Mock)
    .mockResolvedValueOnce(overrides.recent2h ?? { published: 24, terminal: 47 })
    .mockResolvedValueOnce(overrides.recent24h ?? { published: 97, terminal: 308 });
}

describe('auctionPipelineService.getStats', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('derives pass rate from terminal families only', async () => {
    mockRepo();

    const stats = await auctionPipelineService.getStats();

    expect(stats.totals.total_tasks).toBe(3953);
    expect(stats.totals.terminal_families).toBe(337);
    expect(stats.totals.pass_rate).toBe(0.442);
  });

  it('derives players remaining from the eligible pool', async () => {
    mockRepo();

    const stats = await auctionPipelineService.getStats();

    expect(stats.totals.players_done).toBe(153);
    expect(stats.totals.players_remaining).toBe(1826);
    expect(stats.totals.completion_rate).toBe(0.077);
  });

  it('returns null rates instead of dividing by zero', async () => {
    mockRepo({
      stages: [{ stage: 'queued', count: 5 }],
      pool: { eligible_players: 0, players_with_published_card: 0 },
    });

    const stats = await auctionPipelineService.getStats();

    expect(stats.totals.pass_rate).toBeNull();
    expect(stats.totals.completion_rate).toBeNull();
    expect(stats.totals.players_remaining).toBe(0);
  });

  it('never reports negative players remaining', async () => {
    mockRepo({ pool: { eligible_players: 10, players_with_published_card: 25 } });

    const stats = await auctionPipelineService.getStats();

    expect(stats.totals.players_remaining).toBe(0);
  });
});

describe('auctionPipelineService recent pass rates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports a recent window rate distinct from all-time', async () => {
    mockRepo();

    const stats = await auctionPipelineService.getStats();
    const [twoHour, dayLong] = stats.totals.recent_pass_rates;

    expect(twoHour.hours).toBe(2);
    expect(twoHour.pass_rate).toBe(0.511);
    expect(dayLong.hours).toBe(24);
    expect(dayLong.pass_rate).toBe(0.315);
    // The recent window must not be dragged down by the all-time figure.
    expect(twoHour.pass_rate!).toBeGreaterThan(stats.totals.pass_rate!);
  });

  it('returns a null window rate when nothing completed in the window', async () => {
    mockRepo({ recent2h: { published: 0, terminal: 0 } });

    const stats = await auctionPipelineService.getStats();

    expect(stats.totals.recent_pass_rates[0].pass_rate).toBeNull();
  });
});

describe('auctionPipelineService.listPrompts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('splits editable overrides from runner-published effective text', async () => {
    (auctionPipelineRepo.listPrompts as Mock).mockResolvedValue([
      { key: 'generator_rules', text: 'extra', updated_at: 'x', updated_by: 'admin' },
      { key: 'generator_rules:effective', text: 'full', updated_at: 'x', updated_by: 'runner' },
      { key: 'judge_rules:effective', text: 'judge', updated_at: 'x', updated_by: 'runner' },
    ]);

    const result = await auctionPipelineService.listPrompts();

    expect(result.items).toHaveLength(1);
    expect(result.items[0].key).toBe('generator_rules');
    expect(Object.keys(result.effective).sort()).toEqual(['generator_rules', 'judge_rules']);
    expect(result.effective.generator_rules.text).toBe('full');
  });
});

describe('auctionPipelineService.listWorkers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('splits live and stale worker counts', async () => {
    (auctionPipelineRepo.listWorkers as Mock).mockResolvedValue([
      { worker_id: 'a', is_stale: false },
      { worker_id: 'b', is_stale: true },
      { worker_id: 'c', is_stale: false },
    ]);

    const result = await auctionPipelineService.listWorkers();

    expect(result.live).toBe(2);
    expect(result.stale).toBe(1);
    expect(result.workers).toHaveLength(3);
  });

  it('handles an empty roster', async () => {
    (auctionPipelineRepo.listWorkers as Mock).mockResolvedValue([]);

    const result = await auctionPipelineService.listWorkers();

    expect(result).toEqual({ workers: [], live: 0, stale: 0 });
  });
});

describe('auctionPipelineService.savePrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('persists the override and writes an audit entry', async () => {
    (auctionPipelineRepo.upsertPrompt as Mock).mockResolvedValue({
      key: 'judge_rules',
      text: 'Be strict.',
      updated_at: '2026-07-28T00:00:00.000Z',
      updated_by: ADMIN_USER_ID,
    });

    await auctionPipelineService.savePrompt('judge_rules', 'Be strict.', ADMIN_USER_ID);

    expect(auctionPipelineRepo.upsertPrompt).toHaveBeenCalledWith(
      'judge_rules',
      'Be strict.',
      ADMIN_USER_ID
    );
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: ADMIN_USER_ID,
        action: 'update',
        entityType: 'auction_pipeline_prompt',
        entityId: 'judge_rules',
      })
    );
  });
});

describe('auctionPipelineService.requeueTasks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the requeued count and audits the filter used', async () => {
    (auctionPipelineRepo.requeueTasks as Mock).mockResolvedValue(7);

    const result = await auctionPipelineService.requeueTasks({ filter: 'failed' }, ADMIN_USER_ID);

    expect(result).toEqual({ requeued: 7 });
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'requeue',
        entityType: 'auction_pipeline_task',
        metadata: expect.objectContaining({ requeued: 7, filter: 'failed' }),
      })
    );
  });

  it('audits the task-id count rather than the ids themselves', async () => {
    (auctionPipelineRepo.requeueTasks as Mock).mockResolvedValue(2);

    await auctionPipelineService.requeueTasks({ taskIds: ['a', 'b'] }, ADMIN_USER_ID);

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ requeued: 2, task_ids: 2 }),
      })
    );
  });
});
