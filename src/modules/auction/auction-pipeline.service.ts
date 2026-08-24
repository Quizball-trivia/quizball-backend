import { auctionPipelineRepo } from './auction-pipeline.repo.js';
import { logAudit } from '../activity/audit.js';
import type {
  AuctionPipelinePrompt,
  AuctionPipelinePromptKey,
  AuctionPipelinePromptMode,
  AuctionPipelineStageCount,
  AuctionPipelineStats,
  AuctionPipelineWorker,
} from './auction-pipeline.types.js';

const TERMINAL_STAGES = ['published', 'rejected', 'failed'] as const;

/** Suffix the runner uses for the read-only assembled prompt text. */
const EFFECTIVE_SUFFIX = ':effective';

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
      recent2h,
      recent24h,
    ] = await Promise.all([
      auctionPipelineRepo.getTaskStageCounts(),
      auctionPipelineRepo.getTaskVariantCounts(),
      auctionPipelineRepo.getVariantCardStatusCounts(),
      auctionPipelineRepo.getAttemptTotals(),
      auctionPipelineRepo.getAttemptErrorClasses(),
      auctionPipelineRepo.getRecentFailures(),
      auctionPipelineRepo.getLatestSnapshot(),
      auctionPipelineRepo.getPoolCounts(),
      auctionPipelineRepo.getRecentOutcomes(2),
      auctionPipelineRepo.getRecentOutcomes(24),
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
        recent_pass_rates: [
          { hours: 2, ...recent2h, pass_rate: ratio(recent2h.published, recent2h.terminal) },
          { hours: 24, ...recent24h, pass_rate: ratio(recent24h.published, recent24h.terminal) },
        ],
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

  async listWorkers(): Promise<{ workers: AuctionPipelineWorker[]; live: number; stale: number }> {
    const workers = await auctionPipelineRepo.listWorkers();
    const stale = workers.filter((worker) => worker.is_stale).length;

    return { workers, live: workers.length - stale, stale };
  },

  /**
   * Splits the table into operator-editable overrides and the runner-published
   * read-only text, so the CMS never renders an ':effective' row as editable.
   */
  async listPrompts(): Promise<{
    items: AuctionPipelinePrompt[];
    effective: Record<string, AuctionPipelinePrompt>;
  }> {
    const rows = await auctionPipelineRepo.listPrompts();
    const items: AuctionPipelinePrompt[] = [];
    const effective: Record<string, AuctionPipelinePrompt> = {};

    for (const row of rows) {
      if (row.key.endsWith(EFFECTIVE_SUFFIX)) {
        effective[row.key.slice(0, -EFFECTIVE_SUFFIX.length)] = row;
      } else {
        items.push(row);
      }
    }

    return { items, effective };
  },

  async savePrompt(
    key: AuctionPipelinePromptKey,
    text: string,
    mode: AuctionPipelinePromptMode,
    userId: string
  ): Promise<AuctionPipelinePrompt> {
    const prompt = await auctionPipelineRepo.upsertPrompt(key, text, mode, userId);

    logAudit({
      userId,
      action: 'update',
      entityType: 'auction_pipeline_prompt',
      entityId: key,
      metadata: { chars: text.length, mode },
    });

    return prompt;
  },

  /** Remove an override so the built-in rules apply again. */
  async resetPrompt(key: AuctionPipelinePromptKey, userId: string): Promise<{ reset: boolean }> {
    const reset = await auctionPipelineRepo.deletePrompt(key);

    if (reset) {
      logAudit({
        userId,
        action: 'reset',
        entityType: 'auction_pipeline_prompt',
        entityId: key,
      });
    }

    return { reset };
  },

  async requeueTasks(
    params: { taskIds?: string[]; filter?: 'failed' | 'rejected' },
    userId: string
  ): Promise<{ requeued: number }> {
    const requeued = await auctionPipelineRepo.requeueTasks(params);

    logAudit({
      userId,
      action: 'requeue',
      entityType: 'auction_pipeline_task',
      metadata: {
        requeued,
        ...(params.taskIds ? { task_ids: params.taskIds.length } : { filter: params.filter }),
      },
    });

    return { requeued };
  },
};
