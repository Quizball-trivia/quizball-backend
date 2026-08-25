/**
 * Persistent-bot SEATING for auction matches (reserveAuctionPersistentBots).
 *
 * Pins the selection contract the match-start path depends on:
 *   - flag on  → real roster bots, seated with their real userId + profile
 *   - flag off → nothing selected, so the caller runs the untouched ephemeral path
 *   - thin roster → PARTIAL fill (remaining seats go ephemeral), never a failure
 *   - one reservation key per seat, tagged mode:'auction', no bot seated twice
 *   - daily-cap accounting shared with ranked
 *   - every failure mode degrades to ephemeral instead of breaking match start
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import '../setup.js';

const selectionService = {
  selectAndReserve: vi.fn(),
  recordRecentlyFaced: vi.fn(),
};
const repo = { bumpMatchesTodayForAuction: vi.fn() };
const rankedService = { ensureProfile: vi.fn() };
const releaseAuctionReservations = vi.fn();

vi.mock('../../src/modules/synthetic-bots/synthetic-bot-selection.service.js', () => ({
  syntheticBotSelectionService: selectionService,
}));
vi.mock('../../src/modules/synthetic-bots/synthetic-bots.repo.js', () => ({
  syntheticBotsRepo: repo,
}));
vi.mock('../../src/modules/ranked/ranked.service.js', () => ({ rankedService }));
vi.mock('../../src/realtime/services/auction-bot-reservation.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/realtime/services/auction-bot-reservation.service.js')>();
  return { ...actual, releaseAuctionReservations };
});

const { config } = await import('../../src/core/config.js');
const configObj = config as unknown as { PERSISTENT_BOTS_ENABLED: boolean };
const { reserveAuctionPersistentBots } = await import(
  '../../src/realtime/services/auction-bot-selection.service.js'
);

function botRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    user_id: id,
    nickname: `nick-${id}`,
    avatar_url: `http://avatars/${id}.png`,
    base_skill: 0.7,
    consistency: 0.6,
    personality_seed: 42,
    ...overrides,
  };
}

function selection(id: string, overrides: Record<string, unknown> = {}) {
  return {
    bot: botRow(id, overrides),
    reservation: { botUserId: id, lobbyId: 'key', fence: 1 },
    relaxationLevel: 'strict',
    targetRp: 1000,
  };
}

const MATCH_ID = 'match-1';
const HUMANS = ['human-1'];

beforeEach(() => {
  vi.clearAllMocks();
  configObj.PERSISTENT_BOTS_ENABLED = true;
  rankedService.ensureProfile.mockResolvedValue({ user_id: 'human-1', rp: 1000 });
  selectionService.selectAndReserve.mockResolvedValue(selection('bot-1'));
  selectionService.recordRecentlyFaced.mockResolvedValue(undefined);
  repo.bumpMatchesTodayForAuction.mockResolvedValue(undefined);
});

describe('reserveAuctionPersistentBots — happy path', () => {
  it('seats persistent bots with their real userId, nickname, avatar and profile', async () => {
    selectionService.selectAndReserve
      .mockResolvedValueOnce(selection('bot-1'))
      .mockResolvedValueOnce(selection('bot-2', { base_skill: 0.2, consistency: 0.9, personality_seed: 7 }));

    const seats = await reserveAuctionPersistentBots({ matchId: MATCH_ID, count: 2, humanUserIds: HUMANS });

    expect(seats).toHaveLength(2);
    expect(seats[0]).toMatchObject({
      userId: 'bot-1',
      displayName: 'nick-bot-1',
      avatarUrl: 'http://avatars/bot-1.png',
      // base_skill 0.7 clamps to the auction skill cap (0.55): full-match sim
      // showed uncapped roster skill makes fallback opponents oppressive.
      botProfile: { baseSkill: 0.55, consistency: 0.6, personalitySeed: 42 },
    });
    expect(seats[1].botProfile).toEqual({ baseSkill: 0.2, consistency: 0.9, personalitySeed: 7 });
  });

  it('gives each seat a DISTINCT reservation key and tags it mode:auction', async () => {
    selectionService.selectAndReserve
      .mockResolvedValueOnce(selection('bot-1'))
      .mockResolvedValueOnce(selection('bot-2'));

    await reserveAuctionPersistentBots({ matchId: MATCH_ID, count: 2, humanUserIds: HUMANS });

    const [first, second] = selectionService.selectAndReserve.mock.calls.map((call) => call[0]);
    expect(first.lobbyId).not.toBe(second.lobbyId);
    expect(first.mode).toBe('auction');
    expect(second.mode).toBe('auction');
  });

  it('never seats the same bot twice in one match', async () => {
    selectionService.selectAndReserve
      .mockResolvedValueOnce(selection('bot-1'))
      .mockResolvedValueOnce(selection('bot-2'));

    await reserveAuctionPersistentBots({ matchId: MATCH_ID, count: 2, humanUserIds: HUMANS });

    const second = selectionService.selectAndReserve.mock.calls[1][0];
    expect(second.excludeBotUserIds).toContain('bot-1');
  });

  it('bumps the shared daily counter once per seated bot', async () => {
    selectionService.selectAndReserve
      .mockResolvedValueOnce(selection('bot-1'))
      .mockResolvedValueOnce(selection('bot-2'));

    await reserveAuctionPersistentBots({ matchId: MATCH_ID, count: 2, humanUserIds: HUMANS });

    expect(repo.bumpMatchesTodayForAuction).toHaveBeenCalledTimes(2);
    expect(repo.bumpMatchesTodayForAuction).toHaveBeenCalledWith('bot-1');
    expect(repo.bumpMatchesTodayForAuction).toHaveBeenCalledWith('bot-2');
  });
});

describe('reserveAuctionPersistentBots — fallback to ephemeral', () => {
  it('selects nothing when the flag is OFF (exact current behaviour)', async () => {
    configObj.PERSISTENT_BOTS_ENABLED = false;

    const seats = await reserveAuctionPersistentBots({ matchId: MATCH_ID, count: 2, humanUserIds: HUMANS });

    expect(seats).toEqual([]);
    expect(selectionService.selectAndReserve).not.toHaveBeenCalled();
  });

  it('does nothing when no bot seats are needed', async () => {
    const seats = await reserveAuctionPersistentBots({ matchId: MATCH_ID, count: 0, humanUserIds: HUMANS });

    expect(seats).toEqual([]);
    expect(selectionService.selectAndReserve).not.toHaveBeenCalled();
  });

  it('returns [] when the roster is exhausted immediately', async () => {
    selectionService.selectAndReserve.mockResolvedValue(null);

    const seats = await reserveAuctionPersistentBots({ matchId: MATCH_ID, count: 2, humanUserIds: HUMANS });

    expect(seats).toEqual([]);
  });

  it('fills PARTIALLY when the roster runs thin mid-selection', async () => {
    selectionService.selectAndReserve
      .mockResolvedValueOnce(selection('bot-1'))
      .mockResolvedValueOnce(null);

    const seats = await reserveAuctionPersistentBots({ matchId: MATCH_ID, count: 2, humanUserIds: HUMANS });

    // One persistent seat; the caller fills the remaining seat ephemerally.
    expect(seats).toHaveLength(1);
    expect(seats[0].userId).toBe('bot-1');
  });

  it('returns [] when there is no human to anchor selection on', async () => {
    const seats = await reserveAuctionPersistentBots({ matchId: MATCH_ID, count: 2, humanUserIds: [] });

    expect(seats).toEqual([]);
    expect(selectionService.selectAndReserve).not.toHaveBeenCalled();
  });
});

describe('reserveAuctionPersistentBots — failure isolation', () => {
  it('degrades to ephemeral (never throws) when selection throws', async () => {
    selectionService.selectAndReserve.mockRejectedValueOnce(new Error('db down'));

    await expect(
      reserveAuctionPersistentBots({ matchId: MATCH_ID, count: 2, humanUserIds: HUMANS }),
    ).resolves.toEqual([]);
  });

  it('releases already-acquired reservations when selection throws mid-way', async () => {
    selectionService.selectAndReserve
      .mockResolvedValueOnce(selection('bot-1'))
      .mockRejectedValueOnce(new Error('db down'));

    const seats = await reserveAuctionPersistentBots({ matchId: MATCH_ID, count: 2, humanUserIds: HUMANS });

    // No bot may be left reserved with no match to free it.
    expect(seats).toEqual([]);
    expect(releaseAuctionReservations).toHaveBeenCalledWith(MATCH_ID, 'seating_failed');
  });

  it('degrades to ephemeral when the human ranked profile cannot be loaded', async () => {
    rankedService.ensureProfile.mockRejectedValueOnce(new Error('no profile'));

    await expect(
      reserveAuctionPersistentBots({ matchId: MATCH_ID, count: 1, humanUserIds: HUMANS }),
    ).resolves.toEqual([]);
  });

  it('keeps the seat when the best-effort daily bump fails', async () => {
    repo.bumpMatchesTodayForAuction.mockRejectedValueOnce(new Error('bump failed'));

    const seats = await reserveAuctionPersistentBots({ matchId: MATCH_ID, count: 1, humanUserIds: HUMANS });

    expect(seats).toHaveLength(1);
    expect(seats[0].userId).toBe('bot-1');
  });
});
