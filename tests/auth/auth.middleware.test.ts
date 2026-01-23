import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import express, { Express, Request, Response } from 'express';
import {
  requestIdMiddleware,
  errorHandler,
  authMiddleware,
} from '../../src/http/middleware/index.js';

// Import setup to configure test environment
import '../setup.js';

describe('Auth Middleware', () => {
  let app: Express;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use(requestIdMiddleware);

    // Protected route that requires auth
    app.get('/protected', authMiddleware, (req: Request, res: Response) => {
      res.json({
        message: 'Access granted',
        user_id: req.user?.id,
        identity_provider: req.identity?.provider,
      });
    });

    // Error handler must be last
    app.use(errorHandler);
  });

  describe('Missing Authorization', () => {
    it('should return 401 when Authorization header is missing', async () => {
      const requestId = 'auth-test-missing';

      const response = await request(app)
        .get('/protected')
        .set('X-Request-ID', requestId);

      expect(response.status).toBe(401);
      expect(response.body).toEqual({
        code: 'AUTHENTICATION_ERROR',
        message: 'Missing authorization header',
        details: null,
        request_id: requestId,
      });
      expect(response.headers['x-request-id']).toBe(requestId);
    });

    it('should include request_id in 401 error (generated if not provided)', async () => {
      const response = await request(app).get('/protected');

      expect(response.status).toBe(401);
      expect(response.body.code).toBe('AUTHENTICATION_ERROR');
      expect(response.body.request_id).toBeDefined();
      expect(response.body.request_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );
    });
  });

  describe('Invalid Authorization Format', () => {
    it('should return 401 when Authorization header has wrong format', async () => {
      const requestId = 'auth-test-wrong-format';

      const response = await request(app)
        .get('/protected')
        .set('X-Request-ID', requestId)
        .set('Authorization', 'Basic dXNlcjpwYXNz'); // Basic auth instead of Bearer

      expect(response.status).toBe(401);
      expect(response.body.code).toBe('AUTHENTICATION_ERROR');
      expect(response.body.message).toBe('Missing authorization header');
      expect(response.body.request_id).toBe(requestId);
    });

    it('should return 401 when Bearer token is empty', async () => {
      const requestId = 'auth-test-empty-token';

      const response = await request(app)
        .get('/protected')
        .set('X-Request-ID', requestId)
        .set('Authorization', 'Bearer ');

      expect(response.status).toBe(401);
      expect(response.body.code).toBe('AUTHENTICATION_ERROR');
      expect(response.body.request_id).toBe(requestId);
    });

    it('should return 401 when Authorization header has only Bearer keyword', async () => {
      const requestId = 'auth-test-bearer-only';

      const response = await request(app)
        .get('/protected')
        .set('X-Request-ID', requestId)
        .set('Authorization', 'Bearer');

      expect(response.status).toBe(401);
      expect(response.body.code).toBe('AUTHENTICATION_ERROR');
      expect(response.body.request_id).toBe(requestId);
    });
  });

  describe('Invalid Token', () => {
    it('should return error when token verification fails', async () => {
      const requestId = 'auth-test-invalid-token';

      const response = await request(app)
        .get('/protected')
        .set('X-Request-ID', requestId)
        .set('Authorization', 'Bearer invalid-jwt-token-here');

      // Without a real Supabase connection, verification will fail
      // Could be 401 (if JWKS verification fails) or 502 (if Supabase unreachable)
      // The important part is: request_id is always in the response
      expect([401, 502]).toContain(response.status);
      expect(['AUTHENTICATION_ERROR', 'EXTERNAL_SERVICE_ERROR']).toContain(
        response.body.code
      );
      expect(response.body.request_id).toBe(requestId);
    });
  });
});
