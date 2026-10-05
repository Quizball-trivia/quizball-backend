import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

describe('GET /weekend-league/reward-policy', () => {
  it('reports the frames switch, so the prize card never promises an unpaid frame', async () => {
    const { config } = await import('../../src/core/config.js');
    const { weekendLeagueController } = await import('../../src/modules/weekend-league/weekend-league.controller.js');
    const flags = config as { WL_REWARD_FRAMES_ENABLED: boolean };
    const json = vi.fn();
    const res = { json } as unknown as Response;

    flags.WL_REWARD_FRAMES_ENABLED = false;
    weekendLeagueController.rewardPolicy({} as Request, res);
    expect(json).toHaveBeenLastCalledWith({ reward_frames: false });

    flags.WL_REWARD_FRAMES_ENABLED = true;
    weekendLeagueController.rewardPolicy({} as Request, res);
    expect(json).toHaveBeenLastCalledWith({ reward_frames: true });
    flags.WL_REWARD_FRAMES_ENABLED = false;
  });

  it('is mounted before the auth middleware (logged-out visitors can read it)', async () => {
    const { readFileSync } = await import('node:fs');
    const routes = readFileSync(new URL('../../src/http/routes/weekend-league.routes.ts', import.meta.url), 'utf8');
    expect(routes.indexOf("'/reward-policy'")).toBeGreaterThan(-1);
    expect(routes.indexOf("'/reward-policy'")).toBeLessThan(routes.indexOf('router.use(authMiddleware)'));
  });
});
