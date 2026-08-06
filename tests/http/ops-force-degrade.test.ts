import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '../setup.js';
import type { Request, Response } from 'express';
import { AuthenticationError } from '../../src/core/errors.js';

const configMock = vi.hoisted(() => ({
  OPS_REPORT_TOKEN: 'secret-ops-token' as string | undefined,
  NODE_ENV: 'staging' as 'local' | 'staging' | 'prod',
  LOG_LEVEL: 'silent' as string,
  LOG_PRETTY: false as boolean,
  DB_OUTAGE_BREAKER_ENABLED: true as boolean | undefined,
  DB_OUTAGE_BREAKER_WINDOW_MS: 60_000 as number | undefined,
}));

vi.mock('../../src/core/config.js', () => ({ config: configMock }));

// The controller pulls in the realtime system-status service; the real
// buildSystemStatus is pure (reads the breaker snapshot) so we keep it, but
// stub the io wiring so the unit test needs no live socket server.
vi.mock('../../src/realtime/services/system-status.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/realtime/services/system-status.service.js')>();
  return { ...actual, setSystemStatusRealtimeServer: vi.fn() };
});

vi.mock('../../src/modules/matches/clue-guess-evaluations.repo.js', () => ({
  clueGuessEvaluationsRepo: { listRecent: vi.fn() },
}));
vi.mock('../../src/modules/ops/ops.service.js', () => ({
  opsService: { sendDailyReportEmail: vi.fn() },
}));

const { opsController } = await import('../../src/modules/ops/ops.controller.js');
const { readOnlyDbBreaker } = await import('../../src/db/readonly-breaker.js');

const AUTH = { 'x-ops-report-token': 'secret-ops-token' };

function makeReq(headers: Record<string, string>): Request {
  return { headers, validated: {} } as unknown as Request;
}

function makeRes(): Response & { statusCode?: number; body?: unknown } {
  const res = {
    statusCode: 200 as number,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
  };
  return res as unknown as Response & { statusCode?: number; body?: unknown };
}

beforeEach(() => {
  configMock.OPS_REPORT_TOKEN = 'secret-ops-token';
  configMock.NODE_ENV = 'staging';
  readOnlyDbBreaker.resetForTests();
});

afterEach(() => {
  readOnlyDbBreaker.resetForTests();
});

describe('POST /internal/ops/force-degrade', () => {
  it('rejects with no ops token', async () => {
    await expect(opsController.forceDegrade(makeReq({}), makeRes()))
      .rejects.toBeInstanceOf(AuthenticationError);
    expect(readOnlyDbBreaker.snapshot().degraded).toBe(false);
  });

  it('is DOUBLE-GUARDED: returns 403 on production even with a valid token', async () => {
    configMock.NODE_ENV = 'prod';
    const res = makeRes();
    await opsController.forceDegrade(makeReq(AUTH), res);
    expect(res.statusCode).toBe(403);
    // Prod path must NEVER trip the real breaker.
    expect(readOnlyDbBreaker.snapshot().degraded).toBe(false);
  });

  it('trips the real breaker on staging with a valid token', async () => {
    const res = makeRes();
    await opsController.forceDegrade(makeReq(AUTH), res);
    expect(res.statusCode).toBe(200);
    expect(readOnlyDbBreaker.snapshot().degraded).toBe(true);
    expect((res.body as { status: { matchmaking: string } }).status.matchmaking).toBe('paused');
  });
});

describe('POST /internal/ops/force-recover', () => {
  it('returns 403 on production even with a valid token', async () => {
    configMock.NODE_ENV = 'prod';
    // Pre-trip so we can prove it does NOT clear on prod.
    configMock.NODE_ENV = 'staging';
    await opsController.forceDegrade(makeReq(AUTH), makeRes());
    configMock.NODE_ENV = 'prod';
    const res = makeRes();
    await opsController.forceRecover(makeReq(AUTH), res);
    expect(res.statusCode).toBe(403);
    expect(readOnlyDbBreaker.snapshot().degraded).toBe(true);
  });

  it('clears the latch on staging with a valid token', async () => {
    await opsController.forceDegrade(makeReq(AUTH), makeRes());
    expect(readOnlyDbBreaker.snapshot().degraded).toBe(true);
    const res = makeRes();
    await opsController.forceRecover(makeReq(AUTH), res);
    expect(res.statusCode).toBe(200);
    expect(readOnlyDbBreaker.snapshot().degraded).toBe(false);
    expect((res.body as { status: { matchmaking: string } }).status.matchmaking).toBe('available');
  });
});

describe('outage-sim guard fails CLOSED', () => {
  it('is disabled (403) when NODE_ENV is unset — must not fail open on a prod deploy that forgot NODE_ENV', async () => {
    // Simulate an env where NODE_ENV was never provided.
    (configMock as { NODE_ENV: unknown }).NODE_ENV = undefined;
    const res = makeRes();
    await opsController.forceDegrade(makeReq(AUTH), res);
    expect(res.statusCode).toBe(403);
    expect(readOnlyDbBreaker.snapshot().degraded).toBe(false);
  });
});
