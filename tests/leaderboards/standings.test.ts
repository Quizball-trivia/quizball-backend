import 'express-async-errors';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import { requestIdMiddleware, errorHandler } from '../../src/http/middleware/index.js';
import '../setup.js';

const repoMock = vi.hoisted(() => ({ list: vi.fn(), topTenAndViewer: vi.fn() }));
vi.mock('../../src/modules/leaderboards/standings.repo.js', () => ({ standingsRepo: repoMock }));
const cache = vi.hoisted(() => ({ keys: [] as string[] }));
vi.mock('../../src/core/json-cache.js', () => ({
  getOrLoadJson: vi.fn(async (key: string, _ttl: number, load: () => Promise<unknown>) => {
    cache.keys.push(key);
    return load();
  }),
}));
const usersRepoMock = vi.hoisted(() => ({ getById: vi.fn() }));
vi.mock('../../src/modules/users/users.repo.js', () => ({ usersRepo: usersRepoMock }));
const clubsMock = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock('../../src/modules/leaderboards/leaderboard-clubs.js', () => ({ leaderboardClubs: clubsMock }));

const USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const auth = vi.hoisted(() => ({ signedIn: true }));
vi.mock('../../src/http/middleware/auth.js', () => ({
  authMiddleware: vi.fn((_req, _res, next) => next()),
  optionalAuthMiddleware: vi.fn((req, _res, next) => {
    if (auth.signedIn) req.user = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', role: 'user' };
    next();
  }),
}));

const { leaderboardsRoutes } = await import('../../src/http/routes/leaderboards.routes.js');
const { standingsService } = await import('../../src/modules/leaderboards/standings.service.js');

function createApp(): Express {
  const app = express();
  app.use(requestIdMiddleware);
  app.use('/api/v1/leaderboards', leaderboardsRoutes);
  app.use(errorHandler);
  return app;
}

const ROWS = [
  { key: 'fc-barcelona', players: 692, score: 72180, topUsername: 'Nika903', topPoints: 9340 },
  { key: 'real-madrid-cf', players: 475, score: 55275, topUsername: 'Jacob77sa', topPoints: 18400 },
];

beforeEach(() => {
  vi.clearAllMocks();
  cache.keys.length = 0;
  auth.signedIn = true;
  repoMock.list.mockResolvedValue(ROWS);
});

describe('standings endpoint', () => {
  it('serves guests the shared table with no viewer part', async () => {
    auth.signedIn = false;
    const res = await request(createApp()).get('/api/v1/leaderboards/standings?kind=club');
    expect(res.status).toBe(200);
    expect(res.headers.vary).toMatch(/Authorization/);
    expect(res.body.viewer).toBeNull();
    expect(res.body.standings[0]).toEqual({
      key: 'fc-barcelona', rank: 1, players: 692, score: 72180, topPlayer: { username: 'Nika903', points: 9340 },
    });
    expect(repoMock.list).toHaveBeenCalledWith('ranked', 'club');
  });

  it('caches only the shared rows, never the viewer part', async () => {
    usersRepoMock.getById.mockResolvedValue({ id: USER_ID, favorite_club: 'Real Madrid' });
    clubsMock.resolve.mockResolvedValue('real-madrid-cf');
    repoMock.topTenAndViewer.mockResolvedValue([{ userId: USER_ID, points: 900, pos: 4 }]);
    const res = await request(createApp()).get('/api/v1/leaderboards/standings?mode=auction&kind=club');
    expect(cache.keys).toEqual(['leaderboard:standings:v1:auction:club']);
    expect(res.body.viewer).toEqual({ mine: 'real-madrid-cf', slot: 4, gap: null, points: 900 });
  });

  it('rejects unknown modes and kinds', async () => {
    expect((await request(createApp()).get('/api/v1/leaderboards/standings?kind=city')).status).toBe(422);
    expect((await request(createApp()).get('/api/v1/leaderboards/standings?kind=club&mode=poker')).status).toBe(422);
  });
});

describe('viewer standing', () => {
  const tenRows = (lowest: number) => Array.from({ length: 10 }, (_, i) => ({ userId: `p${i}`, points: lowest + (9 - i) * 10, pos: i + 1 }));

  it('counts the viewer when inside the top 10', async () => {
    repoMock.topTenAndViewer.mockResolvedValue([...tenRows(500).slice(0, 6), { userId: USER_ID, points: 540, pos: 7 }]);
    expect(await standingsService.viewer('ranked', 'club', 'fc-barcelona', USER_ID)).toEqual({ mine: 'fc-barcelona', slot: 7, gap: null, points: 540 });
  });

  it('gives the points needed to pass the 10th scorer', async () => {
    repoMock.topTenAndViewer.mockResolvedValue([...tenRows(500), { userId: USER_ID, points: 420, pos: 15 }]);
    expect(await standingsService.viewer('ranked', 'club', 'fc-barcelona', USER_ID)).toEqual({ mine: 'fc-barcelona', slot: null, gap: 81, points: 420 });
  });

  it('needs the whole 10th score when the viewer has no points yet', async () => {
    repoMock.topTenAndViewer.mockResolvedValue(tenRows(500));
    expect((await standingsService.viewer('auction', 'country', 'GE', USER_ID)).gap).toBe(501);
  });

  it('asks for just one point when the group has fewer than ten scorers', async () => {
    repoMock.topTenAndViewer.mockResolvedValue(tenRows(500).slice(0, 4));
    expect(await standingsService.viewer('auction', 'country', 'UY', USER_ID)).toEqual({ mine: 'UY', slot: null, gap: 1, points: null });
  });
});
