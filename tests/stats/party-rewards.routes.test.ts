import 'express-async-errors';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthenticationError, NotFoundError } from '../../src/core/errors.js';
const { readRewards } = vi.hoisted(() => ({ readRewards: vi.fn() }));
vi.mock('../../src/modules/stats/party-rewards.service.js', () => ({ getPartyRewards: readRewards }));
vi.mock('../../src/http/middleware/auth.js', () => ({
  authMiddleware: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    if (!req.headers.authorization) return next(new AuthenticationError());
    req.user = { id: '11111111-1111-4111-8111-111111111111' } as express.Request['user'];
    next();
  },
}));
vi.mock('../../src/modules/stats/stats.service.js', () => ({ statsService: {} }));
import { statsRoutes } from '../../src/http/routes/stats.routes.js';
import { errorHandler } from '../../src/http/middleware/error-handler.js';
const app = express(); app.use('/stats', statsRoutes); app.use(errorHandler);
const matchId = '22222222-2222-4222-8222-222222222222';
const path = `/stats/party-matches/${matchId}/rewards`;
beforeEach(() => vi.clearAllMocks());
describe('Party reward status route', () => {
  it('requires authentication before reading anything', async () => {
    expect((await request(app).get(path)).status).toBe(401);
    expect(readRewards).not.toHaveBeenCalled();
  });
  it('validates the match ID before reading anything', async () => {
    expect((await request(app).get('/stats/party-matches/not-a-uuid/rewards').set('Authorization','Bearer test')).status).toBe(422);
    expect(readRewards).not.toHaveBeenCalled();
  });
  it('uses the authenticated identity, ignores a supplied userId and prevents shared caching', async () => {
    readRewards.mockResolvedValue({ matchId, status: 'pending', xpEarned: null });
    const response = await request(app).get(path+'?userId=someone-else').set('Authorization','Bearer test');
    expect(response.status).toBe(200);
    expect(readRewards).toHaveBeenCalledWith(matchId,'11111111-1111-4111-8111-111111111111');
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.body.xpEarned).toBeNull();
  });
  it('returns 404 for a match the member cannot read', async () => {
    readRewards.mockRejectedValue(new NotFoundError());
    expect((await request(app).get(path).set('Authorization','Bearer test')).status).toBe(404);
  });
});
