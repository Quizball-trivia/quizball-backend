import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/app.js';

import '../setup.js';

// QA 2026-10-25 N7: the Conexiones parsers sit before the app-wide 500 MB ones, for JSON and form bodies alike.
describe('Conexiones body limits', () => {
  let app: Express;
  beforeAll(() => {
    app = createApp();
  });
  const padding = 'x'.repeat(64 * 1024);

  it('refuses an oversized JSON move with 413', async () => {
    const res = await request(app).post('/api/v1/conexiones/guess').set('content-type', 'application/json').send(JSON.stringify({ runId: 'r', junk: padding }));
    expect(res.status).toBe(413);
  });

  it('refuses an oversized form-encoded move with 413', async () => {
    const res = await request(app).post('/api/v1/conexiones/guess').set('content-type', 'application/x-www-form-urlencoded').send(`runId=r&junk=${padding}`);
    expect(res.status).toBe(413);
  });

  it('a small move still reaches the route', async () => {
    const res = await request(app).post('/api/v1/conexiones/guess').set('content-type', 'application/json').send(JSON.stringify({ runId: 'r' }));
    expect(res.status).not.toBe(413);
    expect(res.status).toBeLessThan(500);
  });
});
