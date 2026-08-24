import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../setup.js';

import type { AuctionMatchState } from '../../src/modules/auction/auction-match-state.js';
import type { AuctionPlayerRanking } from '../../src/modules/auction/auction.types.js';

const matchesRepoMock = vi.hoisted(() => ({
  createAuctionMatch: vi.fn(),
  insertAuctionMatchPlayers: vi.fn(async () => {}),
  addCoins: vi.fn(async () => {}),
  addAuctionPoints: vi.fn(async () => {}),
}));

const matchesServiceMock = vi.hoisted(() => ({
  completeMatch: vi.fn(async () => {}),
}));

const usersRepoMock = vi.hoisted(() => ({
  create: vi.fn(async (input: { nickname: string }) => ({
    id: `ai-${input.nickname}`,
  })),
}));

vi.mock('../../src/modules/matches/matches.repo.js', () => ({
  matchesRepo: matchesRepoMock,
}));

vi.mock('../../src/modules/matches/matches.service.js', () => ({
  matchesService: matchesServiceMock,
}));

vi.mock('../../src/modules/users/users.repo.js', () => ({
  usersRepo: usersRepoMock,
}));

const {
  AUCTION_POINTS_BY_PLACEMENT,
  auctionPointsForPlacement,
  persistFinishedAuctionMatch,
} = await import('../../src/realtime/services/auction-persistence.service.js');

/** Ranking rows keep only the fields the persistence path actually reads. */
function ranking(overrides: Partial<AuctionPlayerRanking> & { rank: number }): AuctionPlayerRanking {
  return {
    seatId: overrides.seatId ?? `seat-${overrides.rank}`,
    userId: overrides.userId ?? null,
    displayName: overrides.displayName ?? `Player ${overrides.rank}`,
    isBot: overrides.isBot ?? false,
    totalTrueValue: overrides.totalTrueValue ?? 100,
    rank: overrides.rank,
    player: overrides.player,
  } as AuctionPlayerRanking;
}

function finishedState(
  rankings: AuctionPlayerRanking[],
  origin?: 'queue' | 'lobby'
): AuctionMatchState {
  return {
    matchId: 'match-1',
    version: 5,
    origin,
    phase: 'finished',
    rankings,
  } as unknown as AuctionMatchState;
}

beforeEach(() => {
  vi.clearAllMocks();
  matchesRepoMock.createAuctionMatch.mockResolvedValue({ id: 'match-1' });
});

