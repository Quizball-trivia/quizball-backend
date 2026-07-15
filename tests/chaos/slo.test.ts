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

  it('accepts one healthy application instance for an explicitly local run', () => {
    const verdict = evaluateChaosRun([], null, null, {
      requestFailures: 0,
      instances: {
        'local-1': {
          samples: 1,
          healthFailures: 0,
          pool: { newRejections: 0, newTimeouts: 0, maxWaitMs: 0 },
          runtime: { eventLoopP99Ms: 10, cpuPct: 10 },
        },
      },
    }, undefined, 1);

    expect(verdict).toMatchObject({ ok: true, violations: [] });
  });

  it('fails a count-based gameplay run when clients expire before starting their requested matches', () => {
    const socket = {
      clients: 100,
      matchesPerClient: 1,
      matchesStarted: 20,
      matchesCompleted: 20,
      matchesExpectedToComplete: 20,
      deadlineCutoffs: { beforeMatchStart: 80, duringMatch: 0 },
      wrongfulForfeits: 0,
      deadSearch: 0,
      banRollback: 0,
      gateAbandon: 0,
      legacyDraftStall: 0,
      socketErrors: { stage_deadline_before_match_start: 80 },
      latenciesMs: {
        answerToAck: [10],
        roundResultToNextQuestion: [20],
      },
      percentiles: {
        queueJoinToMatchStart: { p95: 1_500 },
      },
    } as unknown as NonNullable<Parameters<typeof evaluateChaosRun>[1]>;

    const verdict = evaluateChaosRun([], socket, null, null, undefined, 1);

    expect(verdict.ok).toBe(false);
    expect(verdict.violations.join(' ')).toContain('socket match starts: 20/100 expected');
  });
});
