import 'express-async-errors';
import { beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import {
  requestIdMiddleware,
  errorHandler,
} from '../../src/http/middleware/index.js';
import '../setup.js';

vi.mock('../../src/modules/auction/auction-pipeline.service.js', () => ({
  auctionPipelineService: {
    getStats: vi.fn(),
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

import { adminAuctionPipelineRoutes } from '../../src/http/routes/admin-auction-pipeline.routes.js';
import { auctionPipelineService } from '../../src/modules/auction/auction-pipeline.service.js';

const STATS_FIXTURE = {
  generated_at: '2026-07-28T00:00:00.000Z',
  totals: {
    total_tasks: 3954,
    terminal_families: 337,
    published_families: 149,
    rejected_families: 153,
    failed_families: 35,
    pass_rate: 0.442,
    eligible_players: 1979,
    players_done: 153,
    players_remaining: 1826,
    completion_rate: 0.077,
  },
  stages: [{ stage: 'queued', count: 3616 }],
  variants: [{ variant_key: 'medium', count: 1977, published: 76 }],
  cards: {
    published: 306,
    needs_review: 8,
    superseded: 0,
    rejected: 0,
    published_families: 153,
  },
  attempts_24h: {
    total: 100,
    success: 80,
    rejected: 15,
    failed: 5,
    by_error_class: [{ error_class: 'CardRejectedError', count: 15 }],
  },
  recent_failures: [],
  latest_snapshot: null,
};

describe('Admin Auction Pipeline Routes', () => {
  let app: Express;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use(requestIdMiddleware);
    app.use('/api/v1/admin/auction-pipeline', adminAuctionPipelineRoutes);
    app.use(errorHandler);
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /api/v1/admin/auction-pipeline/stats', () => {
    it('returns pipeline stats from the service', async () => {
      (auctionPipelineService.getStats as Mock).mockResolvedValue(STATS_FIXTURE);

      const response = await request(app).get('/api/v1/admin/auction-pipeline/stats');

      expect(response.status).toBe(200);
      expect(response.body).toEqual(STATS_FIXTURE);
      expect(auctionPipelineService.getStats).toHaveBeenCalledTimes(1);
    });

    it('surfaces service failures through the error handler', async () => {
      (auctionPipelineService.getStats as Mock).mockRejectedValue(new Error('db down'));

      const response = await request(app).get('/api/v1/admin/auction-pipeline/stats');

      expect(response.status).toBe(500);
    });
  });
});
