import 'express-async-errors';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import '../setup.js';
import { systemRoutes } from '../../src/http/routes/system.routes.js';
import { READ_ONLY_SQLSTATE, readOnlyDbBreaker } from '../../src/db/readonly-breaker.js';

function readOnlyError(): Error & { code: string } {
  const error = new Error('cannot execute in a read-only transaction') as Error & { code: string };
  error.code = READ_ONLY_SQLSTATE;
  return error;
}

function buildApp(): Express {
  const app = express();
  app.use(systemRoutes);
  return app;
}

describe('GET /api/v1/system/status', () => {
  beforeEach(() => {
    readOnlyDbBreaker.resetForTests();
  });
  afterEach(() => {
    readOnlyDbBreaker.resetForTests();
  });

  it('is unauthenticated and reports a healthy status by default', async () => {
    const res = await request(buildApp()).get('/api/v1/system/status');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      degraded: false,
      reason: null,
      matchmaking: 'available',
      sinceMs: null,
    });
    expect(typeof res.body.serverTimeMs).toBe('number');
  });

  it('sets a short Cache-Control window', async () => {
    const res = await request(buildApp()).get('/api/v1/system/status');
    expect(res.headers['cache-control']).toContain('max-age=5');
  });

  it('reports the outage while the breaker is degraded', async () => {
    readOnlyDbBreaker.recordError(readOnlyError());
    const res = await request(buildApp()).get('/api/v1/system/status');
    expect(res.body).toMatchObject({
      degraded: true,
      reason: 'db_write_outage',
      matchmaking: 'paused',
    });
    expect(res.body.sinceMs).toBeGreaterThan(0);
  });
});
