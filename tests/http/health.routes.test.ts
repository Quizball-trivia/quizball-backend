import { beforeEach, describe, expect, it, vi } from 'vitest';
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
