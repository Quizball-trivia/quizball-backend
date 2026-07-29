/**
 * The central product invariant for persistent bots in auction:
 *
 *   a persistent-bot seat DOES get matches/match_players history rows under its
 *   REAL user id (so auction matches show in the bot's public history and the
 *   roster stays human-passing), but earns NO coins and NO Auction Points and so
 *   never reaches the auction leaderboard — which has no rubber-band governor
 *   yet (the be#175 risk class).
 *
 * Also pins that ephemeral bots still mint a throwaway is_ai user, and that the
 * finished-match replay stays consistent with what persistence actually paid.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import '../setup.js';

const matchesRepo = {
  createAuctionMatch: vi.fn(),
  insertAuctionMatchPlayers: vi.fn(),
  addCoins: vi.fn(),
  addAuctionPoints: vi.fn(),
};
const matchesService = { completeMatch: vi.fn() };
const usersRepo = { create: vi.fn() };

vi.mock('../../src/modules/matches/matches.repo.js', () => ({ matchesRepo }));
vi.mock('../../src/modules/matches/matches.service.js', () => ({ matchesService }));
vi.mock('../../src/modules/users/users.repo.js', () => ({ usersRepo }));

const { persistFinishedAuctionMatch } = await import(
  '../../src/realtime/services/auction-persistence.service.js'
);

const PERSISTENT_BOT_ID = '11111111-1111-1111-1111-111111111111';
const HUMAN_ID = '22222222-2222-2222-2222-222222222222';

function seat(overrides: Record<string, unknown> = {}) {
  return { forfeited: false, avatarUrl: null, ...overrides };
}

/** A finished 3-seat match: one human, one persistent bot, one ephemeral bot. */
function finishedState() {
  return {
    matchId: 'match-1',
    phase: 'finished',
    origin: 'queue',
    seats: [],
    rankings: [
      { seatId: 's1', userId: HUMAN_ID, isBot: false, displayName: 'Human', rank: 1, totalTrueValue: 300, player: seat() },
      { seatId: 's2', userId: PERSISTENT_BOT_ID, isBot: true, displayName: 'RosterBot', rank: 2, totalTrueValue: 200, player: seat() },
      { seatId: 's3', userId: null, isBot: true, displayName: 'EphemeralBot', rank: 3, totalTrueValue: 100, player: seat() },
    ],
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  matchesRepo.createAuctionMatch.mockResolvedValue({ id: 'match-1' });
  matchesRepo.insertAuctionMatchPlayers.mockResolvedValue(undefined);
  matchesRepo.addCoins.mockResolvedValue(undefined);
  matchesRepo.addAuctionPoints.mockResolvedValue(undefined);
  matchesService.completeMatch.mockResolvedValue(undefined);
  usersRepo.create.mockResolvedValue({ id: 'minted-ai-user' });
});

describe('persistent bots in auction: history yes, rewards no', () => {
  it('writes a match_players row for the persistent bot under its REAL user id', async () => {
    await persistFinishedAuctionMatch(finishedState());

    const players = matchesRepo.insertAuctionMatchPlayers.mock.calls[0][1] as Array<{ userId: string }>;
    expect(players.map((p) => p.userId)).toContain(PERSISTENT_BOT_ID);
  });

  it('does NOT mint a throwaway ai user for the persistent bot (it already has one)', async () => {
    await persistFinishedAuctionMatch(finishedState());

    // Exactly one mint: for the EPHEMERAL bot only.
    expect(usersRepo.create).toHaveBeenCalledTimes(1);
    expect(usersRepo.create.mock.calls[0][0]).toMatchObject({ nickname: 'EphemeralBot' });
  });

  it('pays the persistent bot NO coins and NO auction points', async () => {
    const rewards = await persistFinishedAuctionMatch(finishedState());

    expect(rewards.coinsByUserId[PERSISTENT_BOT_ID]).toBeUndefined();
    expect(rewards.apByUserId?.[PERSISTENT_BOT_ID]).toBeUndefined();

    const creditedIds = matchesRepo.addCoins.mock.calls.map((call) => call[0]);
    expect(creditedIds).not.toContain(PERSISTENT_BOT_ID);
    const apIds = matchesRepo.addAuctionPoints.mock.calls.map((call) => call[0]);
    expect(apIds).not.toContain(PERSISTENT_BOT_ID);
  });

  it('still pays the human normally (bots must not change human economics)', async () => {
    const rewards = await persistFinishedAuctionMatch(finishedState());

    expect(rewards.coinsByUserId[HUMAN_ID]).toBe(500); // 1st place
    expect(rewards.apByUserId?.[HUMAN_ID]).toBe(50);
    expect(matchesRepo.addCoins).toHaveBeenCalledWith(HUMAN_ID, 500);
    expect(matchesRepo.addAuctionPoints).toHaveBeenCalledWith(HUMAN_ID, 50);
  });

  it('credits coins/AP to exactly ONE user — the human', async () => {
    await persistFinishedAuctionMatch(finishedState());
    expect(matchesRepo.addCoins).toHaveBeenCalledTimes(1);
    expect(matchesRepo.addAuctionPoints).toHaveBeenCalledTimes(1);
  });

  it('lets a bot win the match without earning anything', async () => {
    const state = finishedState() as unknown as { rankings: Array<Record<string, unknown>> };
    // Bot takes 1st, human 2nd.
    state.rankings[0].rank = 2;
    state.rankings[1].rank = 1;

    const rewards = await persistFinishedAuctionMatch(state as never);

    expect(rewards.coinsByUserId[PERSISTENT_BOT_ID]).toBeUndefined();
    expect(rewards.apByUserId?.[PERSISTENT_BOT_ID]).toBeUndefined();
    // The human still gets its 2nd-place rewards.
    expect(rewards.apByUserId?.[HUMAN_ID]).toBe(30);
  });

  it('is idempotent — a re-finish pays nothing twice', async () => {
    matchesRepo.createAuctionMatch.mockResolvedValueOnce(undefined);
    const rewards = await persistFinishedAuctionMatch(finishedState());
    expect(rewards.coinsByUserId).toEqual({});
    expect(matchesRepo.addCoins).not.toHaveBeenCalled();
  });
});
