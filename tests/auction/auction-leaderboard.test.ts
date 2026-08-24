import 'express-async-errors';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import {
  requestIdMiddleware,
  errorHandler,
} from '../../src/http/middleware/index.js';
import '../setup.js';

type SqlFragment = { text: string; values: unknown[] };

const dbMocks = vi.hoisted(() => {
  const taggedCalls: SqlFragment[] = [];
  const taggedResults: unknown[][] = [];

  function renderValue(value: unknown): string {
    if (value && typeof value === 'object' && 'text' in value) {
      return (value as SqlFragment).text;
    }
    return '$param';
  }

  const sql = Object.assign(
    vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.reduce(
        (acc, part, index) => acc + part + (index < values.length ? renderValue(values[index]) : ''),
        ''
      );
      const fragment = { text, values };
      // Awaited queries start with SELECT/WITH; bare fragments (the country
      // filter) are returned for interpolation into the outer template.
      if (/^\s*(SELECT|WITH)\b/i.test(text)) {
        taggedCalls.push(fragment);
        return Promise.resolve(taggedResults.shift() ?? []);
      }
      return fragment;
    }),
    { taggedCalls, taggedResults }
  );

  return { sql };
});

vi.mock('../../src/db/index.js', () => ({ sql: dbMocks.sql }));

// The service layer caches through Redis; run the loader directly so tests
// exercise the repo SQL rather than a cache stub.
vi.mock('../../src/core/json-cache.js', () => ({
  getOrLoadJson: vi.fn(async (_key: string, _ttl: number, load: () => Promise<unknown>) => load()),
}));

const usersRepoMock = vi.hoisted(() => ({ getById: vi.fn() }));
vi.mock('../../src/modules/users/users.repo.js', () => ({ usersRepo: usersRepoMock }));

const USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

vi.mock('../../src/http/middleware/auth.js', () => ({
  authMiddleware: vi.fn((req, _res, next) => {
    req.user = { id: USER_ID, role: 'user' };
    next();
  }),
}));

const { auctionRoutes } = await import('../../src/http/routes/auction.routes.js');
const { auctionLeaderboardRepo } = await import(
  '../../src/modules/auction/auction-leaderboard.repo.js'
);

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
  usersRepoMock.getById.mockResolvedValue({
    id: USER_ID,
    nickname: 'Nika',
    avatar_url: null,
    avatar_customization: null,
    country: 'GE',
  });
});

describe('auction leaderboard repo', () => {
  it('orders by auction points descending and excludes bots and hidden users', async () => {
    await auctionLeaderboardRepo.listLeaderboard(50, 0);

    const query = dbMocks.sql.taggedCalls[0]?.text ?? '';
    expect(query).toMatch(/ORDER BY u\.auction_points DESC, u\.updated_at ASC/);
    // Same exclusion set the ranked leaderboard applies.
    expect(query).toMatch(/u\.is_ai = false/);
    expect(query).toMatch(/u\.is_seed = false/);
    expect(query).toMatch(/u\.is_deleted = false/);
    expect(query).toMatch(/u\.deleted_at IS NULL/);
    expect(query).toMatch(/u\.pending_deletion_at IS NULL/);
    // Players who never earned AP are not on the board.
    expect(query).toMatch(/u\.auction_points > 0/);
  });

  it('scopes to a country when one is supplied', async () => {
    await auctionLeaderboardRepo.listLeaderboard(50, 0, 'GE');
    expect(dbMocks.sql.taggedCalls[0]?.text).toMatch(/AND u\.country = /);
  });

  it('ranks by counting eligible users strictly ahead under the same ordering', async () => {
    dbMocks.sql.taggedResults.push([{ auctionPoints: 90, rank: 3, total: 12 }]);

    const result = await auctionLeaderboardRepo.getUserRank(USER_ID);

    expect(result).toEqual({ auctionPoints: 90, rank: 3, total: 12 });
    const query = dbMocks.sql.taggedCalls[0]?.text ?? '';
    expect(query).toMatch(/COUNT\(\*\)::int \+ 1/);
    expect(query).toMatch(/u\.auction_points > target\.auction_points/);
    // Tiebreaker must match listLeaderboard so rank agrees with list position.
    expect(query).toMatch(/u\.updated_at < target\.updated_at/);
    expect(query).toMatch(/u\.is_ai = false/);
  });

  it('returns null when the user has no auction points yet', async () => {
    dbMocks.sql.taggedResults.push([]);
    expect(await auctionLeaderboardRepo.getUserRank(USER_ID)).toBeNull();
  });
});

describe('GET /api/v1/auction/leaderboard', () => {
  it('returns entries numbered by rank', async () => {
    dbMocks.sql.taggedResults.push([
      { userId: 'u1', username: 'Ace', avatarUrl: null, avatarCustomization: null, auctionPoints: 150, country: 'GE' },
      { userId: 'u2', username: 'Bee', avatarUrl: null, avatarCustomization: null, auctionPoints: 90, country: 'GE' },
    ]);

    const res = await request(createApp()).get('/api/v1/auction/leaderboard');

    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(2);
    expect(res.body.entries[0]).toMatchObject({ userId: 'u1', auctionPoints: 150, rank: 1 });
    expect(res.body.entries[1]).toMatchObject({ userId: 'u2', auctionPoints: 90, rank: 2 });
  });

  it('continues rank numbering across pages via offset', async () => {
    dbMocks.sql.taggedResults.push([
      { userId: 'u3', username: 'Cee', avatarUrl: null, avatarCustomization: null, auctionPoints: 40, country: null },
    ]);

    const res = await request(createApp()).get('/api/v1/auction/leaderboard?offset=50&limit=25');

    expect(res.status).toBe(200);
    expect(res.body.entries[0].rank).toBe(51);
  });

  it('rejects an out-of-range limit', async () => {
    const res = await request(createApp()).get('/api/v1/auction/leaderboard?limit=500');
    expect(res.status).toBe(422);
  });
});

describe('GET /api/v1/auction/leaderboard/me', () => {
  it("returns the caller's own rank and points", async () => {
    dbMocks.sql.taggedResults.push([{ auctionPoints: 90, rank: 4, total: 20 }]);

    const res = await request(createApp()).get('/api/v1/auction/leaderboard/me');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      userId: USER_ID,
      username: 'Nika',
      auctionPoints: 90,
      rank: 4,
      total: 20,
    });
  });

  it('returns null when the caller has earned no AP', async () => {
    dbMocks.sql.taggedResults.push([]);

    const res = await request(createApp()).get('/api/v1/auction/leaderboard/me');

    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
  });
});
