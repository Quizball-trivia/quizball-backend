import 'express-async-errors';
import { beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import {
  requestIdMiddleware,
  errorHandler,
} from '../../src/http/middleware/index.js';
import '../setup.js';

vi.mock('../../src/modules/auction/auction.service.js', () => ({
  auctionService: {
    listCards: vi.fn(),
    getCardById: vi.fn(),
    updateCard: vi.fn(),
    updateStatus: vi.fn(),
  },
}));

vi.mock('../../src/http/middleware/auth.js', () => ({
  authMiddleware: vi.fn((req, _res, next) => {
    req.user = { id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', role: 'player' };
    req.identity = { provider: 'test', subject: 'test-sub' };
    next();
  }),
}));

import { adminAuctionRoutes } from '../../src/http/routes/admin-auction.routes.js';
import { auctionService } from '../../src/modules/auction/auction.service.js';

describe('Admin Auction auth guard', () => {
  let app: Express;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use(requestIdMiddleware);
    app.use('/api/v1/admin/auction', adminAuctionRoutes);
    app.use(errorHandler);
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('blocks authenticated non-admin users', async () => {
    const response = await request(app).get('/api/v1/admin/auction/cards');

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('AUTHORIZATION_ERROR');
    expect(auctionService.listCards as Mock).not.toHaveBeenCalled();
  });
});
