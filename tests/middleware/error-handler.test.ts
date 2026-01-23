import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import express, { Express, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import {
  requestIdMiddleware,
  errorHandler,
  validate,
} from '../../src/http/middleware/index.js';
import {
  AppError,
  AuthenticationError,
  ValidationError,
  NotFoundError,
  ErrorCode,
} from '../../src/core/errors.js';

// Import setup to configure test environment
import '../setup.js';

describe('Error Handler Middleware', () => {
  let app: Express;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use(requestIdMiddleware);

    // Test route that throws AppError
    app.get('/app-error', (_req: Request, _res: Response) => {
      throw new AppError('Test error', 500, ErrorCode.INTERNAL_ERROR);
    });

    // Test route that throws AuthenticationError
    app.get('/auth-error', (_req: Request, _res: Response) => {
      throw new AuthenticationError('Invalid token');
    });

    // Test route that throws NotFoundError
    app.get('/not-found-error', (_req: Request, _res: Response) => {
      throw new NotFoundError('Resource not found');
    });

    // Test route that throws generic Error
    app.get('/generic-error', (_req: Request, _res: Response) => {
      throw new Error('Unexpected error');
    });

    // Test route with Zod validation
    const testSchema = z.object({
      email: z.string().email(),
      password: z.string().min(8),
    });

    app.post(
      '/validate',
      validate({ body: testSchema }),
      (_req: Request, res: Response) => {
        res.json({ success: true });
      }
    );

    // Error handler must be last
    app.use(errorHandler);
  });

  describe('Error Response Contract', () => {
    it('should return correct shape for AppError', async () => {
      const requestId = 'test-request-123';

      const response = await request(app)
        .get('/app-error')
        .set('X-Request-ID', requestId);

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        code: 'INTERNAL_ERROR',
        message: 'Test error',
        details: null,
        request_id: requestId,
      });
      expect(response.headers['x-request-id']).toBe(requestId);
    });

    it('should return correct shape for AuthenticationError', async () => {
      const requestId = 'auth-test-456';

      const response = await request(app)
        .get('/auth-error')
        .set('X-Request-ID', requestId);

      expect(response.status).toBe(401);
      expect(response.body).toEqual({
        code: 'AUTHENTICATION_ERROR',
        message: 'Invalid token',
        details: null,
        request_id: requestId,
      });
    });

    it('should return correct shape for NotFoundError', async () => {
      const requestId = 'not-found-789';

      const response = await request(app)
        .get('/not-found-error')
        .set('X-Request-ID', requestId);

      expect(response.status).toBe(404);
      expect(response.body).toEqual({
        code: 'NOT_FOUND',
        message: 'Resource not found',
        details: null,
        request_id: requestId,
      });
    });

    it('should return generic error for unexpected errors (no leak)', async () => {
      const requestId = 'generic-101';

      const response = await request(app)
        .get('/generic-error')
        .set('X-Request-ID', requestId);

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred',
        details: null,
        request_id: requestId,
      });
      // Should NOT leak the actual error message
      expect(response.body.message).not.toBe('Unexpected error');
    });
  });

  describe('Validation Error Contract', () => {
    it('should return 422 for validation errors with field details', async () => {
      const requestId = 'validation-test-1';

      const response = await request(app)
        .post('/validate')
        .set('X-Request-ID', requestId)
        .send({ email: 'invalid', password: '123' });

      expect(response.status).toBe(422);
      expect(response.body.code).toBe('VALIDATION_ERROR');
      expect(response.body.message).toBe('Invalid request body');
      expect(response.body.request_id).toBe(requestId);
      expect(response.body.details).toBeDefined();
      expect(response.body.details.fieldErrors).toBeDefined();
      // Should have errors for both fields
      expect(response.body.details.fieldErrors.email).toBeDefined();
      expect(response.body.details.fieldErrors.password).toBeDefined();
    });

    it('should pass validation with valid data', async () => {
      const response = await request(app)
        .post('/validate')
        .send({ email: 'test@example.com', password: 'password123' });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: true });
    });
  });

  describe('Request ID in Errors', () => {
    it('should include request_id in all error responses', async () => {
      const requestId = 'include-request-id-test';

      // Test with each error type
      const appErrorResponse = await request(app)
        .get('/app-error')
        .set('X-Request-ID', requestId);
      expect(appErrorResponse.body.request_id).toBe(requestId);

      const authErrorResponse = await request(app)
        .get('/auth-error')
        .set('X-Request-ID', requestId);
      expect(authErrorResponse.body.request_id).toBe(requestId);

      const genericErrorResponse = await request(app)
        .get('/generic-error')
        .set('X-Request-ID', requestId);
      expect(genericErrorResponse.body.request_id).toBe(requestId);
    });

    it('should generate request_id if not provided', async () => {
      const response = await request(app).get('/app-error');

      expect(response.status).toBe(500);
      expect(response.body.request_id).toBeDefined();
      expect(response.body.request_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );
    });
  });
});
