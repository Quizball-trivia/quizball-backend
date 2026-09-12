/**
 * Guest seats (account-less friend rooms) get match history like everyone else
 * but never coins or Auction Points, and the finished-match replay must report
 * the same zero the settlement paid.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../setup.js';

const matchesRepo = { createAuctionMatch: vi.fn(), insertAuctionMatchPlayers: vi.fn(), addCoins: vi.fn(), addAuctionPoints: vi.fn() };
const matchesService = { completeMatch: vi.fn() };
const usersRepo = { create: vi.fn() };
vi.mock('../../src/modules/matches/matches.repo.js', () => ({ matchesRepo }));
vi.mock('../../src/modules/matches/matches.service.js', () => ({ matchesService }));
vi.mock('../../src/modules/users/users.repo.js', () => ({ usersRepo }));

const { persistFinishedAuctionMatch } = await import('../../src/realtime/services/auction-persistence.service.js');

const MEMBER = '22222222-2222-2222-2222-222222222222';
const GUEST = '33333333-3333-3333-3333-333333333333';

function finishedState(origin: 'lobby' | 'queue' = 'lobby') {
  return {
    matchId: 'match-g', phase: 'finished', origin,
    seats: [
      { seatId: 's1', userId: GUEST, isBot: false, isGuest: true, forfeited: false },
      { seatId: 's2', userId: MEMBER, isBot: false, forfeited: false },
    ],
    rankings: [
      { seatId: 's1', userId: GUEST, isBot: false, displayName: 'Mystery Keeper 4821', rank: 1, totalTrueValue: 300, player: { isGuest: true, forfeited: false, avatarUrl: null } },
      { seatId: 's2', userId: MEMBER, isBot: false, displayName: 'Member', rank: 2, totalTrueValue: 200, player: { forfeited: false, avatarUrl: null } },
      { seatId: 's3', userId: null, isBot: true, displayName: 'Bot', rank: 3, totalTrueValue: 100, player: { forfeited: false, avatarUrl: null } },
    ],
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  matchesRepo.createAuctionMatch.mockResolvedValue({ id: 'match-g' });
  matchesRepo.insertAuctionMatchPlayers.mockResolvedValue(undefined);
  matchesRepo.addCoins.mockResolvedValue(undefined);
  matchesRepo.addAuctionPoints.mockResolvedValue(undefined);
  matchesService.completeMatch.mockResolvedValue(undefined);
  usersRepo.create.mockResolvedValue({ id: 'minted-ai-user' });
});

describe('guest seats in auction: history yes, rewards no', () => {
  it('records the guest in match_players but credits coins only to the member', async () => {
    const rewards = await persistFinishedAuctionMatch(finishedState());
    const players = matchesRepo.insertAuctionMatchPlayers.mock.calls[0][1] as Array<{ userId: string }>;
    expect(players.map((p) => p.userId)).toContain(GUEST);
    expect(rewards.coinsByUserId[GUEST]).toBe(0);
    expect(rewards.coinsByUserId[MEMBER]).toBeGreaterThan(0);
    expect(matchesRepo.addCoins.mock.calls.map((c) => c[0])).toEqual([MEMBER]);
    expect(matchesRepo.addAuctionPoints).not.toHaveBeenCalled(); // friendly room: no AP for anyone
  });

  it('never pays AP to a guest even if a queue-origin state carried one', async () => {
    const rewards = await persistFinishedAuctionMatch(finishedState('queue'));
    expect(rewards.apByUserId?.[GUEST]).toBe(0);
    expect(matchesRepo.addAuctionPoints.mock.calls.map((c) => c[0])).toEqual([MEMBER]);
  });
});
