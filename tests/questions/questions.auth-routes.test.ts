import 'express-async-errors';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import {
  errorHandler,
  requestIdMiddleware,
} from '../../src/http/middleware/index.js';
import '../setup.js';

vi.mock('../../src/http/middleware/auth.js', () => ({
  authMiddleware: vi.fn((req, _res, next) => {
    req.user = {
      id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      role: 'player',
    };
    req.identity = { provider: 'test', subject: 'test-sub' };
    next();
  }),
}));

import { categoriesRoutes } from '../../src/http/routes/categories.routes.js';
import { questionsRoutes } from '../../src/http/routes/questions.routes.js';

describe('CMS read-route auth guards', () => {
  let app: Express;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use(requestIdMiddleware);
    app.use('/api/v1/categories', categoriesRoutes);
    app.use('/api/v1/questions', questionsRoutes);
    app.use(errorHandler);
  });

  it.each([
    '/api/v1/categories/123e4567-e89b-12d3-a456-426614174001/dependencies',
  ])('blocks a non-admin user from %s', async (path) => {
    const response = await request(app).get(path);

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('AUTHORIZATION_ERROR');
  });

  it('blocks a non-admin user from question mutations before validation', async () => {
    const response = await request(app).post('/api/v1/questions').send({});

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('AUTHORIZATION_ERROR');
  });
});
