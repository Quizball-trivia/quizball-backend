import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules(); });

it('uses application IDs for game assertions and auth IDs only for account cleanup', async () => {
  vi.stubEnv('STAGING_SUPABASE_URL', 'https://auth.example.test');
  vi.stubEnv('STAGING_SUPABASE_SERVICE_ROLE_KEY', 'test-service-key');
  vi.stubEnv('STAGING_URL', 'https://api.example.test');
  const deleted: string[] = [];
  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'DELETE') { deleted.push(url); return new Response('{}'); }
    if (url.endsWith('/admin/users')) return new Response('{}');
    if (url.includes('/token?')) {
      const { email } = JSON.parse(String(init?.body));
      const seat = email.includes('-a@') ? 'a' : 'b';
      return Response.json({ access_token: `token-${seat}`, user: { id: `auth-${seat}` } });
    }
    if (url === 'https://api.example.test/api/v1/users/me') {
      const token = new Headers(init?.headers).get('Authorization');
      return Response.json({ id: token === 'Bearer token-a' ? 'app-a' : 'app-b' });
    }
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  const { bootstrapTestUsers, deleteTestUsers } = await import('../../game-regression/staging/auth-bootstrap.mjs');
  const users = await bootstrapTestUsers();
  expect(users.a.userId).toBe('app-a');
  expect(users.b.userId).toBe('app-b');
  await deleteTestUsers(users);
  expect(deleted).toEqual(['https://auth.example.test/auth/v1/admin/users/auth-a', 'https://auth.example.test/auth/v1/admin/users/auth-b']);
});
