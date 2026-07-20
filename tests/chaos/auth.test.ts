import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ChaosLoginError,
  ensureCoinPurchaseFixtures,
  loginChaosUser,
  provisionUsers,
  type ProvisionConfig,
} from '../../scripts/chaos/auth.js';

const config = {
  apiBase: 'http://127.0.0.1:8001',
  password: 'local-test-password',
};

const provisionConfig: ProvisionConfig = {
  ...config,
  supabaseUrl: 'http://127.0.0.1:54321',
  serviceRoleKey: 'local-service-role-key',
  count: 1,
  password: config.password,
  emailPrefix: 'load',
  emailDomain: 'example.com',
  concurrency: 1,
  loginIntervalMs: 0,
};

function existingUserResponses(fetchMock: ReturnType<typeof vi.fn>): void {
  fetchMock
    .mockResolvedValueOnce(new Response(JSON.stringify({
      users: [{ id: 'auth-user-id', email: 'load+u0@example.com' }],
    }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('chaos user login validation', () => {
  it('returns only a token whose /users/me identity resolves', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'token' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'internal-user-id' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(loginChaosUser(config, 'user@example.com')).resolves.toEqual({
      token: 'token',
      userId: 'internal-user-id',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries transient login 5xx and /users/me 401 before provisioning succeeds', async () => {
    const fetchMock = vi.fn();
    existingUserResponses(fetchMock);
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'auth unavailable' }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'token-2' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'introspection unavailable' }), { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'token-3' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'internal-user-id' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(provisionUsers(provisionConfig)).resolves.toEqual([expect.objectContaining({
      token: 'token-3',
      userId: 'internal-user-id',
    })]);
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls.filter((url) => url.endsWith('/api/v1/auth/login'))).toHaveLength(3);
    expect(urls.filter((url) => url.endsWith('/api/v1/users/me'))).toHaveLength(2);
  });

  it('retries transport failures while preparing and logging in test users', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        users: [{ id: 'auth-user-id', email: 'load+u0@example.com' }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'temporarily unavailable' }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'token' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'internal-user-id' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = provisionUsers(provisionConfig);
    await vi.runAllTimersAsync();

    await expect(result).resolves.toEqual([expect.objectContaining({
      token: 'token',
      userId: 'internal-user-id',
    })]);
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });

  it('reconciles a duplicate user after an ambiguous retried create', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ users: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'temporarily unavailable' }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: 'email_exists',
        message: 'A user with this email address has already been registered',
      }), { status: 422 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        users: [{ id: 'auth-user-id', email: 'load+u0@example.com' }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'token' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'internal-user-id' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = provisionUsers(provisionConfig);
    await vi.runAllTimersAsync();

    await expect(result).resolves.toEqual([expect.objectContaining({
      token: 'token',
      userId: 'internal-user-id',
    })]);
    expect(fetchMock).toHaveBeenCalledTimes(7);
    expect(fetchMock.mock.calls[4]?.[1]).toMatchObject({ method: 'PUT' });
  });

  it('does not retry a successful /users/me response with a missing identity', async () => {
    const fetchMock = vi.fn();
    existingUserResponses(fetchMock);
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'token' }), { status: 200 }))
      .mockResolvedValueOnce(new Response('null', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const error = await provisionUsers(provisionConfig).catch((cause) => cause);
    expect(error).toBeInstanceOf(ChaosLoginError);
    expect(error).toMatchObject({ status: 200, retryable: false });
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls.filter((url) => url.endsWith('/api/v1/auth/login'))).toHaveLength(1);
    expect(urls.filter((url) => url.endsWith('/api/v1/users/me'))).toHaveLength(1);
  });
});

describe('economy fixture production guards', () => {
  it('rejects the production API and project before opening a database connection', async () => {
    await expect(ensureCoinPurchaseFixtures({
      target: 'staging',
      apiBase: 'https://api.quizball.io',
      supabaseUrl: 'https://lfbwhxvwubzeqkztghok.supabase.co',
      databaseUrl: 'postgresql://postgres@example.invalid/postgres',
      userIds: ['synthetic-user'],
      coins: 20_000,
      productSlug: 'chance_card_5050',
    })).rejects.toThrow('PROD GUARD');
  });

  it('permits only the bounded synthetic chance-card fixture', async () => {
    await expect(ensureCoinPurchaseFixtures({
      target: 'local',
      apiBase: 'http://127.0.0.1:8001',
      supabaseUrl: 'http://127.0.0.1:54321',
      databaseUrl: 'postgresql://postgres@127.0.0.1:54322/postgres',
      userIds: ['synthetic-user'],
      coins: 20_000,
      productSlug: 'coin_pack_100',
    })).rejects.toThrow('only permits chance_card_5050');
  });

  it('rejects a remote database even when the API target says local', async () => {
    await expect(ensureCoinPurchaseFixtures({
      target: 'local',
      apiBase: 'http://127.0.0.1:8001',
      supabaseUrl: 'http://127.0.0.1:54321',
      databaseUrl: 'postgresql://postgres@example.invalid/postgres',
      userIds: ['synthetic-user'],
      coins: 20_000,
      productSlug: 'chance_card_5050',
    })).rejects.toThrow('PROD GUARD');
  });
});
