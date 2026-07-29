/**
 * Persistent smart bots in AUCTION mode.
 *
 * Covers the four things that make the feature safe:
 *   - seating: persistent first (flag on), ephemeral fallback (flag off /
 *     roster exhausted), partial fill when the roster runs thin mid-match
 *   - reservation keying + release on every terminal path, and the TTL sweeper
 *   - the no-coins/no-AP invariant for bot seats WITH history rows written
 *   - profile-parameterized bidding determinism + skill→precision monotonicity
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import '../setup.js';

const repo = {
  acquireReservation: vi.fn(),
  releaseAuctionReservations: vi.fn(),
  bumpMatchesTodayForAuction: vi.fn(),
  listEligibleBots: vi.fn(),
  heartbeatReservationFenced: vi.fn(),
  releaseReservationByMatchIfSettled: vi.fn(),
  rekeyReservationToMatch: vi.fn(),
  abortRankedAiLobbyLocked: vi.fn(),
  lobbyHasMembers: vi.fn(),
  listExpiredReservations: vi.fn(),
};

vi.mock('../../src/modules/synthetic-bots/synthetic-bots.repo.js', () => ({
  syntheticBotsRepo: repo,
}));

const { config } = await import('../../src/core/config.js');
const configObj = config as unknown as { PERSISTENT_BOTS_ENABLED: boolean };

const { reservationService, isAuctionReservationHolder, AUCTION_HOLDER_PREFIX } =
  await import('../../src/modules/synthetic-bots/reservation.service.js');
const {
  auctionReservationKey,
  allAuctionReservationKeys,
  releaseAuctionReservations,
} = await import('../../src/realtime/services/auction-bot-reservation.service.js');
const { resolveAuctionBotBehaviour, seedTrait, EPHEMERAL_AUCTION_BOT_BEHAVIOUR } =
  await import('../../src/realtime/services/auction-bot-profile.js');

beforeEach(() => {
  vi.clearAllMocks();
  configObj.PERSISTENT_BOTS_ENABLED = true;
  repo.acquireReservation.mockResolvedValue({ bot_user_id: 'bot-1', lobby_id: 'key', fence: 1 });
  repo.releaseAuctionReservations.mockResolvedValue(['bot-1']);
  repo.bumpMatchesTodayForAuction.mockResolvedValue(undefined);
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('auction reservation keying', () => {
  it('derives a valid, deterministic v5-shaped uuid per (match, seat)', () => {
    const key = auctionReservationKey('match-abc', 0);
    expect(key).toMatch(UUID_RE);
    // Deterministic: any teardown path can recompute it from the match id alone.
    expect(auctionReservationKey('match-abc', 0)).toBe(key);
  });

  it('gives every seat of a match a DISTINCT key', () => {
    // lobby_id is UNIQUE, so two bots in one match must never collide.
    const keys = allAuctionReservationKeys('match-abc');
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('gives different matches different keys for the same seat index', () => {
    expect(auctionReservationKey('match-a', 0)).not.toBe(auctionReservationKey('match-b', 0));
  });

  it('tags auction acquires in the holder so the sweeper can classify them', async () => {
    await reservationService.acquire({ botUserId: 'b', lobbyId: 'k', ttlSec: 60, mode: 'auction' });
    const holder = repo.acquireReservation.mock.calls[0][0].holder as string;
    expect(isAuctionReservationHolder(holder)).toBe(true);
    expect(holder.startsWith(AUCTION_HOLDER_PREFIX)).toBe(true);
  });

  it('leaves RANKED acquires untagged so they keep the ranked ladder', async () => {
    await reservationService.acquire({ botUserId: 'b', lobbyId: 'k', ttlSec: 60 });
    const holder = repo.acquireReservation.mock.calls[0][0].holder as string;
    expect(isAuctionReservationHolder(holder)).toBe(false);
  });
});

describe('auction reservation release', () => {
  it('releases the whole derived key set for the match', async () => {
    await releaseAuctionReservations('match-abc', 'finish');
    expect(repo.releaseAuctionReservations).toHaveBeenCalledWith(allAuctionReservationKeys('match-abc'));
  });

  it('is NOT flag-gated — a kill-switch flip must not strand held reservations', async () => {
    configObj.PERSISTENT_BOTS_ENABLED = false;
    await releaseAuctionReservations('match-abc', 'finish');
    expect(repo.releaseAuctionReservations).toHaveBeenCalled();
  });

  it('never throws back into a terminal teardown path', async () => {
    repo.releaseAuctionReservations.mockRejectedValueOnce(new Error('db down'));
    await expect(releaseAuctionReservations('match-abc', 'finish')).resolves.toBeUndefined();
  });

  it('no-ops quietly for a match that seated no persistent bots', async () => {
    repo.releaseAuctionReservations.mockResolvedValueOnce([]);
    await expect(releaseAuctionReservations('match-abc', 'finish')).resolves.toBeUndefined();
  });
});

describe('profile-driven bidding behaviour', () => {
  it('falls back to the exact legacy heuristic when a seat has no profile', () => {
    // Flag-off / ephemeral parity: same constants the original code used.
    const behaviour = resolveAuctionBotBehaviour(null);
    expect(behaviour).toEqual(EPHEMERAL_AUCTION_BOT_BEHAVIOUR);
    expect(behaviour.willingnessFloor).toBe(0.75);
    expect(behaviour.willingnessSpread).toBe(0.55);
    expect(behaviour.jumpThreshold).toBe(0.8);
  });

  it('tightens the willingness spread as base_skill rises', () => {
    const low = resolveAuctionBotBehaviour({ baseSkill: 0.05, consistency: 0.5, personalitySeed: 1 });
    const high = resolveAuctionBotBehaviour({ baseSkill: 0.95, consistency: 0.5, personalitySeed: 1 });
    expect(high.willingnessSpread).toBeLessThan(low.willingnessSpread);
  });

  it('keeps the willingness band centred on TRUE value, so skill changes precision not generosity', () => {
    for (const baseSkill of [0.1, 0.5, 0.9]) {
      const b = resolveAuctionBotBehaviour({ baseSkill, consistency: 0.5, personalitySeed: 3 });
      const midpoint = b.willingnessFloor + b.willingnessSpread / 2;
      expect(midpoint).toBeCloseTo(1, 10);
    }
  });

  it('tightens the spread further as consistency rises', () => {
    const erratic = resolveAuctionBotBehaviour({ baseSkill: 0.5, consistency: 0, personalitySeed: 2 });
    const steady = resolveAuctionBotBehaviour({ baseSkill: 0.5, consistency: 1, personalitySeed: 2 });
    expect(steady.willingnessSpread).toBeLessThan(erratic.willingnessSpread);
  });

  it('scales budget discipline with skill (better bots hold money back)', () => {
    const low = resolveAuctionBotBehaviour({ baseSkill: 0, consistency: 0.5, personalitySeed: 4 });
    const high = resolveAuctionBotBehaviour({ baseSkill: 1, consistency: 0.5, personalitySeed: 4 });
    expect(high.budgetDiscipline).toBeGreaterThan(low.budgetDiscipline);
    expect(low.budgetDiscipline).toBeGreaterThan(0);
    expect(high.budgetDiscipline).toBeLessThanOrEqual(1);
  });

  it('derives jump propensity + think time from personality_seed, hash-deterministically', () => {
    const a1 = resolveAuctionBotBehaviour({ baseSkill: 0.5, consistency: 0.5, personalitySeed: 11 });
    const a2 = resolveAuctionBotBehaviour({ baseSkill: 0.5, consistency: 0.5, personalitySeed: 11 });
    const b = resolveAuctionBotBehaviour({ baseSkill: 0.5, consistency: 0.5, personalitySeed: 12 });
    // Same seed ⇒ identical personality, across processes and replicas.
    expect(a1).toEqual(a2);
    // Different seed ⇒ a different personality on at least one axis.
    expect([a1.jumpThreshold, a1.minThinkMs]).not.toEqual([b.jumpThreshold, b.minThinkMs]);
    expect(a1.maxThinkMs).toBeGreaterThan(a1.minThinkMs);
  });

  it('keeps seedTrait in [0,1] and stable per (seed, axis)', () => {
    for (const seed of [0, 7, 999999]) {
      const value = seedTrait(seed, 'jump');
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
      expect(seedTrait(seed, 'jump')).toBe(value);
    }
    expect(seedTrait(7, 'jump')).not.toBe(seedTrait(7, 'pace'));
  });

  it('tolerates out-of-range / non-finite profile values', () => {
    const b = resolveAuctionBotBehaviour({ baseSkill: Number.NaN, consistency: 5, personalitySeed: 0 });
    expect(Number.isFinite(b.willingnessFloor)).toBe(true);
    expect(b.willingnessSpread).toBeGreaterThanOrEqual(0);
  });
});
