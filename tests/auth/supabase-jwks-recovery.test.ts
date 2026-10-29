import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ verify: vi.fn() }));
vi.mock('jose', () => ({ createRemoteJWKSet: () => () => undefined, jwtVerify: mock.verify }));
vi.mock('dotenv', () => ({ config: () => ({ parsed: {} }) }));
beforeEach(() => { vi.resetModules(); mock.verify.mockReset(); vi.stubEnv('SUPABASE_JWKS_URL', 'https://test.supabase.co/auth/v1/.well-known/jwks.json'); });
afterEach(() => vi.unstubAllEnvs());
it.each(['ERR_JWKS_TIMEOUT', 'ERR_JOSE_GENERIC'])('preserves sessions on temporary key-service error %s', async code => {
  mock.verify.mockRejectedValueOnce(Object.assign(new Error('key service unavailable'), { code }));
  const { SupabaseAuthProvider } = await import('../../src/modules/auth/supabase-auth-provider.js');
  await expect(new SupabaseAuthProvider().verifyToken('test')).rejects.toMatchObject({ statusCode: 503 });
});
it.each(['ERR_JWT_EXPIRED', 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED', 'ERR_JWKS_NO_MATCHING_KEY'])('still refuses invalid tokens: %s', async code => {
  mock.verify.mockRejectedValueOnce(Object.assign(new Error('invalid token'), { code }));
  const { SupabaseAuthProvider } = await import('../../src/modules/auth/supabase-auth-provider.js');
  await expect(new SupabaseAuthProvider().verifyToken('test')).rejects.toMatchObject({ statusCode: 401 });
});
