import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import compression from 'compression';
import { createApp, COMPRESSION_OPTIONS } from '../../src/app.js';
import type { Express } from 'express';

import '../setup.js';

describe('HTTP transport (compression + CORS preflight caching)', () => {
  let app: Express;

  beforeAll(() => {
    app = createApp();
  });

  it('caches CORS preflight verdicts via Access-Control-Max-Age', async () => {
    const response = await request(app)
      .options('/api/v1/users/me')
      .set('Origin', 'http://localhost:3000')
      .set('Access-Control-Request-Method', 'GET')
      .set('Access-Control-Request-Headers', 'authorization');

    expect(response.status).toBe(204);
    expect(response.headers['access-control-max-age']).toBe('7200');
    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:3000');
  });

  it('leaves sub-threshold responses uncompressed', async () => {
    const response = await request(app)
      .get('/health')
      .set('Accept-Encoding', 'gzip, br');

    expect(response.status).toBe(200);
    expect(response.headers['content-encoding']).toBeUndefined();
  });

  describe('compression options', () => {
    const big = JSON.stringify({ rows: Array.from({ length: 200 }, (_, i) => ({ i, name: `player-${i}` })) });

    const buildApp = () => {
      const testApp = express();
      testApp.use(compression(COMPRESSION_OPTIONS));
      testApp.get('/big', (_req, res) => {
        res.json(JSON.parse(big));
      });
      testApp.get('/stream', (_req, res) => {
        res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.write(`${JSON.stringify({ type: 'progress' })}\n`);
        res.end(`${JSON.stringify({ type: 'done', pad: 'x'.repeat(2048) })}\n`);
      });
      return testApp;
    };

    it('prefers Brotli when the client accepts it', async () => {
      const response = await request(buildApp())
        .get('/big')
        .set('Accept-Encoding', 'br, gzip');

      expect(response.status).toBe(200);
      expect(response.headers['content-encoding']).toBe('br');
    });

    it('compresses JSON responses above the threshold', async () => {
      const response = await request(buildApp())
        .get('/big')
        .set('Accept-Encoding', 'gzip');

      expect(response.status).toBe(200);
      expect(response.headers['content-encoding']).toBe('gzip');
      expect(response.body.rows).toHaveLength(200);
    });

    it('never compresses no-transform streaming responses', async () => {
      const response = await request(buildApp())
        .get('/stream')
        .set('Accept-Encoding', 'gzip, br');

      expect(response.status).toBe(200);
      expect(response.headers['content-encoding']).toBeUndefined();
      expect(response.text).toContain('"type":"progress"');
    });
  });
});
