import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChaosLoginError, loginChaosUser } from '../../scripts/chaos/auth.js';

const config = {
  apiBase: 'http://127.0.0.1:8001',
  password: 'local-test-password',
};

afterEach(() => {
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

  it('marks a transient /users/me auth-introspection failure retryable', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'token' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'upstream auth unavailable' }), { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);

    const error = await loginChaosUser(config, 'user@example.com').catch((cause) => cause);
    expect(error).toBeInstanceOf(ChaosLoginError);
    expect(error).toMatchObject({ status: 401, retryable: true });
  });

  it('does not retry a valid response that is missing the required identity shape', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'token' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const error = await loginChaosUser(config, 'user@example.com').catch((cause) => cause);
    expect(error).toBeInstanceOf(ChaosLoginError);
    expect(error).toMatchObject({ status: 200, retryable: false });
  });
});
