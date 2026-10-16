import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';

const mocks = vi.hoisted(() => ({ verify: vi.fn(), provision: vi.fn() }));
vi.mock('../../src/modules/auth/index.js', () => ({ getAuthProvider: () => ({ verifyToken: mocks.verify }) }));
vi.mock('../../src/modules/users/index.js', () => ({ usersService: { getOrCreateFromIdentity: mocks.provision } }));
vi.mock('../../src/modules/users/user-cache.js', () => ({ getCachedUser: () => ({ country: 'GE' }) }));
vi.mock('../../src/core/geo.js', () => ({ detectCountryFromRequest: vi.fn() }));
import { authenticateRequest } from '../../src/http/middleware/auth.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.verify.mockResolvedValue({ provider: 'supabase', subject: 'offline-subject', claims: {} });
  mocks.provision.mockResolvedValue({ id: 'offline-member' });
});
describe('first authenticated request carries signup source', () => {
  it.each(['web', 'android', 'ios'] as const)('passes explicit %s to the winning account provisioning call', async (platform) => {
    const req = { headers: { 'x-quizball-platform': platform } } as unknown as Request;
    await authenticateRequest(req, 'offline-token');
    expect(mocks.provision).toHaveBeenCalledWith(expect.any(Object), null,
      expect.objectContaining({ accountCreation: expect.objectContaining({ clientPlatform: platform }) }));
    expect(req.user?.id).toBe('offline-member');
  });
  it.each([undefined, ['android', 'ios'], 'android,ios'])('keeps missing or ambiguous headers unknown (%j)', async (platform) => {
    const req = { headers: { 'x-quizball-platform': platform } } as unknown as Request;
    await authenticateRequest(req, 'offline-token');
    expect(mocks.provision).toHaveBeenCalledWith(expect.any(Object), null,
      expect.objectContaining({ accountCreation: expect.objectContaining({ clientPlatform: 'unknown' }) }));
  });
});
