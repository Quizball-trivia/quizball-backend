export const RANKED_MATCHMAKING_STAGES = [
  'pair_claim_redis',
  'queue_wait_to_claim',
  'pair_start_slot_wait',
  'pairing_marker_set',
  'cancel_check_initial',
  'socket_presence_initial',
  'users_lookup',
  'profiles_lookup',
  'wallets_lookup',
  'cancel_check_pre_lobby',
  'session_state_preflight',
  'socket_presence_pre_lobby',
  'lobby_create',
  'socket_lobby_attach',
  'assignment_markers',
  'lobby_state_emit',
  'recent_form_lookup',
  'match_found_emit',
  'draft_schedule',
  'pairing_marker_clear',
  'claim_to_match_found',
] as const;

export type RankedMatchmakingStage = typeof RANKED_MATCHMAKING_STAGES[number];
export type RankedPairOutcome = 'completed' | 'skipped' | 'failed';

export interface RankedStageStats {
  count: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

export interface RankedMatchmakingRuntimeStats {
  queueDepth: number;
  peakQueueDepth: number;
  activePairStarts: number;
  peakActivePairStarts: number;
  pairsClaimed: number;
  pairsCompleted: number;
  pairsSkipped: number;
  pairsFailed: number;
  stages: Partial<Record<RankedMatchmakingStage, RankedStageStats>>;
}

const MAX_SAMPLES_PER_STAGE = 10_000;

function rounded(value: number): number {
  return Math.round(value * 10) / 10;
}

function percentile(sorted: number[], ratio: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.max(0, Math.ceil(sorted.length * ratio) - 1);
  return rounded(sorted[index] ?? 0);
}

/**
 * Process-local, bounded diagnostic telemetry for ranked matchmaking.
 *
 * OpenTelemetry remains the long-term metrics sink. This tracker also exposes
 * exact per-replica stage percentiles through /health/db so a short staging
 * capacity run can produce a self-contained report without requiring a
 * separate observability subscription.
 */
export class RankedMatchmakingRuntimeTracker {
  private queueDepth = 0;
  private peakQueueDepth = 0;
  private activePairStarts = 0;
  private peakActivePairStarts = 0;
  private pairsClaimed = 0;
  private pairsCompleted = 0;
  private pairsSkipped = 0;
  private pairsFailed = 0;
  private readonly stageSamples = new Map<RankedMatchmakingStage, number[]>();

  recordQueueDepth(depth: number): void {
    this.queueDepth = Math.max(0, Math.floor(depth));
    this.peakQueueDepth = Math.max(this.peakQueueDepth, this.queueDepth);
  }

  pairClaimed(): void {
    this.pairsClaimed += 1;
  }

  pairStarted(): void {
    this.activePairStarts += 1;
    this.peakActivePairStarts = Math.max(this.peakActivePairStarts, this.activePairStarts);
  }

  pairFinished(outcome: RankedPairOutcome): void {
    this.activePairStarts = Math.max(0, this.activePairStarts - 1);
    if (outcome === 'completed') this.pairsCompleted += 1;
    else if (outcome === 'skipped') this.pairsSkipped += 1;
    else this.pairsFailed += 1;
  }

  recordStage(stage: RankedMatchmakingStage, durationMs: number): void {
    const samples = this.stageSamples.get(stage) ?? [];
    samples.push(Math.max(0, durationMs));
    if (samples.length > MAX_SAMPLES_PER_STAGE) {
      samples.splice(0, samples.length - MAX_SAMPLES_PER_STAGE);
    }
    this.stageSamples.set(stage, samples);
  }

  stats(): RankedMatchmakingRuntimeStats {
    const stages: RankedMatchmakingRuntimeStats['stages'] = {};
    for (const [stage, samples] of this.stageSamples) {
      const sorted = [...samples].sort((a, b) => a - b);
      stages[stage] = {
        count: sorted.length,
        p50Ms: percentile(sorted, 0.5),
        p95Ms: percentile(sorted, 0.95),
        p99Ms: percentile(sorted, 0.99),
        maxMs: rounded(sorted.at(-1) ?? 0),
      };
    }
    return {
      queueDepth: this.queueDepth,
      peakQueueDepth: this.peakQueueDepth,
      activePairStarts: this.activePairStarts,
      peakActivePairStarts: this.peakActivePairStarts,
      pairsClaimed: this.pairsClaimed,
      pairsCompleted: this.pairsCompleted,
      pairsSkipped: this.pairsSkipped,
      pairsFailed: this.pairsFailed,
      stages,
    };
  }
}

export const rankedMatchmakingRuntimeTracker = new RankedMatchmakingRuntimeTracker();
