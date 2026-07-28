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
    listWorkers: vi.fn(),
    listPrompts: vi.fn(),
    savePrompt: vi.fn(),
    requeueTasks: vi.fn(),
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

const ADMIN_USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

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

  describe('GET /api/v1/admin/auction-pipeline/workers', () => {
    it('returns live workers with stale counts', async () => {
      const payload = {
        workers: [
          {
            worker_id: 'host:1:0',
            hostname: 'host',
            task_id: '22222222-2222-2222-2222-222222222222',
            player_name: 'Player One',
            variant_key: 'hard',
            stage: 'generated',
            started_at: '2026-07-28T00:00:00.000Z',
            updated_at: '2026-07-28T00:00:05.000Z',
            seconds_since_heartbeat: 5,
            is_stale: false,
          },
        ],
        live: 1,
        stale: 0,
      };
      (auctionPipelineService.listWorkers as Mock).mockResolvedValue(payload);

      const response = await request(app).get('/api/v1/admin/auction-pipeline/workers');

      expect(response.status).toBe(200);
      expect(response.body).toEqual(payload);
    });
  });

  describe('GET /api/v1/admin/auction-pipeline/prompts', () => {
    it('wraps prompts in an items envelope', async () => {
      (auctionPipelineService.listPrompts as Mock).mockResolvedValue([
        {
          key: 'generator_rules',
          text: 'Be terse.',
          updated_at: '2026-07-28T00:00:00.000Z',
          updated_by: 'admin',
        },
      ]);

      const response = await request(app).get('/api/v1/admin/auction-pipeline/prompts');

      expect(response.status).toBe(200);
      expect(response.body.items).toHaveLength(1);
      expect(response.body.items[0].key).toBe('generator_rules');
    });
  });

  describe('PUT /api/v1/admin/auction-pipeline/prompts/:key', () => {
    it('saves a valid prompt override', async () => {
      (auctionPipelineService.savePrompt as Mock).mockResolvedValue({
        key: 'judge_rules',
        text: 'Be strict.',
        updated_at: '2026-07-28T00:00:00.000Z',
        updated_by: ADMIN_USER_ID,
      });

      const response = await request(app)
        .put('/api/v1/admin/auction-pipeline/prompts/judge_rules')
        .send({ text: 'Be strict.' });

      expect(response.status).toBe(200);
      expect(auctionPipelineService.savePrompt).toHaveBeenCalledWith(
        'judge_rules',
        'Be strict.',
        ADMIN_USER_ID
      );
    });

    it('rejects an unknown prompt key', async () => {
      const response = await request(app)
        .put('/api/v1/admin/auction-pipeline/prompts/not_a_key')
        .send({ text: 'x' });

      expect(response.status).toBe(422);
      expect(response.body.code).toBe('VALIDATION_ERROR');
      expect(auctionPipelineService.savePrompt).not.toHaveBeenCalled();
    });

    it('rejects empty prompt text', async () => {
      const response = await request(app)
        .put('/api/v1/admin/auction-pipeline/prompts/judge_rules')
        .send({ text: '   ' });

      expect(response.status).toBe(422);
      expect(auctionPipelineService.savePrompt).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/v1/admin/auction-pipeline/requeue', () => {
    it('requeues by filter', async () => {
      (auctionPipelineService.requeueTasks as Mock).mockResolvedValue({ requeued: 12 });

      const response = await request(app)
        .post('/api/v1/admin/auction-pipeline/requeue')
        .send({ filter: 'failed' });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ requeued: 12 });
      expect(auctionPipelineService.requeueTasks).toHaveBeenCalledWith(
        { filter: 'failed' },
        ADMIN_USER_ID
      );
    });

    it('requeues by explicit task ids', async () => {
      (auctionPipelineService.requeueTasks as Mock).mockResolvedValue({ requeued: 1 });
      const taskIds = ['33333333-3333-3333-3333-333333333333'];

      const response = await request(app)
        .post('/api/v1/admin/auction-pipeline/requeue')
        .send({ taskIds });

      expect(response.status).toBe(200);
      expect(auctionPipelineService.requeueTasks).toHaveBeenCalledWith({ taskIds }, ADMIN_USER_ID);
    });

    it('rejects an unqualified requeue', async () => {
      const response = await request(app)
        .post('/api/v1/admin/auction-pipeline/requeue')
        .send({});

      expect(response.status).toBe(422);
      expect(auctionPipelineService.requeueTasks).not.toHaveBeenCalled();
    });

    it('rejects supplying both taskIds and filter', async () => {
      const response = await request(app)
        .post('/api/v1/admin/auction-pipeline/requeue')
        .send({ taskIds: ['33333333-3333-3333-3333-333333333333'], filter: 'failed' });

      expect(response.status).toBe(422);
      expect(auctionPipelineService.requeueTasks).not.toHaveBeenCalled();
    });
  });
});
