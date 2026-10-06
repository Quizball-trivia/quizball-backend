import 'express-async-errors';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import express, { type Router } from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import '../setup.js';

/**
 * The partner token against the REAL route table: every route of every router mounted under /api/v1 is called with
 * a valid partner access token (bearer and cookie). None may send it to Supabase or resolve a user from it.
 */
vi.setConfig({ testTimeout: 120_000 });

const spies = vi.hoisted(() => ({ verifyToken: vi.fn(), getOrCreateFromIdentity: vi.fn() }));
vi.mock('../../src/modules/auth/supabase-auth-provider.js', () => ({
  getAuthProvider: () => ({ verifyToken: spies.verifyToken }),
  SupabaseAuthProvider: class {},
}));
vi.mock('../../src/modules/users/users.service.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/modules/users/users.service.js')>();
  return { ...original, usersService: { ...original.usersService, getOrCreateFromIdentity: spies.getOrCreateFromIdentity } };
});
// Handlers that are reached anyway (public routes) see an empty database instead of a real one.
vi.mock('../../src/db/index.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/db/index.js')>();
  const empty = () => Promise.resolve(Object.assign([], { count: 0 }));
  const sql: unknown = new Proxy(empty, {
    get: (_t, prop) => (prop === 'json' || prop === 'array' ? (v: unknown) => v : prop === 'then' ? undefined : () => sql),
    apply: () => empty(),
  });
  return { ...original, sql, withStatementTimeout: empty };
});
vi.mock('../../src/realtime/redis.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/realtime/redis.js')>()),
  getRedisClient: () => null,
}));

// The token's own ids differ from the path filler, so only a route that authenticated the token could echo them.
const PARTNER_PLAYER = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const PARTNER_SESSION = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

interface Layer { regexp: RegExp; handle: Router & { stack?: Layer[] }; route?: { path: unknown; methods: Record<string, boolean> } }

describe('partner tokens on every /api/v1 route', () => {
  it('are refused (401) everywhere, never reach Supabase and never authenticate a user', async () => {
    process.env.PARTNER_JWT_SECRET = 'inventory-partner-jwt-secret-32-bytes!!';
    const { signPartnerAccessToken } = await import('../../src/modules/partners/partner-token.js');
    const token = await signPartnerAccessToken({ slug: 'freecroco', environment: 'test' },
      { playerId: PARTNER_PLAYER, sessionId: PARTNER_SESSION },
      new Date(Date.now() + 600_000));
    const { routes } = await import('../../src/http/routes/index.js');
    const { errorHandler } = await import('../../src/http/middleware/error-handler.js');

    const indexSource = readFileSync(join(__dirname, '../../src/http/routes/index.ts'), 'utf8');
    const mounts = [...indexSource.matchAll(/router\.use\('(\/api\/v1\/[^']+)'/g)].map((m) => m[1]);
    expect(mounts.length).toBeGreaterThan(40);

    const ID = '6f1c2b0e-8a7d-4c3b-9e2f-1a2b3c4d5e6f';
    // Express 4 keeps only a regexp for a nested router's mount path: `^\/x\/?(?=\/|$)`.
    const mountOf = (re: RegExp) => re.source
      .replace(/^\^/, '').replace(/\\\/\?\(\?=\\\/\|\$\)$/, '').replace(/\(\?:\(\[\^\\\/\]\+\?\)\)/g, ID).replace(/\\\//g, '/');
    const calls: Array<{ method: string; path: string }> = [];
    const walk = (stack: Layer[], prefix: string) => {
      for (const sub of stack) {
        if (sub.route && typeof sub.route.path === 'string') {
          const path = sub.route.path.replace(/:[A-Za-z_]+(\([^)]*\))?\??/g, ID);
          for (const method of Object.keys(sub.route.methods)) calls.push({ method, path: `${prefix}${path === '/' ? '' : path}` });
        } else if (!sub.route && Array.isArray(sub.handle.stack)) {
          walk(sub.handle.stack, `${prefix}${mountOf(sub.regexp)}`);
        }
      }
    };
    const top = (routes as unknown as { stack: Layer[] }).stack;
    for (const mount of mounts) {
      // Exact mount match: a router mounted at the root (health, partner) matches every path.
      const layer = top.find((l) => !l.route && Array.isArray(l.handle.stack) && mountOf(l.regexp) === mount);
      expect(layer, `router for ${mount}`).toBeDefined();
      walk(layer!.handle.stack ?? [], mount);
    }
    expect(new Set(calls.map((c) => c.path.split('/')[3])).size).toBe(new Set(mounts.map((m) => m.split('/')[3])).size);
    expect(calls.length).toBeGreaterThan(250);

    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use(routes);
    app.use(errorHandler);

    const authenticated: string[] = [];
    const notRefused: string[] = [];
    for (const { method, path } of calls) {
      for (const credential of ['bearer', 'cookie'] as const) {
        let req = (request(app) as unknown as Record<string, (p: string) => request.Test>)[method](path).timeout(3_000);
        req = credential === 'bearer' ? req.set('Authorization', `Bearer ${token}`) : req.set('Cookie', `qb_access_token=${token}`);
        const res = await req.send({}).catch((error: { response?: request.Response }) => error.response ?? null);
        const body = JSON.stringify(res?.body ?? {});
        // Refused before any route runs, public and optional-auth routes included.
        if (res?.status !== 401) notRefused.push(`${method.toUpperCase()} ${path} (${credential}) → ${res?.status}`);
        if (res && res.status >= 200 && res.status < 300 && (body.includes(PARTNER_PLAYER) || body.includes(PARTNER_SESSION))) {
          authenticated.push(`${method.toUpperCase()} ${path}`);
        }
      }
    }
    expect(spies.verifyToken).not.toHaveBeenCalled();
    expect(spies.getOrCreateFromIdentity).not.toHaveBeenCalled();
    expect(authenticated).toEqual([]);
    expect(notRefused).toEqual([]);
  });
});
