import { gzipSync } from 'node:zlib';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express, { type Express, type Request, type Response } from 'express';
import { createApp } from '../../src/app.js';
import { errorHandler } from '../../src/http/middleware/error-handler.js';
import { logger } from '../../src/core/logger.js';

import '../setup.js';

const MIB = 1024 * 1024;

/** Valid JSON of exactly `bytes` bytes. */
function jsonOfSize(bytes: number): string {
  const shell = JSON.stringify({ padding: '' });
  return JSON.stringify({ padding: 'a'.repeat(bytes - shell.length) });
}

// All anonymous: no cookie, no Authorization header.
describe('App-wide body limits', () => {
  let app: Express;
  let seen: Request | undefined;

  beforeAll(() => {
    // Wrap the real app so a test can look at the request it handled.
    app = express();
    app.use((req, res, next) => {
      res.on('finish', () => {
        seen = req;
      });
      next();
    });
    app.use(createApp());
  });

  const twoMiB = jsonOfSize(2 * MIB);

  it('refuses a 2 MiB JSON body to an unknown path with 413', async () => {
    const res = await request(app)
      .post('/this-path-does-not-exist')
      .set('Content-Type', 'application/json')
      .send(twoMiB);
    expect(res.status).toBe(413);
  });

  it('refuses a 2 MiB JSON body to an unauthenticated auth route with 413', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .set('Content-Type', 'application/json')
      .send(twoMiB);
    expect(res.status).toBe(413);
  });

  it('refuses a small gzip body that inflates past 1 MiB with 413', async () => {
    const compressed = gzipSync(Buffer.from(jsonOfSize(MIB + 64 * 1024)));
    expect(compressed.length).toBeLessThan(64 * 1024);
    const res = await request(app)
      .post('/this-path-does-not-exist')
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', 'gzip')
      // Send the gzip bytes as they are (superagent would JSON-encode a Buffer).
      .serialize((data: unknown) => data as string)
      .send(compressed);
    expect(res.status).toBe(413);
  });

  it('refuses a 200 kB form body with 413', async () => {
    const res = await request(app)
      .post('/this-path-does-not-exist')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(`padding=${'a'.repeat(200 * 1000)}`);
    expect(res.status).toBe(413);
  });

  it('answers 413 with the standard error shape and without the body', async () => {
    const marker = 'synthetic-marker-'.repeat(4);
    const res = await request(app)
      .post('/this-path-does-not-exist')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ marker, padding: 'a'.repeat(2 * MIB) }));
    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({ code: 'BAD_REQUEST', message: 'Request body too large', details: null });
    expect(res.text).not.toContain(marker);
  });

  it('answers malformed JSON with 400, not 500, and does not echo it', async () => {
    const marker = 'synthetic-marker-'.repeat(4);
    const res = await request(app)
      .post('/api/v1/auth/login')
      .set('Content-Type', 'application/json')
      .send(`{"email":"${marker}",`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'BAD_REQUEST', details: null });
    expect(res.text).not.toContain(marker);
  });

  it('answers a form nested past the parser depth with 400 and does not echo or log it', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const marker = 'synthetic-marker-'.repeat(4);
    try {
      const res = await request(app)
        .post('/this-path-does-not-exist')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send(`a${'[b]'.repeat(40)}=${marker}`);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'BAD_REQUEST', message: 'Malformed request body', details: null });
      expect(res.text).not.toContain(marker);
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ type: 'querystring.parse.rangeError', status: 400 }), 'Request body refused');
      expect(JSON.stringify(warn.mock.calls)).not.toContain(marker);
    } finally {
      warn.mockRestore();
    }
  });

  it('logs a refused body by its type only', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const marker = 'synthetic-marker-'.repeat(4);
    try {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .set('Content-Type', 'application/json')
        .send(`{"email":"${marker}",`);
      expect(res.status).toBe(400);
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ type: 'entity.parse.failed', status: 400 }), 'Request body refused');
      expect(JSON.stringify(warn.mock.calls)).not.toContain(marker);
    } finally {
      warn.mockRestore();
    }
  });

  it('leaves other errors that carry a 4xx status to the existing handling', () => {
    const status = vi.fn().mockReturnThis();
    const json = vi.fn();
    const err = Object.assign(new Error('synthetic'), { status: 400, statusCode: 400, expose: true });
    errorHandler(err, { method: 'POST', path: '/x', originalUrl: '/x', params: {}, query: {} } as unknown as Request, { status, json } as unknown as Response, () => undefined);
    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'INTERNAL_ERROR' }));
  });

  it('still parses a normal small JSON body on an existing route', async () => {
    const body = { email: 'not-an-email', password: 'synthetic' };
    const res = await request(app).post('/api/v1/auth/login').send(body);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(seen?.body).toEqual(body);
  });

  it('accepts a JSON body just under 1 MiB on the default parser', async () => {
    const res = await request(app)
      .post('/this-path-does-not-exist')
      .set('Content-Type', 'application/json')
      .send(jsonOfSize(MIB - 1024));
    expect(res.status).toBe(404);
  });

  it('does not keep the raw body on an ordinary route', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({ email: 'not-an-email', password: 'synthetic' });
    expect(res.status).toBe(422);
    expect(seen?.body).toBeDefined();
    expect(seen?.rawBody).toBeUndefined();
  });
});
