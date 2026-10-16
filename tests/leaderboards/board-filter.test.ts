import 'express-async-errors';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import { requestIdMiddleware, errorHandler } from '../../src/http/middleware/index.js';
import '../setup.js';

type SqlFragment = { text: string; values: unknown[] };

const dbMocks = vi.hoisted(() => {
  const taggedCalls: SqlFragment[] = [];
  const taggedResults: unknown[][] = [];
  const render = (value: unknown) =>
    value && typeof value === 'object' && 'text' in value ? (value as SqlFragment).text : '$param';
  const sql = Object.assign(
    vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.reduce((acc, part, i) => acc + part + (i < values.length ? render(values[i]) : ''), '');
      const fragment = { text, values };
      if (/^\s*(SELECT|WITH)\b/i.test(text)) {
        taggedCalls.push(fragment);
        return Promise.resolve(taggedResults.shift() ?? []);
      }
      return fragment;
    }),
    { taggedCalls, taggedResults },
  );
  return { sql };
});

vi.mock('../../src/db/index.js', () => ({ sql: dbMocks.sql }));
vi.mock('../../src/core/json-cache.js', () => ({
  getOrLoadJson: vi.fn(async (_key: string, _ttl: number, load: () => Promise<unknown>) => load()),
}));

const usersRepoMock = vi.hoisted(() => ({ getById: vi.fn() }));
vi.mock('../../src/modules/users/users.repo.js', () => ({ usersRepo: usersRepoMock }));

const clubsMock = vi.hoisted(() => ({ resolve: vi.fn(), exists: vi.fn() }));
vi.mock('../../src/modules/leaderboards/leaderboard-clubs.js', () => ({ leaderboardClubs: clubsMock }));

const USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const auth = vi.hoisted(() => ({ signedIn: true }));
vi.mock('../../src/http/middleware/auth.js', () => ({
  authMiddleware: vi.fn((req, _res, next) => {
    req.user = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', role: 'user' };
    next();
  }),
  optionalAuthMiddleware: vi.fn((req, _res, next) => {
    if (auth.signedIn) req.user = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', role: 'user' };
    next();
  }),
}));

const { boardCacheScope, boardFilterSql } = await import('../../src/modules/leaderboards/board-filter.js');
const { nextTargetOf } = await import('../../src/modules/leaderboards/board-response.js');
const { auctionRoutes } = await import('../../src/http/routes/auction.routes.js');
const { auctionLeaderboardService } = await import('../../src/modules/auction/auction-leaderboard.service.js');

function createApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.use('/api/v1/auction', auctionRoutes);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  dbMocks.sql.taggedCalls.length = 0;
  dbMocks.sql.taggedResults.length = 0;
  vi.clearAllMocks();
  auth.signedIn = true;
  clubsMock.exists.mockResolvedValue(true);
});