describe('auctionPointsForPlacement', () => {
  it('maps placements to 50 / 30 / 10', () => {
    expect(auctionPointsForPlacement(1)).toBe(50);
    expect(auctionPointsForPlacement(2)).toBe(30);
    expect(auctionPointsForPlacement(3)).toBe(10);
    expect(AUCTION_POINTS_BY_PLACEMENT).toEqual({ 1: 50, 2: 30, 3: 10 });
  });

  it('awards nothing beyond 3rd place', () => {
    expect(auctionPointsForPlacement(4)).toBe(0);
    expect(auctionPointsForPlacement(0)).toBe(0);
  });

  it('never returns a negative amount (AP is award-only)', () => {
    for (const placement of [1, 2, 3, 4, 5]) {
      expect(auctionPointsForPlacement(placement)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('persistFinishedAuctionMatch — Auction Points', () => {
  it('awards 50/30/10 by placement in a queue match', async () => {
    const rewards = await persistFinishedAuctionMatch(finishedState([
      ranking({ rank: 1, userId: 'user-a' }),
      ranking({ rank: 2, userId: 'user-b' }),
      ranking({ rank: 3, userId: 'user-c' }),
    ], 'queue'));

    expect(rewards.apByUserId).toEqual({
      'user-a': 50,
      'user-b': 30,
      'user-c': 10,
    });
    expect(matchesRepoMock.addAuctionPoints).toHaveBeenCalledWith('user-a', 50);
    expect(matchesRepoMock.addAuctionPoints).toHaveBeenCalledWith('user-b', 30);
    expect(matchesRepoMock.addAuctionPoints).toHaveBeenCalledWith('user-c', 10);
  });

  it('treats a match with no origin as a queue match (back-compat)', async () => {
    const rewards = await persistFinishedAuctionMatch(finishedState([
      ranking({ rank: 1, userId: 'user-a' }),
    ], undefined));

    expect(rewards.apByUserId).toEqual({ 'user-a': 50 });
  });

  it('awards nothing for a lobby (friendly) match', async () => {
    const rewards = await persistFinishedAuctionMatch(finishedState([
      ranking({ rank: 1, userId: 'user-a' }),
      ranking({ rank: 2, userId: 'user-b' }),
    ], 'lobby'));

    // Omitted entirely (not an empty map) so the client hides AP for friendlies.
    expect(rewards.apByUserId).toBeUndefined();
    expect(matchesRepoMock.addAuctionPoints).not.toHaveBeenCalled();
    // Coins are unaffected — only AP is gated on origin.
    expect(rewards.coinsByUserId).toEqual({ 'user-a': 500, 'user-b': 300 });
  });

  it('reports a forfeiter as an explicit 0 and pays them nothing', async () => {
    const rewards = await persistFinishedAuctionMatch(finishedState([
      ranking({ rank: 1, userId: 'user-a' }),
      ranking({ rank: 2, userId: 'user-b', player: { forfeited: true } as never }),
    ], 'queue'));

    // 0 (present) rather than absent, so the client shows "0 AP" instead of
    // falling back to the friendly-match "hide AP" state.
    expect(rewards.apByUserId).toEqual({ 'user-a': 50, 'user-b': 0 });
    expect(matchesRepoMock.addAuctionPoints).not.toHaveBeenCalledWith('user-b', expect.anything());
    // And no coins either — forfeiting forfeits both rewards.
    expect(rewards.coinsByUserId).toEqual({ 'user-a': 500 });
  });

  it('awards nothing to bots', async () => {
    const rewards = await persistFinishedAuctionMatch(finishedState([
      ranking({ rank: 1, isBot: true, displayName: 'Bot One' }),
      ranking({ rank: 2, userId: 'user-b' }),
    ], 'queue'));

    expect(rewards.apByUserId).toEqual({ 'user-b': 30 });
    expect(matchesRepoMock.addAuctionPoints).toHaveBeenCalledTimes(1);
    expect(matchesRepoMock.addAuctionPoints).toHaveBeenCalledWith('user-b', 30);
  });

  it('awards exactly once — a re-finish hits the ON CONFLICT guard', async () => {
    const state = finishedState([
      ranking({ rank: 1, userId: 'user-a' }),
    ], 'queue');

    const first = await persistFinishedAuctionMatch(state);
    expect(first.apByUserId).toEqual({ 'user-a': 50 });
    expect(matchesRepoMock.addAuctionPoints).toHaveBeenCalledTimes(1);

    // Second call: the match row already exists, so createAuctionMatch returns
    // no row and every downstream award is skipped.
    matchesRepoMock.createAuctionMatch.mockResolvedValueOnce(undefined);
    const second = await persistFinishedAuctionMatch(state);

    expect(second.apByUserId).toBeUndefined();
    expect(matchesRepoMock.addAuctionPoints).toHaveBeenCalledTimes(1);
  });

  it('awards nothing when the match is not finished', async () => {
    const state = {
      ...finishedState([ranking({ rank: 1, userId: 'user-a' })], 'queue'),
      phase: 'bidding',
    } as unknown as AuctionMatchState;

    const rewards = await persistFinishedAuctionMatch(state);

    expect(rewards.apByUserId).toBeUndefined();
    expect(matchesRepoMock.addAuctionPoints).not.toHaveBeenCalled();
  });

  it('reports no AP when persistence fails', async () => {
    matchesRepoMock.createAuctionMatch.mockRejectedValueOnce(new Error('db down'));

    const rewards = await persistFinishedAuctionMatch(finishedState([
      ranking({ rank: 1, userId: 'user-a' }),
    ], 'queue'));

    expect(rewards.apByUserId).toBeUndefined();
    expect(rewards.coinsByUserId).toEqual({});
  });
});
