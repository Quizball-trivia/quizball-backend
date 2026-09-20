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
      total: 73,
      active: 30,
      idle: 43,
      idleInTxn: 0,
      waitingOnLock: 0,
      longestLockWaitSec: 0,
      longestActiveSec: 1,
      maxConnections: 90,
      utilizationPct: 81.1,
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

  it('allows a brief lock waiter below the duration SLO', () => {
    const verdict = evaluateChaosRun([], null, {
      total: 10,
      active: 2,
      idle: 8,
      idleInTxn: 0,
      waitingOnLock: 1,
      longestLockWaitSec: 0.041,
      longestActiveSec: 1,
      maxConnections: 60,
      utilizationPct: 16.7,
    });

    expect(verdict).toMatchObject({ ok: true, violations: [] });
  });

  it('fails when a lock wait breaches 500ms or a query runs too long', () => {
    const verdict = evaluateChaosRun([], null, {
      total: 10,
      active: 2,
      idle: 8,
      idleInTxn: 0,
      waitingOnLock: 1,
      longestLockWaitSec: 1,
      longestActiveSec: 31,
      maxConnections: 60,
      utilizationPct: 16.7,
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.violations.join(' ')).toContain('DB longest lock wait');
    expect(verdict.violations.join(' ')).toContain('DB longest active query');
  });

  it('fails when a single-core container is CPU saturated', () => {
    const verdict = evaluateChaosRun([], null, null, {
      requestFailures: 0,
      instances: {
        'staging-1': {
          samples: 10,
          healthFailures: 0,
          pool: {
            active: 2,
            queued: 0,
            maxWaitMs: 0,
            newRejections: 0,
            newTimeouts: 0,
          },
          runtime: {
            cpuPct: 96,
            cpuCorePct: 96,
            cpuCapacityCores: 1,
            eventLoopP99Ms: 20,
            eventLoopMaxMs: 30,
            rssMb: 200,
            heapUsedMb: 100,
          },
        },
      },
    }, undefined, 1);

    expect(verdict.ok).toBe(false);
    expect(verdict.violations.join(' ')).toContain('CPU capacity 96%');
    expect(verdict.violations.join(' ')).toContain('CPU core 96%');
  });

  it('does not mistake multi-thread process CPU for event-loop saturation', () => {
    const verdict = evaluateChaosRun([], null, null, {
      requestFailures: 0,
      instances: {
        'staging-1': {
          samples: 10,
          healthFailures: 0,
          pool: {
            active: 2,
            queued: 0,
            maxWaitMs: 0,
            newRejections: 0,
            newTimeouts: 0,
          },
          runtime: {
            cpuPct: 15.9,
            cpuCorePct: 127,
            cpuCapacityCores: 8,
            eventLoopP99Ms: 24.3,
            eventLoopMaxMs: 50.9,
            rssMb: 224,
            heapUsedMb: 123,
          },
        },
      },
    }, undefined, 1);

    expect(verdict).toMatchObject({ ok: true, violations: [] });
  });

  it('fails a mixed run when the Auth bulkhead sheds requests', () => {
    const app = {
      requestFailures: 0,
      instances: {
        'staging-1': {
          samples: 10,
          healthFailures: 0,
          pool: { newRejections: 0, newTimeouts: 0, maxWaitMs: 0 },
          authAdmission: {
            active: 4,
            queued: 16,
            maxQueued: 16,
            maxWaitMs: 2_000,
            newRejections: 3,
            newTimeouts: 1,
          },
          runtime: { eventLoopP99Ms: 10, cpuPct: 10 },
        },
      },
    } as unknown as NonNullable<Parameters<typeof evaluateChaosRun>[3]>;

    const verdict = evaluateChaosRun([], null, null, app, undefined, 1);

    expect(verdict.ok).toBe(false);
    expect(verdict.violations.join(' ')).toContain('Auth admission shed 3 requests');
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

  it('fails gameplay before a long matchmaking tail reaches the search deadline', () => {
    const socket = {
      clients: 100,
      matchesStarted: 50,
      matchesCompleted: 50,
      matchesExpectedToComplete: 50,
      deadlineCutoffs: { beforeMatchStart: 0, duringMatch: 0 },
      wrongfulForfeits: 0,
      deadSearch: 0,
      banRollback: 0,
      gateAbandon: 0,
      legacyDraftStall: 0,
      socketErrors: {},
      latenciesMs: { answerToAck: [10], roundResultToNextQuestion: [20] },
      percentiles: { queueJoinToMatchStart: { p95: 8_001 } },
    } as unknown as NonNullable<Parameters<typeof evaluateChaosRun>[1]>;

    expect(evaluateChaosRun([], socket, null).violations.join(' ')).toContain(
      'matchmaking p95 8001ms > 8000ms'
    );
  });

  it('allows only explicitly expected socket errors for a fault scenario', () => {
    const socket = {
      clients: 2,
      matchesStarted: 1,
      matchesCompleted: 1,
      matchesExpectedToComplete: 1,
      deadlineCutoffs: { beforeMatchStart: 0, duringMatch: 0 },
      wrongfulForfeits: 0,
      deadSearch: 0,
      banRollback: 0,
      gateAbandon: 0,
      legacyDraftStall: 0,
      socketErrors: { 'server:MATCH_PAUSED': 2 },
      latenciesMs: {
        answerToAck: [10],
        roundResultToNextQuestion: [20],
      },
      percentiles: {
        queueJoinToMatchStart: { p95: 1_500 },
      },
    } as unknown as NonNullable<Parameters<typeof evaluateChaosRun>[1]>;

    const strictVerdict = evaluateChaosRun([], socket, null, null, undefined, 1);
    const faultVerdict = evaluateChaosRun(
      [],
      socket,
      null,
      null,
      undefined,
      1,
      ['server:MATCH_PAUSED']
    );

    expect(strictVerdict.violations).toContain('unexpected socket errors: 2');
    expect(faultVerdict).toMatchObject({ ok: true, violations: [] });
  });
});
