import { describe, expect, it } from 'vitest';
import type { FriendlyAggregate } from '../../scripts/chaos/friendly-aggregate.js';
import type { GameplayAggregate } from '../../scripts/chaos/gameplay-aggregate.js';
import { aggregateMixedProductReports } from '../../scripts/chaos/mixed-product-aggregate.js';

function ranked(overrides: Partial<GameplayAggregate> = {}): GameplayAggregate {
  return {
    schemaVersion: 1,
    expectedClients: 1_000,
    expectedHttpRps: 600,
    includeSpendExpected: true,
    workers: 4,
    clients: 1_000,
    matchesStarted: 1_000,
    matchesCompleted: 1_000,
    matchesExpectedToComplete: 1_000,
    socketFailures: 0,
    wrongfulForfeits: 0,
    bootStageViolations: 0,
    http: { configuredRps: 600, sent: 1, completed: 1, approximateServerErrors: 0, routes: [] },
    latencyMs: { queueJoinToMatchStartP95: 1, answerToAckP95: 1 },
    verdict: { ok: true, violations: [] },
    ...overrides,
  };
}

function party(overrides: Partial<FriendlyAggregate> = {}): FriendlyAggregate {
  return {
    schemaVersion: 1,
    expectedClients: 1_000,
    workers: 4,
    clients: 1_000,
    pairs: 500,
    connectedClients: 1_000,
    lobbiesCreated: 500,
    joinedPairs: 500,
    matchesStarted: 500,
    matchesCompleted: 500,
    clientsReceivingFinalResults: 1_000,
    socketErrors: 0,
    pairFailures: 0,
    latencyMs: {
      connectToLobbyReadyP95: 1,
      lobbyCreateToMatchStartP95: 1,
      matchStartToFinalResultsP95: 1,
    },
    verdict: { ok: true, violations: [] },
    ...overrides,
  };
}

describe('aggregateMixedProductReports', () => {
  it('passes only when both product workloads and the total client count pass', () => {
    expect(aggregateMixedProductReports(ranked(), party(), 2_000).verdict).toEqual({
      ok: true,
      violations: [],
    });
  });

  it('preserves component failures and rejects missing spend coverage', () => {
    const result = aggregateMixedProductReports(
      ranked({ includeSpendExpected: false, verdict: { ok: false, violations: ['HTTP failed'] } }),
      party(),
      2_100
    );
    expect(result.verdict.ok).toBe(false);
    expect(result.verdict.violations).toEqual(expect.arrayContaining([
      'ranked failed: HTTP failed',
      'total clients 2000/2100',
      'ranked workload did not require economy and daily completion traffic',
    ]));
  });
});
