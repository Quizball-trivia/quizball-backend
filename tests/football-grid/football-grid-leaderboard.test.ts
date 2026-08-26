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
        '',
      );
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

const USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
vi.mock('../../src/http/middleware/auth.js', () => ({
  authMiddleware: vi.fn((req, _res, next) => {
    req.user = { id: USER_ID, role: 'user' };
    next();
  }),
}));

const { footballGridRoutes } = await import('../../src/http/routes/football-grid.routes.js');
const { footballGridLeaderboardRepo } = await import(
  '../../src/modules/football-grid/football-grid-leaderboard.repo.js'
);
const { footballGridLeaderboardService } = await import(
  '../../src/modules/football-grid/football-grid-leaderboard.service.js'
);

function createApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.use('/api/v1/football-grid', footballGridRoutes);
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
    country: 'ge',
  });
});

describe('Tic Tac Toe leaderboard repo', () => {
  it('uses a total TP ordering and excludes bots and hidden users', async () => {
    await footballGridLeaderboardRepo.listLeaderboard(50, 0);
    const query = dbMocks.sql.taggedCalls[0]?.text ?? '';
    expect(query).toMatch(/ORDER BY u\.tic_tac_toe_points DESC,[\s\S]*u\.tic_tac_toe_points_updated_at ASC,[\s\S]*u\.id ASC/);
    expect(query).toMatch(/u\.is_ai = false/);
    expect(query).toMatch(/u\.is_seed = false/);
    expect(query).toMatch(/u\.is_deleted = false/);
    expect(query).toMatch(/u\.deleted_at IS NULL/);
    expect(query).toMatch(/u\.pending_deletion_at IS NULL/);
    expect(query).toMatch(/u\.tic_tac_toe_points > 0/);
  });

  it('uses the identical timestamp and user-id tie breakers for own rank', async () => {
    dbMocks.sql.taggedResults.push([{ ticTacToePoints: 90, rank: 3, total: 12 }]);
    const result = await footballGridLeaderboardRepo.getUserRank(USER_ID);
    expect(result).toEqual({ ticTacToePoints: 90, rank: 3, total: 12 });
    const query = dbMocks.sql.taggedCalls[0]?.text ?? '';
    expect(query).toMatch(/u\.tic_tac_toe_points_updated_at < target\.tic_tac_toe_points_updated_at/);
    expect(query).toMatch(/u\.id < target\.id/);
  });

  it('applies country scope to list and rank queries', async () => {
    await footballGridLeaderboardRepo.listLeaderboard(50, 0, 'GE');
    expect(dbMocks.sql.taggedCalls[0]?.text).toMatch(/AND u\.country = /);
    dbMocks.sql.taggedResults.push([]);
    await footballGridLeaderboardRepo.getUserRank(USER_ID, 'GE');
    expect(dbMocks.sql.taggedCalls[1]?.text).toMatch(/AND u\.country = /);
  });

  it('preserves the stored country representation for exact matching', async () => {
    const list = vi.spyOn(footballGridLeaderboardRepo, 'listLeaderboard').mockResolvedValueOnce([]);
    await footballGridLeaderboardService.getLeaderboard(50, 0, 'Georgia');
    expect(list).toHaveBeenCalledWith(50, 0, 'Georgia');
  });
});

describe('GET /api/v1/football-grid/leaderboard', () => {
  it('returns ranked entries with the TP field expected by the third UI tab', async () => {
    dbMocks.sql.taggedResults.push([
      { userId: 'u1', username: 'Ace', avatarUrl: null, avatarCustomization: null, ticTacToePoints: 150, country: 'GE' },
      { userId: 'u2', username: 'Bee', avatarUrl: null, avatarCustomization: null, ticTacToePoints: 90, country: 'GE' },
    ]);
    const res = await request(createApp()).get('/api/v1/football-grid/leaderboard');
    expect(res.status).toBe(200);
    expect(res.body.entries[0]).toMatchObject({ userId: 'u1', ticTacToePoints: 150, rank: 1 });
    expect(res.body.entries[1]).toMatchObject({ userId: 'u2', ticTacToePoints: 90, rank: 2 });
  });

  it('continues rank numbering across offset pages', async () => {
    dbMocks.sql.taggedResults.push([
      { userId: 'u3', username: 'Cee', avatarUrl: null, avatarCustomization: null, ticTacToePoints: 40, country: null },
    ]);
    const res = await request(createApp()).get('/api/v1/football-grid/leaderboard?offset=50&limit=25');
    expect(res.status).toBe(200);
    expect(res.body.entries[0].rank).toBe(51);
  });

  it('does not silently turn a missing-country request into the global board', async () => {
    usersRepoMock.getById.mockResolvedValue({ id: USER_ID, country: null });
    const res = await request(createApp()).get('/api/v1/football-grid/leaderboard?scope=country');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ entries: [] });
    expect(dbMocks.sql.taggedCalls).toHaveLength(0);
  });

  it('rejects an out-of-range limit', async () => {
    const res = await request(createApp()).get('/api/v1/football-grid/leaderboard?limit=500');
    expect(res.status).toBe(422);
  });
});

describe('GET /api/v1/football-grid/leaderboard/me', () => {
  it("returns the caller's TP rank", async () => {
    dbMocks.sql.taggedResults.push([{ ticTacToePoints: 90, rank: 4, total: 20 }]);
    const res = await request(createApp()).get('/api/v1/football-grid/leaderboard/me');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      userId: USER_ID,
      username: 'Nika',
      ticTacToePoints: 90,
      rank: 4,
      total: 20,
    });
  });

  it('returns null when the caller has no TP or no country for country scope', async () => {
    dbMocks.sql.taggedResults.push([]);
    const unranked = await request(createApp()).get('/api/v1/football-grid/leaderboard/me');
    expect(unranked.body).toBeNull();

    usersRepoMock.getById.mockResolvedValue({ id: USER_ID, country: null });
    const noCountry = await request(createApp()).get('/api/v1/football-grid/leaderboard/me?scope=country');
    expect(noCountry.body).toBeNull();
  });
});