describe('board filter', () => {
  it('gives every board its own cache scope', () => {
    expect(boardCacheScope({ kind: 'global' })).toBe('global');
    expect(boardCacheScope({ kind: 'country', country: 'AR' })).toBe('country:AR');
    expect(boardCacheScope({ kind: 'club', club: 'fc-barcelona' })).toBe('club:fc-barcelona');
  });

  it('filters a club board through the alias table, not the raw text', () => {
    const fragment = boardFilterSql({ kind: 'club', club: 'real-madrid-cf' }) as unknown as SqlFragment;
    expect(fragment.text).toMatch(/lower\(btrim\(u\.favorite_club\)\) IN \(\s*SELECT alias FROM leaderboard_club_aliases WHERE club_id = \$param/);
    expect(fragment.values).toContain('real-madrid-cf');
  });
});

describe('browsing boards', () => {
  it('lets a guest open any country board', async () => {
    auth.signedIn = false;
    const list = vi.spyOn(auctionLeaderboardService, 'getLeaderboard').mockResolvedValue([]);
    const res = await request(createApp()).get('/api/v1/auction/leaderboard?scope=country&country=ar');
    expect(res.status).toBe(200);
    expect(list).toHaveBeenCalledWith(50, 0, { kind: 'country', country: 'AR' });
    expect(usersRepoMock.getById).not.toHaveBeenCalled();
  });

  it('lets a guest open a club board, and 404s an unknown club', async () => {
    auth.signedIn = false;
    const list = vi.spyOn(auctionLeaderboardService, 'getLeaderboard').mockResolvedValue([]);
    const ok = await request(createApp()).get('/api/v1/auction/leaderboard?scope=club&club=fc-barcelona');
    expect(ok.status).toBe(200);
    expect(list).toHaveBeenCalledWith(50, 0, { kind: 'club', club: 'fc-barcelona' });

    clubsMock.exists.mockResolvedValue(false);
    const missing = await request(createApp()).get('/api/v1/auction/leaderboard?scope=club&club=no-such-club');
    expect(missing.status).toBe(404);
  });

  it('rejects an unsupported country code instead of showing the global board', async () => {
    auth.signedIn = false;
    const list = vi.spyOn(auctionLeaderboardService, 'getLeaderboard').mockResolvedValue([]);
    const res = await request(createApp()).get('/api/v1/auction/leaderboard?scope=country&country=ZZ');
    expect(res.status).toBe(404);
    expect(list).not.toHaveBeenCalled();
  });

  it('still needs a session for "my country" and "my club"', async () => {
    auth.signedIn = false;
    expect((await request(createApp()).get('/api/v1/auction/leaderboard?scope=country')).status).toBe(401);
    expect((await request(createApp()).get('/api/v1/auction/leaderboard?scope=club')).status).toBe(401);
  });

  it('resolves "my club" from the stored favorite club spelling', async () => {
    usersRepoMock.getById.mockResolvedValue({ id: USER_ID, favorite_club: 'Real Madrid' });
    clubsMock.resolve.mockResolvedValue('real-madrid-cf');
    const list = vi.spyOn(auctionLeaderboardService, 'getLeaderboard').mockResolvedValue([]);
    const res = await request(createApp()).get('/api/v1/auction/leaderboard?scope=club');
    expect(res.status).toBe(200);
    expect(clubsMock.resolve).toHaveBeenCalledWith('Real Madrid');
    expect(list).toHaveBeenCalledWith(50, 0, { kind: 'club', club: 'real-madrid-cf' });
  });

  it('returns an empty board when the caller has no club', async () => {
    usersRepoMock.getById.mockResolvedValue({ id: USER_ID, favorite_club: null });
    clubsMock.resolve.mockResolvedValue(null);
    const list = vi.spyOn(auctionLeaderboardService, 'getLeaderboard');
    const res = await request(createApp()).get('/api/v1/auction/leaderboard?scope=club');
    expect(res.body).toEqual({ entries: [] });
    expect(list).not.toHaveBeenCalled();
  });

  it('reports the next player to pass with the rank', async () => {
    usersRepoMock.getById.mockResolvedValue({ id: USER_ID, nickname: 'Me', country: 'GE', favorite_club: 'FC Barcelona' });
    vi.spyOn(auctionLeaderboardService, 'getUserRank').mockResolvedValue({
      auctionPoints: 300, tier: null, rank: 4, total: 40, nextAbove: { username: 'Rival', points: 340 },
    });
    const res = await request(createApp()).get('/api/v1/auction/leaderboard/me?scope=club&club=fc-barcelona');
    expect(res.body.nextTarget).toEqual({ username: 'Rival', rank: 3, gap: 41 });
  });
});

describe('nextTargetOf', () => {
  it('needs one point more than the player above, at least one', () => {
    expect(nextTargetOf(5, 100, { username: 'A', points: 120 })).toEqual({ username: 'A', rank: 4, gap: 21 });
    expect(nextTargetOf(5, 100, { username: 'A', points: 100 })).toEqual({ username: 'A', rank: 4, gap: 1 });
    expect(nextTargetOf(1, 100, { username: 'A', points: 120 })).toBeNull();
    expect(nextTargetOf(3, 100, null)).toBeNull();
  });
});
