import { describe, expect, it } from 'vitest';
import { aggregateFriendlyReports } from '../../scripts/chaos/friendly-aggregate.js';

function worker(offset: number) {
  return {
    target: 'staging',
    fleet: {
      clients: 2,
      pairs: 1,
      connectedClients: 2,
      lobbiesCreated: 1,
      joinedPairs: 1,
      matchesStarted: 1,
      matchesCompleted: 1,
      clientsReceivingFinalResults: 2,
      socketErrors: 0,
      failureCount: 0,
      failures: [],
      latenciesMs: {
        connectToLobbyReady: [100 + offset],
        lobbyCreateToMatchStart: [200 + offset],
        matchStartToFinalResults: [300 + offset],
      },
    },
    verdict: { ok: true, violations: [] },
  };
}

describe('distributed friendly-party aggregate', () => {
  it('requires every client to create, join, play, and receive final results', () => {
    const result = aggregateFriendlyReports([worker(0), worker(10)], 4);
    expect(result).toMatchObject({
      clients: 4,
      pairs: 2,
      connectedClients: 4,
      lobbiesCreated: 2,
      joinedPairs: 2,
      matchesStarted: 2,
      matchesCompleted: 2,
      clientsReceivingFinalResults: 4,
      latencyMs: {
        connectToLobbyReadyP95: 110,
        lobbyCreateToMatchStartP95: 210,
        matchStartToFinalResultsP95: 310,
      },
      verdict: { ok: true, violations: [] },
    });
  });

  it('fails a missing final result even if the worker claimed green', () => {
    const first = worker(0);
    first.fleet.clientsReceivingFinalResults = 1;
    const result = aggregateFriendlyReports([first, worker(10)], 4);
    expect(result.verdict.ok).toBe(false);
    expect(result.verdict.violations).toContain('final clients 3/4');
  });
});
