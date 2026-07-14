import { describe, expect, it } from 'vitest';
import { evaluateChaosRun } from '../../scripts/chaos/slo.js';

describe('chaos SLO verdict', () => {
  it('fails a run before Postgres reaches its hard connection ceiling', () => {
    const verdict = evaluateChaosRun([
      {
        name: 'users.me', sent: 100, completed: 100, errorRatePct: 0,
        clientErrPct: 0, rps: 100, p50: 100, p95: 200, p99: 300, max: 500,
        statusHist: { '200': 100 },
      },
    ], null, {
      total: 70,
      active: 30,
      idle: 40,
      idleInTxn: 0,
      waitingOnLock: 0,
      longestActiveSec: 1,
      maxConnections: 90,
      utilizationPct: 77.8,
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.violations.join(' ')).toContain('DB connections');
  });

  it('passes a healthy HTTP-only run', () => {
    const verdict = evaluateChaosRun([
      {
        name: 'users.me', sent: 100, completed: 100, errorRatePct: 0,
        clientErrPct: 0, rps: 100, p50: 100, p95: 200, p99: 300, max: 500,
        statusHist: { '200': 100 },
      },
    ], null, null);
    expect(verdict).toMatchObject({ ok: true, violations: [] });
  });

  it('fails when a supposedly valid route returns client errors', () => {
    const verdict = evaluateChaosRun([
      {
        name: 'stats.recent', sent: 100, completed: 100, errorRatePct: 0,
        clientErrPct: 5, rps: 100, p50: 10, p95: 20, p99: 30, max: 40,
        statusHist: { '200': 95, '422': 5 },
      },
    ], null, null);

    expect(verdict.ok).toBe(false);
    expect(verdict.violations.join(' ')).toContain('unexpected HTTP 4xx');
  });
});
