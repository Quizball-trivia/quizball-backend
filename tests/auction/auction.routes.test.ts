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
    req.user = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', role: 'admin' };
    req.identity = { provider: 'test', subject: 'test-sub' };
    next();
  }),
}));

vi.mock('../../src/http/middleware/require-role.js', () => ({
  requireRole: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => {
    next();
  }),
}));

import { adminAuctionRoutes } from '../../src/http/routes/admin-auction.routes.js';
import { auctionService } from '../../src/modules/auction/auction.service.js';
import { authMiddleware } from '../../src/http/middleware/auth.js';

const CARD_ID = '11111111-1111-1111-1111-111111111111';
const ADMIN_USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

describe('Admin Auction Routes', () => {
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

  it('uses admin auth middleware for the route group', async () => {
    (auctionService.listCards as Mock).mockResolvedValue({
      data: [],
      page: 1,
      limit: 50,
      total: 0,
      total_pages: 0,
    });

    await request(app).get('/api/v1/admin/auction/cards');

    expect(authMiddleware).toHaveBeenCalled();
  });

  it('GET /cards passes parsed filters and pagination to the service', async () => {
    (auctionService.listCards as Mock).mockResolvedValue({
      data: [],
      page: 2,
      limit: 10,
      total: 0,
      total_pages: 0,
    });

    const response = await request(app)
      .get('/api/v1/admin/auction/cards')
      .query({
        status: 'draft',
        position_group: 'FWD',
        card_type: 'bargain',
        difficulty: 'hard',
        fame_bucket: 'known',
        verification_status: 'needs_review',
        search: 'Messi',
        page: '2',
        limit: '10',
      });

    expect(response.status).toBe(200);
    expect(auctionService.listCards).toHaveBeenCalledWith(
      {
        status: 'draft',
        positionGroup: 'FWD',
        cardType: 'bargain',
        difficulty: 'hard',
        fameBucket: 'known',
        verificationStatus: 'needs_review',
        search: 'Messi',
      },
      2,
      10
    );
  });

  it('GET /cards rejects invalid enum filters', async () => {
    const response = await request(app)
      .get('/api/v1/admin/auction/cards')
      .query({ status: 'live' });

    expect(response.status).toBe(422);
    expect(response.body.code).toBe('VALIDATION_ERROR');
    expect(auctionService.listCards).not.toHaveBeenCalled();
  });

  it('PATCH /cards/:id rejects a starting price below the Auction minimum', async () => {
    const response = await request(app)
      .patch(`/api/v1/admin/auction/cards/${CARD_ID}`)
      .send({ starting_price_eur: 19_999_999 });

    expect(response.status).toBe(422);
    expect(response.body.code).toBe('VALIDATION_ERROR');
    expect(auctionService.updateCard).not.toHaveBeenCalled();
  });

  it('PATCH /cards/:id rejects clue updates without exactly 3 ordered Georgian clues', async () => {
    const response = await request(app)
      .patch(`/api/v1/admin/auction/cards/${CARD_ID}`)
      .send({
        clues: [
          { clue_order: 1, clue_en: 'A', clue_ka: 'ა', clue_kind: 'fact' },
          { clue_order: 2, clue_en: 'B', clue_ka: 'ბ', clue_kind: 'fact' },
          { clue_order: 2, clue_en: 'C', clue_ka: '', clue_kind: 'fact' },
        ],
      });

    expect(response.status).toBe(422);
    expect(response.body.code).toBe('VALIDATION_ERROR');
    expect(auctionService.updateCard).not.toHaveBeenCalled();
  });

  it('PATCH /cards/:id/status passes authenticated user id for publish', async () => {
    (auctionService.updateStatus as Mock).mockResolvedValue({
      id: CARD_ID,
      status: 'published',
    });

    const response = await request(app)
      .patch(`/api/v1/admin/auction/cards/${CARD_ID}/status`)
      .send({ status: 'published' });

    expect(response.status).toBe(200);
    expect(auctionService.updateStatus).toHaveBeenCalledWith(
      CARD_ID,
      { status: 'published', force: false },
      ADMIN_USER_ID
    );
  });
});
