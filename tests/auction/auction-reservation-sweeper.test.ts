/**
 * TTL reconciliation for AUCTION reservations.
 *
 * The auction case is the dangerous one: an auction match has NO `matches` row
 * until it FINISHES, so the ranked settlement gate ("no match row ⇒ settled")
 * would free a bot that is still bidding. Auction rows are therefore classified
 * by their holder tag and reconciled against REDIS instead.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import '../setup.js';

const repo = {
  listExpiredReservations: vi.fn(),
  heartbeatReservationFenced: vi.fn(),
  releaseAuctionReservations: vi.fn(),
  releaseReservationByMatchIfSettled: vi.fn(),
  rekeyReservationToMatch: vi.fn(),
  abortRankedAiLobbyLocked: vi.fn(),
  lobbyHasMembers: vi.fn(),
};
const matchesRepo = { getMatch: vi.fn(), getActiveMatchForLobby: vi.fn() };
const lobbiesRepo = { getById: vi.fn() };
const auctionStateStore = { listActiveMatchIds: vi.fn() };

vi.mock('../../src/modules/synthetic-bots/synthetic-bots.repo.js', () => ({ syntheticBotsRepo: repo }));
vi.mock('../../src/modules/matches/matches.repo.js', () => ({ matchesRepo }));
vi.mock('../../src/modules/lobbies/lobbies.repo.js', () => ({ lobbiesRepo }));
vi.mock('../../src/modules/auction/auction-state.store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/modules/auction/auction-state.store.js')>();
  return { ...actual, auctionStateStore };
});

const { AUCTION_HOLDER_PREFIX } = await import('../../src/modules/synthetic-bots/reservation.service.js');
const { auctionReservationKey } = await import('../../src/realtime/services/auction-bot-reservation.service.js');
const { runReservationSweep } = await import(
  '../../src/realtime/services/synthetic-bot-reservation-sweeper.service.js'
);

const LIVE_MATCH = 'auction-match-live';
const DEAD_MATCH = 'auction-match-dead';

function auctionReservation(matchId: string) {
  return {
    bot_user_id: 'bot-1',
    lobby_id: auctionReservationKey(matchId, 0),
    match_id: null,
    holder: `${AUCTION_HOLDER_PREFIX}persistent-bot:1:abcd`,
    fence: 3,
    acquired_at: new Date(Date.now() - 60_000).toISOString(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  repo.heartbeatReservationFenced.mockResolvedValue(true);
  repo.releaseAuctionReservations.mockResolvedValue(['bot-1']);
  auctionStateStore.listActiveMatchIds.mockResolvedValue([LIVE_MATCH]);
});

describe('auction reservations in the TTL sweeper', () => {
  it('NEVER releases a bot whose auction match is still live in Redis', async () => {
    repo.listExpiredReservations.mockResolvedValue([auctionReservation(LIVE_MATCH)]);

    await runReservationSweep();

    expect(repo.releaseAuctionReservations).not.toHaveBeenCalled();
    // Expired-but-live → extend the lease (fenced) instead.
    expect(repo.heartbeatReservationFenced).toHaveBeenCalledWith(
      expect.objectContaining({ botUserId: 'bot-1', expectedFence: 3 }),
    );
  });

  it('reaps a reservation whose auction match state is gone', async () => {
    repo.listExpiredReservations.mockResolvedValue([auctionReservation(DEAD_MATCH)]);

    await runReservationSweep();

    expect(repo.releaseAuctionReservations).toHaveBeenCalledWith([auctionReservationKey(DEAD_MATCH, 0)]);
  });

  it('never routes an auction row through the RANKED settlement gate', async () => {
    // The ranked gate would treat "no matches row" as settled and free a live bot.
    repo.listExpiredReservations.mockResolvedValue([auctionReservation(DEAD_MATCH)]);

    await runReservationSweep();

    expect(repo.releaseReservationByMatchIfSettled).not.toHaveBeenCalled();
    expect(repo.abortRankedAiLobbyLocked).not.toHaveBeenCalled();
  });

  it('fails CLOSED: treats the reservation as live when Redis is unreachable', async () => {
    auctionStateStore.listActiveMatchIds.mockRejectedValueOnce(new Error('redis down'));
    repo.listExpiredReservations.mockResolvedValue([auctionReservation(DEAD_MATCH)]);

    await runReservationSweep();

    // A Redis blip must never free a bot that may still be mid-match.
    expect(repo.releaseAuctionReservations).not.toHaveBeenCalled();
  });

  it('still reconciles RANKED reservations through the ranked ladder', async () => {
    repo.listExpiredReservations.mockResolvedValue([{
      bot_user_id: 'bot-2',
      lobby_id: '99999999-9999-9999-9999-999999999999',
      match_id: 'ranked-match-1',
      holder: 'persistent-bot:1:abcd', // untagged ⇒ ranked
      fence: 4,
      acquired_at: new Date().toISOString(),
    }]);
    matchesRepo.getMatch.mockResolvedValue({ id: 'ranked-match-1', status: 'completed' });
    repo.releaseReservationByMatchIfSettled.mockResolvedValue('bot-2');

    await runReservationSweep();

    expect(repo.releaseReservationByMatchIfSettled).toHaveBeenCalledWith('ranked-match-1');
    expect(repo.releaseAuctionReservations).not.toHaveBeenCalled();
  });

  it('isolates a failing row so the rest of the batch still sweeps', async () => {
    repo.listExpiredReservations.mockResolvedValue([
      auctionReservation(DEAD_MATCH),
      auctionReservation('auction-match-dead-2'),
    ]);
    repo.releaseAuctionReservations.mockRejectedValueOnce(new Error('db down'));

    await expect(runReservationSweep()).resolves.toBeUndefined();
    expect(repo.releaseAuctionReservations).toHaveBeenCalledTimes(2);
  });
});
