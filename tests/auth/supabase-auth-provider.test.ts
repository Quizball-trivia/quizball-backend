import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function makeToken(expSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url');
  return `${header}.${payload}.signature`;
}

function userResponse(id = 'supabase-user-1'): Response {
  return new Response(JSON.stringify({
    id,
    email: `${id}@example.com`,
    phone: null,
    phone_confirmed_at: null,
    app_metadata: { provider: 'email' },
    user_metadata: { name: 'Test User' },
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

async function createProvider() {
  vi.resetModules();
  delete process.env.SUPABASE_JWKS_URL;
  const { SupabaseAuthProvider } = await import('../../src/modules/auth/supabase-auth-provider.js');
  return new SupabaseAuthProvider();
}

describe('SupabaseAuthProvider introspection cache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-06T12:00:00.000Z'));
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('caches successful introspection by token until expiry', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(userResponse());
    const provider = await createProvider();
    const token = makeToken(Math.floor(Date.now() / 1000) + 120);

    const first = await provider.verifyToken(token);
    const second = await provider.verifyToken(token);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
  });

  it('expires cached introspection after the 60 second max ttl', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(userResponse('user-a'))
      .mockResolvedValueOnce(userResponse('user-b'));
    const provider = await createProvider();
    const token = makeToken(Math.floor(Date.now() / 1000) + 120);

    await provider.verifyToken(token);
    vi.advanceTimersByTime(61_000);
    const second = await provider.verifyToken(token);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(second.subject).toBe('user-b');
  });

  it('does not cache failed introspection', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'bad token' }), { status: 401 }))
      .mockResolvedValueOnce(userResponse('user-after-failure'));
    const provider = await createProvider();
    const token = makeToken(Math.floor(Date.now() / 1000) + 120);

    await expect(provider.verifyToken(token)).rejects.toThrow('Invalid or expired token');
    const second = await provider.verifyToken(token);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(second.subject).toBe('user-after-failure');
  });

  it('single-flights concurrent introspection for the same token', async () => {
    const fetchMock = vi.mocked(fetch);
    let resolveFetch: (value: Response) => void = () => {};
    fetchMock.mockImplementationOnce(
      () => new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );
    const provider = await createProvider();
    const token = makeToken(Math.floor(Date.now() / 1000) + 120);

    const first = provider.verifyToken(token);
    const second = provider.verifyToken(token);
    const third = provider.verifyToken(token);
    resolveFetch(userResponse('single-flight-user'));

    await expect(Promise.all([first, second, third])).resolves.toEqual([
      expect.objectContaining({ subject: 'single-flight-user' }),
      expect.objectContaining({ subject: 'single-flight-user' }),
      expect.objectContaining({ subject: 'single-flight-user' }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
