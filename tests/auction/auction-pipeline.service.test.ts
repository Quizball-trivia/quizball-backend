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
  },
}));

import { auctionPipelineService } from '../../src/modules/auction/auction-pipeline.service.js';
import { auctionPipelineRepo } from '../../src/modules/auction/auction-pipeline.repo.js';

function mockRepo(overrides: {
  stages?: { stage: string; count: number }[];
  pool?: { eligible_players: number; players_with_published_card: number };
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
