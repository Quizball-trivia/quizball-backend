import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

const state = vi.hoisted(() => ({ enabled: false, open: true, counts: new Map<string, number>(), fail: false }));
vi.mock('../../src/core/config.js', () => ({ config: { get GUEST_HTTP_ENABLED() { return state.enabled; } } }));
vi.mock('../../src/realtime/redis.js', () => ({ getRedisClient: () => ({
  get isOpen() { return state.open; },
  eval: async (_script: string, input: { keys: string[]; arguments: string[] }) => {
    if (state.fail) throw new Error('Redis unavailable');
    expect(input.arguments).toEqual(['3605']);
    const key = input.keys[0];
    const count = (state.counts.get(key) ?? 0) + 1;
    state.counts.set(key, count);
    return count;
  },
}) }));
import { guestHttpBudget, requireGuestHttpEnabled } from '../../src/http/middleware/guest-http-budget.js';

describe('guest HTTP rollout gate and shared budgets', () => {
  beforeEach(() => { state.enabled = false; state.open = true; state.fail = false; state.counts.clear(); });
  const req = {} as Request;
  const res = () => ({ setHeader: vi.fn() }) as unknown as Response;
  it('blocks disabled guest HTTP before any budget or downstream work', () => {
    const next = vi.fn();
    requireGuestHttpEnabled(req, res(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 503 }));
    expect(state.counts.size).toBe(0);
    state.enabled = true; next.mockClear();
    requireGuestHttpEnabled(req, res(), next);
    expect(next).toHaveBeenCalledWith(undefined);
  });
  it('shares a single budget across separate middleware instances and their restart', async () => {
    const first = guestHttpBudget('mint', 3, () => 'same-address');
    const second = guestHttpBudget('mint', 3, () => 'same-address');
    for (const handler of [first, second, first]) {
      const next = vi.fn(); await handler(req, res(), next); expect(next).toHaveBeenCalledWith();
    }
    const restarted = guestHttpBudget('mint', 3, () => 'same-address');
    const next = vi.fn(), response = res(); await restarted(req, response, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 429 }));
    expect(response.setHeader).toHaveBeenCalledWith('Retry-After', expect.any(String));
    const different = vi.fn(); await guestHttpBudget('mint', 3, () => 'different-address')(req, res(), different);
    expect(different).toHaveBeenCalledWith();
  });
  it.each(['disconnected', 'error'])('fails closed when Redis is %s', async mode => {
    state.open = mode !== 'disconnected'; state.fail = mode === 'error';
    const next = vi.fn() as NextFunction;
    await guestHttpBudget('principal', 240, () => 'verified-guest')(req, res(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 503 }));
    expect(state.counts.size).toBe(0);
  });
});
