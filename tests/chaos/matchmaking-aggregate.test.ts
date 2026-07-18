import { describe, expect, it } from 'vitest';

import { aggregateMatchmakingReports } from '../../scripts/chaos/matchmaking-aggregate.js';
import type { MatchmakingFleetSummary } from '../../scripts/chaos/matchmaking-fleet.js';

function worker(userStart: number, clients: number): {
  target: string;
  pairValidation: string;
  fleet: MatchmakingFleetSummary;
  verdict: { ok: boolean; violations: string[] };
} {
  const pairObservations = Array.from({ length: clients }, (_, index) => {
    const user = userStart + index;
    const opponent = user % 2 === 0 ? user + 1 : user - 1;
    return { userId: `u${user}`, opponentId: `u${opponent}`, lobbyId: `l${user - user % 2}` };
  });
  return {
    target: 'staging',
    pairValidation: 'deferred_to_aggregate',
    verdict: { ok: true, violations: [] },
    fleet: {
      startedAt: new Date(0).toISOString(),
      endedAt: new Date(1_000).toISOString(),
      elapsedSec: 1,
      clients,
      connectedClients: clients,
      searchStartedClients: clients,
      humanMatchedClients: clients,
      humanPairs: clients / 2,
      aiFallbackClients: 0,
      unmatchedClients: 0,
      duplicateMatchFoundClients: 0,
      selfMatchedClients: 0,
      invalidPairClients: 0,
      cleanupUnconfirmedClients: 0,
      matchFoundLatencyMs: Array(clients).fill(500),
      pairObservations,
      percentiles: { count: clients, p50: 500, p95: 500, p99: 500, max: 500 },
      errorHistogram: {},
      failures: [],
    },
  };
}

describe('distributed matchmaking aggregate', () => {
  it('proves reciprocal pairs even when opponents are split across workers', () => {
    const a = worker(0, 2);
    const b = worker(2, 2);
    // Split each pair across the two workers to exercise cross-worker proof.
    a.fleet.pairObservations = [
      { userId: 'u0', opponentId: 'u1', lobbyId: 'l0' },
      { userId: 'u2', opponentId: 'u3', lobbyId: 'l2' },
    ];
    b.fleet.pairObservations = [
      { userId: 'u1', opponentId: 'u0', lobbyId: 'l0' },
      { userId: 'u3', opponentId: 'u2', lobbyId: 'l2' },
    ];
    expect(aggregateMatchmakingReports([a, b], 4)).toMatchObject({
      humanMatchedClients: 4,
      humanPairs: 2,
      verdict: { ok: true, violations: [] },
    });
  });

  it('fails a missing reciprocal observation and duplicate user shard', () => {
    const a = worker(0, 2);
    const b = worker(2, 2);
    b.fleet.pairObservations[0] = { ...a.fleet.pairObservations[0]! };
    const aggregate = aggregateMatchmakingReports([a, b], 4);
    expect(aggregate.verdict.ok).toBe(false);
    expect(aggregate.verdict.violations.join(' ')).toContain('duplicate user ids');
    expect(aggregate.verdict.violations.join(' ')).toContain('unique clients');
  });
});
