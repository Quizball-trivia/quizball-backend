import 'express-async-errors';
import { beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';

import '../setup.js';
import {
  requestIdMiddleware,
  errorHandler,
} from '../../src/http/middleware/index.js';

vi.mock('../../src/core/geo.js', () => ({
  detectCountryFromRequest: vi.fn(),
}));

import { detectCountryFromRequest } from '../../src/core/geo.js';
import { authRoutes } from '../../src/http/routes/auth.routes.js';

describe('Georgian phone auth availability route', () => {
  let app: Express;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use(requestIdMiddleware);
    app.use('/api/v1/auth', authRoutes);
    app.use(errorHandler);
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('marks phone auth available for Georgian requests', async () => {
    (detectCountryFromRequest as Mock).mockResolvedValue('GE');

    const response = await request(app).get('/api/v1/auth/phone/ge/availability');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      country: 'GE',
      phone_auth_available: true,
    });
  });

  it('hides phone auth outside Georgia', async () => {
    (detectCountryFromRequest as Mock).mockResolvedValue('US');

    const response = await request(app).get('/api/v1/auth/phone/ge/availability');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      country: 'US',
      phone_auth_available: false,
    });
  });

  it('hides phone auth when country detection fails', async () => {
    (detectCountryFromRequest as Mock).mockResolvedValue(null);

    const response = await request(app).get('/api/v1/auth/phone/ge/availability');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      country: null,
      phone_auth_available: false,
    });
  });
});
