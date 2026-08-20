/**
 * BOT_PAIRING_MAX_RP_GAP env override for persistent-bot pairing.
 *
 * Lives in its own file because `config` is parsed once at module import: the
 * env var must be set BEFORE the config module is first loaded, which a
 * per-test mutation inside the main selection suite cannot guarantee.
 *
 * Widening the knob must re-admit a bot that the default ±300 ceiling rejects,
 * proving ops can relax pairing without a deploy if queue health demands it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import '../setup.js';

process.env.BOT_PAIRING_MAX_RP_GAP = '600';

const repo = {
  listEligibleBots: vi.fn(),
  listRankedPersistentOpponentHistory: vi.fn().mockResolvedValue([]),
};
const reservation = {
  isEnabled: vi.fn(),
  acquire: vi.fn(),
};
const redis = {
  isOpen: true,
  lRange: vi.fn().mockResolvedValue([]),
  lRem: vi.fn().mockResolvedValue(0),
  lPush: vi.fn().mockResolvedValue(1),
  lTrim: vi.fn().mockResolvedValue('OK'),
  expire: vi.fn().mockResolvedValue(1),
};

vi.mock('../../src/modules/synthetic-bots/synthetic-bots.repo.js', () => ({
  syntheticBotsRepo: repo,
}));
vi.mock('../../src/modules/synthetic-bots/reservation.service.js', () => ({
  reservationService: reservation,
}));
vi.mock('../../src/realtime/redis.js', () => ({
  getRedisClient: () => redis,
}));
vi.mock('../../src/modules/bots/tuning/tuning-config.service.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/modules/bots/tuning/tuning-config.service.js')
  >('../../src/modules/bots/tuning/tuning-config.service.js');
  return {
    ...actual,
    loadBotTuning: vi.fn().mockResolvedValue(actual.DEFAULT_RESOLVED_TUNING),
  };
});

const { syntheticBotSelectionService } = await import(
  '../../src/modules/synthetic-bots/synthetic-bot-selection.service.js'
);
const { config } = await import('../../src/core/config.js');

let seq = 0;
function bot(id: string, rp: number) {
  return {
    user_id: id,
    status: 'active',
    base_skill: 0.5,
    consistency: 0.5,
    speed_offset: 0,
    category_affinities: {},
    schedule: {},
    daily_cap: 6,
    matches_today: 0,
    matches_day: null,
    home_city: null,
    home_lat: null,
    home_lng: null,
    favorite_club: null,
    rename_propensity: 0,
    personality_seed: ++seq,
    governor_adjustment: 0,
    winrate_ema: null,
    winrate_samples: 0,
    governor_updated_at: null,
    last_selected_at: null,
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
    rp,
    tier: 'Bench',
    placement_status: 'placed',
    nickname: id,
    avatar_url: null,
    avatar_customization: null,
    country: 'GE',
  };
}

const placedHuman = {
  user_id: 'human',
  rp: 2700,
  tier: 'Rotation' as const,
  country: 'GE',
  placement_status: 'placed' as const,
  placement_required: 3,
  placement_played: 3,
  placement_wins: 2,
  placement_seed_rp: null,
  placement_perf_sum: 0,
  placement_points_for_sum: 0,
  placement_points_against_sum: 0,
  current_win_streak: 0,
  last_ranked_match_at: null,
  created_at: '2026-01-01',
  updated_at: '2026-01-01',
};

beforeEach(() => {
  vi.clearAllMocks();
  reservation.isEnabled.mockReturnValue(true);
  reservation.acquire.mockImplementation(async ({ botUserId }: { botUserId: string }) => ({
    botUserId,
    lobbyId: 'lobby',
    fence: 1,
  }));
  redis.lRange.mockResolvedValue([]);
});

describe('BOT_PAIRING_MAX_RP_GAP override', () => {
  it('parses the env override into config', () => {
    expect(config.BOT_PAIRING_MAX_RP_GAP).toBe(600);
  });

  it('admits a bot that the default ±300 ceiling would have rejected', async () => {
    // Gap of 500: outside the default ceiling, inside the widened one.
    repo.listEligibleBots.mockResolvedValue([bot('widened', 2200)]);
    const result = await syntheticBotSelectionService.selectAndReserve({
      humanUserId: 'human',
      humanProfile: placedHuman,
      lobbyId: 'lobby',
    });
    expect(result?.bot.user_id).toBe('widened');
  });

  it('still enforces the widened ceiling as a hard bound', async () => {
    // Gap of 700 — beyond even the override → ephemeral fallback.
    repo.listEligibleBots.mockResolvedValue([bot('way-off', 2000)]);
    const result = await syntheticBotSelectionService.selectAndReserve({
      humanUserId: 'human',
      humanProfile: placedHuman,
      lobbyId: 'lobby',
    });
    expect(result).toBeNull();
    expect(reservation.acquire).not.toHaveBeenCalled();
  });
});
