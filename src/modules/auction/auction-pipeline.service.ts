import { auctionPipelineRepo } from './auction-pipeline.repo.js';
import type { AuctionPipelineStageCount, AuctionPipelineStats } from './auction-pipeline.types.js';

const TERMINAL_STAGES = ['published', 'rejected', 'failed'] as const;

function stageCount(stages: AuctionPipelineStageCount[], stage: string): number {
  return stages.find((entry) => entry.stage === stage)?.count ?? 0;
}

function ratio(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 1000) / 1000;
}

export const auctionPipelineService = {
  async getStats(): Promise<AuctionPipelineStats> {
    const [
      stages,
      variants,
      cards,
      attemptTotals,
      errorClasses,
      recentFailures,
      latestSnapshot,
      pool,
    ] = await Promise.all([
      auctionPipelineRepo.getTaskStageCounts(),
      auctionPipelineRepo.getTaskVariantCounts(),
      auctionPipelineRepo.getVariantCardStatusCounts(),
      auctionPipelineRepo.getAttemptTotals(),
      auctionPipelineRepo.getAttemptErrorClasses(),
      auctionPipelineRepo.getRecentFailures(),
      auctionPipelineRepo.getLatestSnapshot(),
      auctionPipelineRepo.getPoolCounts(),
    ]);

    const totalTasks = stages.reduce((sum, entry) => sum + entry.count, 0);
    const publishedFamilies = stageCount(stages, 'published');
    const rejectedFamilies = stageCount(stages, 'rejected');
    const failedFamilies = stageCount(stages, 'failed');
    const terminalFamilies = TERMINAL_STAGES.reduce(
      (sum, stage) => sum + stageCount(stages, stage),
      0
    );

    const playersDone = pool.players_with_published_card;
    const playersRemaining = Math.max(pool.eligible_players - playersDone, 0);

    return {
      generated_at: new Date().toISOString(),
      totals: {
        total_tasks: totalTasks,
        terminal_families: terminalFamilies,
        published_families: publishedFamilies,
        rejected_families: rejectedFamilies,
        failed_families: failedFamilies,
        pass_rate: ratio(publishedFamilies, terminalFamilies),
        eligible_players: pool.eligible_players,
        players_done: playersDone,
        players_remaining: playersRemaining,
        completion_rate: ratio(playersDone, pool.eligible_players),
      },
      stages,
      variants,
      cards,
      attempts_24h: {
        total: attemptTotals.total,
        success: attemptTotals.success,
        rejected: attemptTotals.rejected,
        failed: attemptTotals.failed,
        by_error_class: errorClasses,
      },
      recent_failures: recentFailures,
      latest_snapshot: latestSnapshot,
    };
  },
};
