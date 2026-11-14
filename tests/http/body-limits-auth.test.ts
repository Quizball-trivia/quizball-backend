import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

import '../setup.js';

const mocks = vi.hoisted(() => ({
  uploadImage: vi.fn((_req: unknown, res: { status(code: number): { json(body: unknown): void } }) => res.status(201).json({ ok: true })),
}));

vi.mock('../../src/core/geo.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/geo.js')>()),
  detectCountryFromRequest: vi.fn(async () => null),
}));

vi.mock('../../src/modules/campaign-quizzes/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/modules/campaign-quizzes/index.js')>();
  return { ...actual, adminCampaignQuizzesController: { ...actual.adminCampaignQuizzesController, uploadImage: mocks.uploadImage } };
});

import { createApp } from '../../src/app.js';
import { getAuthProvider } from '../../src/modules/auth/index.js';
import { usersService } from '../../src/modules/users/index.js';
import type { AuthIdentity } from '../../src/core/types.js';

type ResolvedUser = Awaited<ReturnType<typeof usersService.getOrCreateFromIdentity>>;

const MIB = 1024 * 1024;
const ROLES: Record<string, string> = { 'synthetic-admin-token': 'admin', 'synthetic-player-token': 'user' };

// The real auth middleware, with the token check and the user lookup it calls stubbed out.
describe('Admin large-body routes with the real auth middleware', () => {
  let app: Express;
  const verifyToken = vi.spyOn(getAuthProvider(), 'verifyToken');
  const getOrCreate = vi.spyOn(usersService, 'getOrCreateFromIdentity');

  beforeAll(() => {
    verifyToken.mockImplementation(async (token: string) => {
      if (!ROLES[token]) throw new Error('synthetic: unknown token');
      return { provider: 'supabase', subject: token, claims: {} } as AuthIdentity;
    });
    getOrCreate.mockImplementation(async (identity: AuthIdentity) =>
      ({ id: `user-${identity.subject}`, role: ROLES[identity.subject], country: 'GB' }) as unknown as ResolvedUser);
    app = createApp();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  const upload = { data_url: `data:image/webp;base64,${'A'.repeat(MIB + 256 * 1024)}`, kind: 'hero', slug: 'synthetic-page' };

  it('checks an admin token once although both the body gate and the router authenticate', async () => {
    const res = await request(app)
      .post('/api/v1/admin/campaign-quizzes/images')
      .set('Authorization', 'Bearer synthetic-admin-token')
      .send(upload);
    expect(res.status).toBe(201);
    expect(mocks.uploadImage).toHaveBeenCalledTimes(1);
    expect(verifyToken).toHaveBeenCalledTimes(1);
    expect(getOrCreate).toHaveBeenCalledTimes(1);
  });

  it('authenticates each request on its own', async () => {
    for (let i = 0; i < 2; i += 1) {
      const res = await request(app)
        .post('/api/v1/admin/campaign-quizzes/images')
        .set('Authorization', 'Bearer synthetic-admin-token')
        .send(upload);
      expect(res.status).toBe(201);
    }
    expect(verifyToken).toHaveBeenCalledTimes(2);
  });

  // The server may answer and close the socket while the client is still uploading; a reset counts as refused.
  const statusOrReset = async (req: Promise<{ status: number }>) => {
    try {
      return (await req).status;
    } catch (e) {
      expect((e as NodeJS.ErrnoException).code).toMatch(/^(ECONNRESET|EPIPE)$/);
      return 'reset';
    }
  };

  it('refuses a player with 403 and an anonymous caller with 401, before the upload handler', async () => {
    const player = await statusOrReset(
      request(app).post('/api/v1/admin/campaign-quizzes/images').set('Authorization', 'Bearer synthetic-player-token').send(upload),
    );
    expect([403, 'reset']).toContain(player);
    const anonymous = await statusOrReset(request(app).post('/api/v1/admin/campaign-quizzes/images').send(upload));
    expect([401, 'reset']).toContain(anonymous);
    expect(mocks.uploadImage).not.toHaveBeenCalled();
  });
});
