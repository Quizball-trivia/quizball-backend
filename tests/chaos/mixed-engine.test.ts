import { afterEach, describe, expect, it, vi } from 'vitest';
import { runMixedRoutes } from '../../scripts/chaos/engine.js';
import type { ChaosRoute } from '../../scripts/chaos/routes.js';

const user = { email: 'chaos@example.com', password: 'pw', userId: 'u1', token: 'token' };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('weighted mixed traffic engine', () => {
  it('applies one total RPS budget across route weights', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const routes: ChaosRoute[] = [
      { name: 'hot', method: 'GET', path: '/hot', auth: 'none', mutates: false, weight: 3, group: 'public-read' },
      { name: 'cold', method: 'GET', path: '/cold', auth: 'none', mutates: false, weight: 1, group: 'public-read' },
    ];

    const metrics = await runMixedRoutes(routes, {
      apiBase: 'http://localhost',
      rps: 0,
      totalRps: 100,
      rampSec: 0,
      durationSec: 0.2,
      users: [user],
      maxInflight: 100,
      timeoutMs: 1_000,
      fixtures: { categoryId: 'c1', questionId: 'q1', featuredCategoryId: 'f1' },
    });

    const byName = Object.fromEntries(metrics.map((metric) => [metric.name, metric.sent]));
    expect(byName.hot + byName.cold).toBeGreaterThanOrEqual(18);
    expect(byName.hot / byName.cold).toBeCloseTo(3, 0);
  });

  it('does not count an explicitly expected business-state 409 as a client error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 409 })));
    const routes: ChaosRoute[] = [{
      name: 'daily.session',
      method: 'POST',
      path: '/daily/session',
      auth: 'bearer',
      mutates: true,
      weight: 1,
      expectedStatuses: [200, 409],
      group: 'session-write',
    }];

    const [metrics] = await runMixedRoutes(routes, {
      apiBase: 'http://localhost',
      rps: 0,
      totalRps: 20,
      rampSec: 0,
      durationSec: 0.15,
      users: [user],
      maxInflight: 100,
      timeoutMs: 1_000,
      fixtures: { categoryId: 'c1', questionId: 'q1', featuredCategoryId: 'f1' },
    });

    expect(metrics.statusHist['409']).toBeGreaterThan(0);
    expect(metrics.clientErrors).toBe(0);
  });
});
