import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const repo = vi.hoisted(() => ({ listForUser: vi.fn(), markSeen: vi.fn() }));
vi.mock('../../src/modules/weekend-league/wl-rewards.js', () => ({ wlRewardsRepo: repo }));
vi.mock('../../src/modules/weekend-league/weekend-league.service.js', () => ({ weekendLeagueService: {} }));

import { weekendLeagueController } from '../../src/modules/weekend-league/weekend-league.controller.js';
import { wlRewardIdParamSchema, wlRewardsResponseSchema } from '../../src/modules/weekend-league/weekend-league.schemas.js';

const USER = '11111111-1111-4111-8111-111111111111';
const REWARD = '22222222-2222-4222-8222-222222222222';

function call(handler: (req: Request, res: Response) => Promise<void>, req: Partial<Request>) {
  const json = vi.fn();
  return handler(req as Request, { json } as unknown as Response).then(() => json.mock.calls[0]?.[0]);
}

beforeEach(() => { repo.listForUser.mockReset(); repo.markSeen.mockReset(); });

describe('Weekend League rewards API', () => {
  it('returns the caller\'s receipts in the documented shape', async () => {
    repo.listForUser.mockResolvedValue([{
      id: REWARD, tournament_id: '33333333-3333-4333-8333-333333333333', week_key: '2026-10-03',
      user_id: USER, band: 'winner', human_rank: 1, coins: 40000, status: 'granted',
      items: [{ slug: 'avatar_jersey_wl_retro_home', avatarPartId: 'jersey_wl_retro_home', slot: 'jersey', alreadyOwned: false }],
      granted_at: '2026-10-04 12:00:00+00', seen_at: null,
    }]);
    const body = await call(weekendLeagueController.rewards, { user: { id: USER } } as Partial<Request>);

    expect(repo.listForUser).toHaveBeenCalledWith(USER);
    expect(wlRewardsResponseSchema.parse(body)).toEqual(body);
    expect(body.rewards[0]).toMatchObject({
      id: REWARD, weekKey: '2026-10-03', band: 'winner', finalRank: 1, coins: 40000, seen: false,
      items: [{ slug: 'avatar_jersey_wl_retro_home', avatarPartId: 'jersey_wl_retro_home', slot: 'jersey', alreadyOwned: false }],
    });
    expect(JSON.stringify(body)).not.toContain(USER);
  });

  it('acknowledges with the authenticated user id, never one from the request', async () => {
    repo.markSeen.mockResolvedValue(true);
    const body = await call(weekendLeagueController.rewardSeen, {
      user: { id: USER }, validated: { params: { rewardId: REWARD } }, body: { userId: 'someone-else' },
    } as unknown as Partial<Request>);
    expect(repo.markSeen).toHaveBeenCalledWith(USER, REWARD);
    expect(body).toEqual({ acknowledged: true });
  });

  it('rejects an unauthenticated caller before touching the store', async () => {
    await expect(call(weekendLeagueController.rewards, {})).rejects.toThrow(/Authentication required/);
    await expect(call(weekendLeagueController.rewardSeen, { validated: { params: { rewardId: REWARD } } } as unknown as Partial<Request>))
      .rejects.toThrow(/Authentication required/);
    expect(repo.listForUser).not.toHaveBeenCalled();
    expect(repo.markSeen).not.toHaveBeenCalled();
  });

  it('only accepts a uuid reward id', () => {
    expect(wlRewardIdParamSchema.safeParse({ rewardId: REWARD }).success).toBe(true);
    expect(wlRewardIdParamSchema.safeParse({ rewardId: '1 OR 1=1' }).success).toBe(false);
  });
});
