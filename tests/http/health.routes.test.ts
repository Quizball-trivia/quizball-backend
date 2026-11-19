import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const mocks = vi.hoisted(() => ({
  unsafe: vi.fn(),
  withStatementTimeout: vi.fn(),
}));
vi.mock('../../src/db/index.js', () => ({
  withStatementTimeout: mocks.withStatementTimeout,
  dbPoolStats: () => ({ active: 0 }),
}));
vi.mock('../../src/modules/auth/auth-admission.js', () => ({ authAdmissionStats: () => ({}) }));
vi.mock('../../src/realtime/socket-db-task-limiter.js', () => ({
  gameplayDbTaskLimiter: { stats: () => ({}) },
  postConnectDbTaskLimiter: { stats: () => ({}) },
  socketDbTaskLimiter: { stats: () => ({}) },
}));
vi.mock('../../src/realtime/socket-runtime-stats.js', () => ({ socketRuntimeTracker: { stats: () => ({}) } }));
vi.mock('../../src/realtime/party-completion-work.js', () => ({ partyCompletionDbTaskLimiter: { stats: () => ({}) } }));

import { healthRoutes } from '../../src/http/routes/health.routes.js';
import { READINESS_CAP_MS, registerReadinessGate, resetReadinessGates } from '../../src/core/readiness.js';

describe('deploy readiness route', () => {
  const app = express().use(healthRoutes);
  beforeEach(() => resetReadinessGates());
  afterEach(() => { vi.restoreAllMocks(); resetReadinessGates(); });

  it('holds a new replica back while a gate is pending, and lets it in once the gate settles', async () => {
    let warm = false;
    registerReadinessGate('football-grid-judge', () => warm);
    vi.spyOn(process, 'uptime').mockReturnValue(5);
    const waiting = await request(app).get('/health/ready');
    expect(waiting.status).toBe(503);
    expect(waiting.body).toEqual({ ok: false, waiting: ['football-grid-judge'] });
    warm = true;
    expect((await request(app).get('/health/ready')).status).toBe(200);
  });

  it('never holds a deploy past the cap, and liveness never waits at all', async () => {
    registerReadinessGate('stuck', () => false);
    vi.spyOn(process, 'uptime').mockReturnValue(READINESS_CAP_MS / 1000 + 1);
    expect((await request(app).get('/health/ready')).status).toBe(200);
    vi.spyOn(process, 'uptime').mockReturnValue(1);
    expect((await request(app).get('/health')).status).toBe(200);
  });

  it('opens exactly at the cap, and treats a throwing gate as pending below it', async () => {
    registerReadinessGate('throws', () => { throw new Error('broken gate'); });
    vi.spyOn(process, 'uptime').mockReturnValue((READINESS_CAP_MS - 1) / 1000);
    expect((await request(app).get('/health/ready')).body).toEqual({ ok: false, waiting: ['throws'] });
    vi.spyOn(process, 'uptime').mockReturnValue(READINESS_CAP_MS / 1000);
    expect((await request(app).get('/health/ready')).status).toBe(200);
  });

  it('is ready at once when nothing registered a gate', async () => {
    vi.spyOn(process, 'uptime').mockReturnValue(1);
    expect((await request(app).get('/health/ready')).body).toEqual({ ok: true });
  });
});

describe('database readiness route', () => {
  const app = express().use(healthRoutes);
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withStatementTimeout.mockImplementation((fn) => fn({ unsafe: mocks.unsafe }));
  });

  it('keeps liveness independent from database checks', async () => {
    expect((await request(app).get('/health')).body).toEqual({ ok: true });
    expect(mocks.withStatementTimeout).not.toHaveBeenCalled();
  });

  it('checks actual transaction writability without performing a write', async () => {
    mocks.unsafe.mockResolvedValue([{ read_only: 'off' }]);
    const response = await request(app).get('/health/db');
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(mocks.unsafe).toHaveBeenCalledWith("SELECT current_setting('transaction_read_only') AS read_only");
    expect(mocks.withStatementTimeout).toHaveBeenCalledWith(expect.any(Function), 2000);
  });

  it.each(['on', undefined])('returns 503 instead of false healthy for %j', async (mode) => {
    mocks.unsafe.mockResolvedValue(mode === undefined ? [] : [{ read_only: mode }]);
    const response = await request(app).get('/health/db');
    expect(response.status).toBe(503);
    expect(response.body.ok).toBe(false);
    expect(response.text).not.toContain('read_only');
  });

  it('returns 503 for a failed query without exposing database details', async () => {
    mocks.unsafe.mockRejectedValue(new Error('private connection info'));
    const response = await request(app).get('/health/db');
    expect(response.status).toBe(503);
    expect(response.text).not.toContain('private');
  });
});
