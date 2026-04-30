import 'express-async-errors';
import { beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';

import '../setup.js';
import {
  requestIdMiddleware,
  errorHandler,
} from '../../src/http/middleware/index.js';

vi.mock('../../src/modules/daily-challenges/daily-challenges.service.js', () => ({
  dailyChallengesService: {
    listActiveChallenges: vi.fn(),
    getChallengeSession: vi.fn(),
    completeChallenge: vi.fn(),
    listAdminConfigs: vi.fn(),
    updateConfig: vi.fn(),
  },
}));

vi.mock('../../src/http/middleware/auth.js', () => ({
  authMiddleware: vi.fn((req, _res, next) => {
    req.user = { id: 'test-user-id', role: 'admin' };
    req.identity = { provider: 'test', subject: 'test-sub' };
    next();
  }),
}));

vi.mock('../../src/http/middleware/require-role.js', () => ({
  requireRole: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
}));

import { dailyChallengesRoutes } from '../../src/http/routes/daily-challenges.routes.js';
import { adminDailyChallengesRoutes } from '../../src/http/routes/admin-daily-challenges.routes.js';
import { dailyChallengesService } from '../../src/modules/daily-challenges/daily-challenges.service.js';

describe('Daily Challenges Routes', () => {
  let app: Express;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use(requestIdMiddleware);
    app.use('/api/v1/daily-challenges', dailyChallengesRoutes);
    app.use('/api/v1/admin/daily-challenges', adminDailyChallengesRoutes);
    app.use(errorHandler);
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('GET /api/v1/daily-challenges returns active lineup for the current user', async () => {
    (dailyChallengesService.listActiveChallenges as Mock).mockResolvedValue([
      { challengeType: 'moneyDrop', completedToday: false, availableToday: true },
    ]);

    const response = await request(app).get('/api/v1/daily-challenges');

    expect(response.status).toBe(200);
    expect(response.body.items).toHaveLength(1);
    expect(dailyChallengesService.listActiveChallenges).toHaveBeenCalledWith('test-user-id', undefined);
  });

  it('GET /api/v1/daily-challenges forwards a requested locale', async () => {
    (dailyChallengesService.listActiveChallenges as Mock).mockResolvedValue([]);

    const response = await request(app).get('/api/v1/daily-challenges?locale=ka');

    expect(response.status).toBe(200);
    expect(dailyChallengesService.listActiveChallenges).toHaveBeenCalledWith('test-user-id', 'ka');
  });

  it('POST /api/v1/daily-challenges/:challengeType/session validates params and returns session', async () => {
    (dailyChallengesService.getChallengeSession as Mock).mockResolvedValue({
      challengeType: 'moneyDrop',
      title: 'Money Drop',
      description: 'desc',
      questionCount: 1,
      secondsPerQuestion: 30,
      startingMoney: 100000,
      questions: [],
    });

    const response = await request(app).post('/api/v1/daily-challenges/moneyDrop/session').send({});

    expect(response.status).toBe(200);
    expect(dailyChallengesService.getChallengeSession).toHaveBeenCalledWith('test-user-id', 'moneyDrop', undefined);
  });

  it('POST /api/v1/daily-challenges/:challengeType/session forwards a requested locale', async () => {
    (dailyChallengesService.getChallengeSession as Mock).mockResolvedValue({
      challengeType: 'trueFalse',
      title: 'მართალია თუ მცდარი',
      description: 'desc',
      questionCount: 1,
      secondsPerQuestion: 30,
      questions: [],
    });

    const response = await request(app).post('/api/v1/daily-challenges/trueFalse/session?locale=ka').send({});

    expect(response.status).toBe(200);
    expect(dailyChallengesService.getChallengeSession).toHaveBeenCalledWith('test-user-id', 'trueFalse', 'ka');
  });

  it('POST /api/v1/daily-challenges/:challengeType/complete rejects invalid body', async () => {
    const response = await request(app)
      .post('/api/v1/daily-challenges/moneyDrop/complete')
      .send({ score: -5 });

    expect(response.status).toBe(422);
    expect(response.body.code).toBe('VALIDATION_ERROR');
  });

  it('GET /api/v1/admin/daily-challenges returns admin config list', async () => {
    (dailyChallengesService.listAdminConfigs as Mock).mockResolvedValue([
      { challengeType: 'countdown', isActive: true, sortOrder: 2 },
    ]);

    const response = await request(app).get('/api/v1/admin/daily-challenges');

    expect(response.status).toBe(200);
    expect(response.body.items[0].challengeType).toBe('countdown');
  });

  it('PUT /api/v1/admin/daily-challenges/:challengeType validates settings and forwards the update', async () => {
    (dailyChallengesService.updateConfig as Mock).mockResolvedValue({
      challengeType: 'imposter',
      isActive: true,
      sortOrder: 1,
      showOnHome: true,
      coinReward: 100,
      xpReward: 20,
      settings: {
        challengeType: 'imposter',
        categoryIds: [
          '11111111-1111-1111-1111-111111111111',
          '22222222-2222-2222-2222-222222222222',
          '33333333-3333-3333-3333-333333333333',
        ],
        questionCount: 9,
        secondsPerQuestion: 25,
      },
    });

    const response = await request(app)
      .put('/api/v1/admin/daily-challenges/imposter')
      .send({
        isActive: true,
        sortOrder: 1,
        showOnHome: true,
        coinReward: 100,
        xpReward: 20,
        settings: {
          challengeType: 'imposter',
          categoryIds: [
            '11111111-1111-1111-1111-111111111111',
            '22222222-2222-2222-2222-222222222222',
            '33333333-3333-3333-3333-333333333333',
          ],
          questionCount: 9,
          secondsPerQuestion: 25,
        },
      });

    expect(response.status).toBe(200);
    expect(dailyChallengesService.updateConfig).toHaveBeenCalledWith(
      'imposter',
      expect.objectContaining({
        isActive: true,
        sortOrder: 1,
        showOnHome: true,
        coinReward: 100,
        xpReward: 20,
        settings: expect.objectContaining({
          challengeType: 'imposter',
          categoryIds: [
            '11111111-1111-1111-1111-111111111111',
            '22222222-2222-2222-2222-222222222222',
            '33333333-3333-3333-3333-333333333333',
          ],
          questionCount: 9,
          secondsPerQuestion: 25,
        }),
      })
    );
  });
});
