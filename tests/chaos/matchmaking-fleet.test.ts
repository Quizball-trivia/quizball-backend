import { describe, expect, it } from 'vitest';
import {
  analyzeMatchmakingPairs,
  evaluateMatchmakingFleet,
  type MatchmakingFleetSummary,
} from '../../scripts/chaos/matchmaking-fleet.js';

function healthySummary(): MatchmakingFleetSummary {
  return {
    startedAt: new Date(0).toISOString(),
    endedAt: new Date(1_000).toISOString(),
    elapsedSec: 1,
    clients: 100,
    connectedClients: 100,
    searchStartedClients: 100,
    humanMatchedClients: 100,
    humanPairs: 50,
    aiFallbackClients: 0,
    unmatchedClients: 0,
    duplicateMatchFoundClients: 0,
    selfMatchedClients: 0,
    invalidPairClients: 0,
    cleanupUnconfirmedClients: 0,
    matchFoundLatencyMs: [100, 200],
    pairObservations: [],
    percentiles: { count: 100, p50: 200, p95: 500, p99: 700, max: 800 },
    errorHistogram: {},
    failures: [],
  };
}

describe('matchmaking queue-storm verdict', () => {
  it('passes only a complete symmetric human-pair run', () => {
    expect(evaluateMatchmakingFleet(healthySummary())).toMatchObject({ ok: true, violations: [] });
  });

  it('fails AI fallback and invalid pairs even when every client received an event', () => {
    const summary = healthySummary();
    summary.humanMatchedClients = 98;
    summary.humanPairs = 49;
    summary.aiFallbackClients = 2;
    summary.invalidPairClients = 2;

    const verdict = evaluateMatchmakingFleet(summary);
    expect(verdict.ok).toBe(false);
    expect(verdict.violations.join(' ')).toContain('AI fallbacks');
    expect(verdict.violations.join(' ')).toContain('invalid pair');
  });

  it('fails before human-search fallback latency is approached', () => {
    const summary = healthySummary();
    summary.percentiles.p95 = 8_500;
    expect(evaluateMatchmakingFleet(summary).violations.join(' ')).toContain('p95');
  });

  it('defers cross-worker reciprocity to the aggregate report', () => {
    const summary = healthySummary();
    summary.humanMatchedClients = 0;
    summary.humanPairs = 0;
    summary.aiFallbackClients = 100;
    expect(evaluateMatchmakingFleet(summary, 8_000, true)).toMatchObject({
      ok: true,
      violations: [],
    });
  });

  it('validates 5,000 reciprocal clients as 2,500 unique human pairs', () => {
    const observations = Array.from({ length: 5_000 }, (_, index) => {
      const pairStart = index - index % 2;
      const opponent = index % 2 === 0 ? index + 1 : index - 1;
      return {
        userId: `u${index}`,
        lobbyId: `lobby-${pairStart}`,
        opponentId: `u${opponent}`,
      };
    });

    const analysis = analyzeMatchmakingPairs(observations);
    expect(analysis).toMatchObject({
      humanMatchedClients: 5_000,
      humanPairs: 2_500,
      aiFallbackClients: 0,
      selfMatchedClients: 0,
    });
    expect(analysis.invalidUserIds.size).toBe(0);
  });
});
