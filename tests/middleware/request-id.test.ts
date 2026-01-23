import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import type { Express } from 'express';

// Import setup to configure test environment
import '../setup.js';

describe('Request ID Middleware', () => {
  let app: Express;

  beforeAll(() => {
    app = createApp();
  });

  it('should pass through a valid X-Request-ID header', async () => {
    const requestId = 'test-request-id-123';

    const response = await request(app)
      .get('/health')
      .set('X-Request-ID', requestId);

    expect(response.status).toBe(200);
    expect(response.headers['x-request-id']).toBe(requestId);
  });

  it('should fall back to X-Correlation-ID header', async () => {
    const correlationId = 'correlation-id-456';

    const response = await request(app)
      .get('/health')
      .set('X-Correlation-ID', correlationId);

    expect(response.status).toBe(200);
    expect(response.headers['x-request-id']).toBe(correlationId);
  });

  it('should generate UUID when no request ID is provided', async () => {
    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.headers['x-request-id']).toBeDefined();
    // UUID v4 format check
    expect(response.headers['x-request-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  it('should generate UUID when request ID is too long', async () => {
    const longId = 'a'.repeat(129); // Max is 128

    const response = await request(app)
      .get('/health')
      .set('X-Request-ID', longId);

    expect(response.status).toBe(200);
    expect(response.headers['x-request-id']).not.toBe(longId);
    expect(response.headers['x-request-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  it('should generate UUID when request ID has invalid characters', async () => {
    const invalidId = 'request@id#with$invalid%chars';

    const response = await request(app)
      .get('/health')
      .set('X-Request-ID', invalidId);

    expect(response.status).toBe(200);
    expect(response.headers['x-request-id']).not.toBe(invalidId);
    expect(response.headers['x-request-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  it('should accept valid characters: alphanumeric, dot, underscore, hyphen', async () => {
    const validId = 'my-request_id.123';

    const response = await request(app)
      .get('/health')
      .set('X-Request-ID', validId);

    expect(response.status).toBe(200);
    expect(response.headers['x-request-id']).toBe(validId);
  });

  it('should accept request ID at max length (128 chars)', async () => {
    const maxLengthId = 'a'.repeat(128);

    const response = await request(app)
      .get('/health')
      .set('X-Request-ID', maxLengthId);

    expect(response.status).toBe(200);
    expect(response.headers['x-request-id']).toBe(maxLengthId);
  });
});
