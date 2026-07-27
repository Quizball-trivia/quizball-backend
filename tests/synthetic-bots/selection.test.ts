/**
 * Unit tests for persistent-bot selection (PR7) with mocked seams:
 *   - flag OFF → no selection, no repo/redis calls (inertness)
 *   - empty roster → null (ephemeral fallback), no acquire attempted
 *   - nearest-RP widening picks the closest bot to the human's target
 *   - eligibility ladder relaxes in order: recently-faced → daily cap → schedule
 *   - one-winner acquire race: a lost acquire falls through to the next candidate
 *   - ladder exhausted (all acquires lost) → null
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import '../setup.js';

const repo = {
  listEligibleBots: vi.fn(),
};
const reservation = {
  isEnabled: vi.fn(),
  acquire: vi.fn(),
};
const redis = {
  isOpen: true,
  lRange: vi.fn().mockResolvedValue([]),
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

const { syntheticBotSelectionService } = await import(
  '../../src/modules/synthetic-bots/synthetic-bot-selection.service.js'
);

type BotOpts = Partial<{
  rp: number;
  daily_cap: number;
  matches_today: number;
  matches_day: string | null;
  status: string;
  schedule: unknown;
}>;
// Roster day = Tbilisi calendar date after shifting back 7h (matches the
// service's currentRosterDay). A bot whose matches_day equals this counts its
// matches_today against the cap; a stale day is treated as 0.
function rosterDay(): string {
  const shifted = new Date(Date.now() - 7 * 60 * 60 * 1000);
  return shifted.toLocaleDateString('en-CA', { timeZone: 'Asia/Tbilisi' });
}

let seq = 0;
function bot(id: string, opts: BotOpts = {}) {
  return {
    user_id: id,
    status: opts.status ?? 'active',
    base_skill: 0.5,
    consistency: 0.5,
    speed_offset: 0,
    category_affinities: {},
    schedule: opts.schedule ?? {},
    daily_cap: opts.daily_cap ?? 6,
    matches_today: opts.matches_today ?? 0,
    matches_day: opts.matches_day ?? null,
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
    rp: opts.rp ?? 1000,
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
  rp: 1500,
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

describe('flag-off inertness', () => {
  it('returns null and never touches the repo/redis when disabled', async () => {
    reservation.isEnabled.mockReturnValue(false);
    const result = await syntheticBotSelectionService.selectAndReserve({
      humanUserId: 'human',
      humanProfile: placedHuman,
      lobbyId: 'lobby',
    });
    expect(result).toBeNull();
    expect(repo.listEligibleBots).not.toHaveBeenCalled();
    expect(reservation.acquire).not.toHaveBeenCalled();
  });
});

describe('empty roster', () => {
  it('returns null (ephemeral fallback) without attempting an acquire', async () => {
    repo.listEligibleBots.mockResolvedValue([]);
    const result = await syntheticBotSelectionService.selectAndReserve({
      humanUserId: 'human',
      humanProfile: placedHuman,
      lobbyId: 'lobby',
    });
    expect(result).toBeNull();
    expect(reservation.acquire).not.toHaveBeenCalled();
  });
});

describe('nearest-RP widening', () => {
  it('selects the bot closest to the placed human’s current RP', async () => {
    repo.listEligibleBots.mockResolvedValue([
      bot('far', { rp: 400 }),
      bot('closest', { rp: 1490 }),
      bot('mid', { rp: 1200 }),
    ]);
    const result = await syntheticBotSelectionService.selectAndReserve({
      humanUserId: 'human',
      humanProfile: placedHuman, // target 1500
      lobbyId: 'lobby',
    });
    expect(result?.bot.user_id).toBe('closest');
    expect(result?.relaxationLevel).toBe('strict');
  });
});

describe('eligibility ladder order', () => {
  it('relaxes recently-faced before daily-cap before schedule', async () => {
    // The only bot near target is recently-faced AND at its daily cap AND out of
    // its schedule window. It must only be selected once the ladder relaxes all
    // three — proving order by observing the relaxation label.
    const nowHour = Number(
      new Date().toLocaleString('en-US', { timeZone: 'Asia/Tbilisi', hour: '2-digit', hour12: false }),
    ) % 24;
    // schedule window that EXCLUDES the current hour (a 1-hour window elsewhere)
    const outStart = (nowHour + 2) % 24;
    const outEnd = (nowHour + 3) % 24;
    repo.listEligibleBots.mockResolvedValue([
      bot('only', {
        rp: 1500,
        daily_cap: 3,
        matches_today: 3,
        matches_day: rosterDay(),
        schedule: { startHour: outStart, endHour: outEnd },
      }),
    ]);
    redis.lRange.mockResolvedValue(['only']); // recently faced

    const result = await syntheticBotSelectionService.selectAndReserve({
      humanUserId: 'human',
      humanProfile: placedHuman,
      lobbyId: 'lobby',
    });
    expect(result?.bot.user_id).toBe('only');
    // recently-faced + daily-cap + schedule all had to relax → the LAST rung.
    expect(result?.relaxationLevel).toBe('relax_schedule');
  });

  it('prefers a strictly-eligible bot over a constrained one at the same RP', async () => {
    repo.listEligibleBots.mockResolvedValue([
      bot('capped', { rp: 1500, daily_cap: 1, matches_today: 1, matches_day: rosterDay() }),
      bot('free', { rp: 1500 }),
    ]);
    const result = await syntheticBotSelectionService.selectAndReserve({
      humanUserId: 'human',
      humanProfile: placedHuman,
      lobbyId: 'lobby',
    });
    expect(result?.bot.user_id).toBe('free');
    expect(result?.relaxationLevel).toBe('strict');
  });
});

describe('one-winner acquire race', () => {
  it('falls through to the next candidate when an acquire loses the race', async () => {
    // 'first' sits in the ±100 band (nearest), 'second' in the ±500 band. Band
    // ordering is deterministic (only WITHIN-band ties shuffle), so 'first' is
    // always tried before 'second'.
    repo.listEligibleBots.mockResolvedValue([
      bot('first', { rp: 1500 }),
      bot('second', { rp: 1100 }),
    ]);
    reservation.acquire.mockImplementation(async ({ botUserId }: { botUserId: string }) => {
      if (botUserId === 'first') return null; // lost the race
      return { botUserId, lobbyId: 'lobby', fence: 2 };
    });
    const result = await syntheticBotSelectionService.selectAndReserve({
      humanUserId: 'human',
      humanProfile: placedHuman,
      lobbyId: 'lobby',
    });
    expect(result?.bot.user_id).toBe('second');
    expect(reservation.acquire).toHaveBeenCalledTimes(2);
  });

  it('returns null when every acquire loses (ladder exhausted)', async () => {
    repo.listEligibleBots.mockResolvedValue([bot('a', { rp: 1500 }), bot('b', { rp: 1500 })]);
    reservation.acquire.mockResolvedValue(null);
    const result = await syntheticBotSelectionService.selectAndReserve({
      humanUserId: 'human',
      humanProfile: placedHuman,
      lobbyId: 'lobby',
    });
    expect(result).toBeNull();
  });
});
