import { describe, expect, it } from 'vitest';
import { aggregateGameplayReports } from '../../scripts/chaos/gameplay-aggregate.js';

function worker(offset: number) {
  return {
    target: 'staging',
    config: { sockets: 2, totalRps: 10, includeSpend: true },
    http: {
      totalSent: 20,
      totalCompleted: 20,
      approximateServerErrors: 0,
      routes: [
        { name: 'store.purchase.coins', sent: 2, completed: 2, errorRatePct: 0, p95: 100, p99: 120 },
        { name: 'daily.complete', sent: 2, completed: 2, errorRatePct: 0, p95: 90, p99: 110 },
      ],
    },
    sockets: {
      clients: 2,
      matchesStarted: 2,
      matchesCompleted: 2,
      matchesExpectedToComplete: 2,
      failures: [],
      wrongfulForfeits: 0,
      deadSearch: 0,
      banRollback: 0,
      gateAbandon: 0,
      legacyDraftStall: 0,
      bootStageViolations: [],
      latenciesMs: {
        queueJoinToMatchStart: [100 + offset, 200 + offset],
        answerToAck: [10 + offset, 20 + offset],
      },
    },
    verdict: { ok: true, violations: [] },
  };
}

describe('distributed gameplay aggregate', () => {
  it('certifies exact client, gameplay, HTTP, and spend totals across workers', () => {
    const result = aggregateGameplayReports([worker(0), worker(10)], 4, 20, true);
    expect(result).toMatchObject({
      clients: 4,
      matchesCompleted: 4,
      socketFailures: 0,
      http: { configuredRps: 20, sent: 40, completed: 40 },
      latencyMs: { queueJoinToMatchStartP95: 210, answerToAckP95: 30 },
      verdict: { ok: true, violations: [] },
    });
  });

  it('fails missing gameplay and missing spend coverage', () => {
    const first = worker(0);
    first.sockets.matchesCompleted = 1;
    first.http.routes = first.http.routes.filter((route) => route.name !== 'store.purchase.coins');
    const result = aggregateGameplayReports([first, worker(10)], 4, 20, true);
    expect(result.verdict.ok).toBe(false);
    expect(result.verdict.violations).toContain('matches completed 3/4');
    // The second worker still covers the route, so prove the global no-traffic
    // gate with both workers missing it.
    const second = worker(10);
    second.http.routes = second.http.routes.filter((route) => route.name !== 'store.purchase.coins');
    const missing = aggregateGameplayReports([first, second], 4, 20, true);
    expect(missing.verdict.violations).toContain('spend route store.purchase.coins was not exercised');
  });
});
