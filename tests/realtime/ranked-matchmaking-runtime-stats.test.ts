import { describe, expect, it } from 'vitest';
import { RankedMatchmakingRuntimeTracker } from '../../src/realtime/ranked-matchmaking-runtime-stats.js';

describe('ranked matchmaking runtime diagnostics', () => {
  it('reports per-stage percentiles and process-local concurrency peaks', () => {
    const tracker = new RankedMatchmakingRuntimeTracker();
    tracker.recordQueueDepth(12);
    tracker.recordQueueDepth(4);
    tracker.pairClaimed();
    tracker.pairStarted();
    tracker.pairStarted();
    tracker.recordStage('lobby_create', 10);
    tracker.recordStage('lobby_create', 20);
    tracker.recordStage('lobby_create', 30);
    tracker.recordStage('lobby_create', 40);
    tracker.pairFinished('completed');
    tracker.pairFinished('failed');

    expect(tracker.stats()).toEqual({
      queueDepth: 4,
      peakQueueDepth: 12,
      activePairStarts: 0,
      peakActivePairStarts: 2,
      pairsClaimed: 1,
      pairsCompleted: 1,
      pairsSkipped: 0,
      pairsFailed: 1,
      stages: {
        lobby_create: {
          count: 4,
          p50Ms: 20,
          p95Ms: 40,
          p99Ms: 40,
          maxMs: 40,
        },
      },
    });
  });
});
