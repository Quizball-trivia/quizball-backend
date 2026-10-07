import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import '../setup.js';

// Budgets need Redis; this test is about routing, so they pass through. The feature gate stays real.
vi.mock('../../src/http/middleware/guest-http-budget.js', async (orig) => ({
  ...(await orig<object>()),
  guestHttpBudget: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../src/modules/daily-challenges/daily-challenges.service.js', async (orig) => {
  const actual = await orig<{ dailyChallengesService: object }>();
  return {
    ...actual,
    dailyChallengesService: {
      ...actual.dailyChallengesService,
      getStatSniperLeaderboard: vi.fn(async () => ({ challengeDay: '2026-10-07', entries: [{ userId: 'u-secret', rank: 1, username: 'KAKA007', avatarCustomization: null, country: 'GE', score: 91 }], me: null })),
    },
  };
});

async function app() {
  const { guestRoutes } = await import('../../src/http/routes/guest.routes.js');
  const { errorHandler } = await import('../../src/http/middleware/index.js');
  const a = express();
  a.use(express.json());
  a.use('/api/v1/guest', guestRoutes);
  a.use(errorHandler);
  return a;
}

describe('public Stat Sniper board route', () => {
  it('answers without any guest token, with no user ids', async () => {
    const res = await request(await app()).get('/api/v1/guest/daily-challenges/stat-sniper/leaderboard');
    expect(res.status).toBe(200);
    expect(res.body.entries[0]).toEqual({ rank: 1, alias: 'KAKA007', score: 91, country: 'GE', avatarCustomization: null });
    expect(JSON.stringify(res.body)).not.toContain('u-secret');
  });

  it('leaves the other guest daily routes token-only', async () => {
    const res = await request(await app()).post('/api/v1/guest/daily-challenges/statSniper/session');
    expect(res.status).toBe(401);
  });
});
