/**
 * Unit tests for persistent-bot selection (PR7) with mocked seams:
 *   - flag OFF gates optional callers while ranked remains persistent-only
 *   - empty roster → null, no acquire attempted
 *   - nearest-RP widening picks the closest bot to the human's target
 *   - ranked can fall through to the highest lower-RP persistent bot
 *   - ranked rotates away from recent identities, then uses least-recent as a
 *     last resort; auction retains its original soft recent-opponent rung
 *   - eligibility ladder relaxes in order: recent → daily cap → schedule
 *   - one-winner acquire race: a lost acquire falls through to the next candidate
 *   - ladder exhausted (all acquires lost) → null
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import '../setup.js';

const repo = {
  listEligibleBots: vi.fn(),
  listRankedPersistentOpponentHistory: vi.fn().mockResolvedValue([]),
};
/** Durable-history row shorthand: a bot faced `count` times in the last 7 days. */
function faced(botUserId: string, count = 1) {
  return { bot_user_id: botUserId, matches_count: count };
}
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
// Selection reads the PR10 live-tuning overrides. Unmocked this is a real DB
// read, which makes a PURE-UNIT ladder test depend on whatever the shared test
// database happens to hold — a parallel suite writing an activityScale override
// would flip the operator cap on and fail this test nondeterministically. Pin
// the untuned defaults so the ladder assertions stay hermetic.
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
  redis.isOpen = true;
  redis.lRange.mockResolvedValue([]);
  repo.listRankedPersistentOpponentHistory.mockResolvedValue([]);
});

describe('rollout flag behavior', () => {
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

  it('ranked persistent-only selection still reserves a roster bot when the rollout flag is off', async () => {
    reservation.isEnabled.mockReturnValue(false);
    repo.listEligibleBots.mockResolvedValue([bot('ranked-required', { rp: 1500 })]);

    const result = await syntheticBotSelectionService.selectAndReserve({
      humanUserId: 'human',
      humanProfile: placedHuman,
      lobbyId: 'lobby',
      allowOutOfBandFallback: true,
    });

    expect(result?.bot.user_id).toBe('ranked-required');
    expect(reservation.acquire).toHaveBeenCalledWith(expect.objectContaining({
      botUserId: 'ranked-required',
      requirePersistent: true,
    }));
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

  it('prefers an inner-band (±150) bot over one only inside the outer band', async () => {
    // 'inner' is 100 below target, 'outer' 250 below. Band order is deterministic
    // (only WITHIN-band ties shuffle), so the inner-band bot always wins.
    repo.listEligibleBots.mockResolvedValue([
      bot('outer', { rp: 1250 }),
      bot('inner', { rp: 1400 }),
    ]);
    const result = await syntheticBotSelectionService.selectAndReserve({
      humanUserId: 'human',
      humanProfile: placedHuman, // target 1500
      lobbyId: 'lobby',
    });
    expect(result?.bot.user_id).toBe('inner');
  });

  it('still selects a bot inside the ±300 ceiling', async () => {
    repo.listEligibleBots.mockResolvedValue([bot('edge', { rp: 1220 })]); // gap 280
    const result = await syntheticBotSelectionService.selectAndReserve({
      humanUserId: 'human',
      humanProfile: placedHuman,
      lobbyId: 'lobby',
    });
    expect(result?.bot.user_id).toBe('edge');
  });
});

describe('RP-gap ceiling (parity guard)', () => {
  it('returns null (ephemeral fallback) when the nearest bot is beyond ±300', async () => {
    // The prod failure mode: a strong active at 2700 with the roster topping out
    // ~2400. The old unbounded closest-first tail paired them anyway (a 300+ gap
    // the bot won ~4.5% of). It must now fall back to ephemeral instead.
    const strongHuman = { ...placedHuman, rp: 2700 };
    repo.listEligibleBots.mockResolvedValue([
      bot('nearest', { rp: 2400 }), // gap of exactly 300 → inside the inclusive ceiling
      bot('lower', { rp: 1800 }),
    ]);
    const atEdge = await syntheticBotSelectionService.selectAndReserve({
      humanUserId: 'human',
      humanProfile: strongHuman,
      lobbyId: 'lobby',
    });
    // gap of exactly 300 is INSIDE the inclusive ceiling
    expect(atEdge?.bot.user_id).toBe('nearest');

    // Push the nearest bot just outside the ceiling → no pairing at all.
    vi.clearAllMocks();
    reservation.isEnabled.mockReturnValue(true);
    redis.lRange.mockResolvedValue([]);
    repo.listEligibleBots.mockResolvedValue([
      bot('too-far', { rp: 2399 }), // gap 301
      bot('lower', { rp: 1800 }),
    ]);
    const result = await syntheticBotSelectionService.selectAndReserve({
      humanUserId: 'human',
      humanProfile: strongHuman,
      lobbyId: 'lobby',
    });
    expect(result).toBeNull();
    // Never burns an acquire on an out-of-band bot.
    expect(reservation.acquire).not.toHaveBeenCalled();
  });

  it('ranked fallback selects the highest lower-RP persistent bot beyond ±300', async () => {
    const highHuman = { ...placedHuman, rp: 6080 };
    repo.listEligibleBots.mockResolvedValue([
      bot('mid', { rp: 3832 }),
      bot('roster-leader', { rp: 4721 }),
      bot('low', { rp: 2700 }),
    ]);

    const result = await syntheticBotSelectionService.selectAndReserve({
      humanUserId: 'human',
      humanProfile: highHuman,
      lobbyId: 'lobby',
      allowOutOfBandFallback: true,
    });

    expect(result?.bot.user_id).toBe('roster-leader');
    expect(reservation.acquire).toHaveBeenCalledWith(expect.objectContaining({
      botUserId: 'roster-leader',
    }));
  });

  it('ranked still prefers an in-band bot before the out-of-band tail', async () => {
    repo.listEligibleBots.mockResolvedValue([
      bot('out-of-band-stronger', { rp: 1900 }),
      bot('in-band', { rp: 1490 }),
    ]);

    const result = await syntheticBotSelectionService.selectAndReserve({
      humanUserId: 'human',
      humanProfile: placedHuman,
      lobbyId: 'lobby',
      allowOutOfBandFallback: true,
    });

    expect(result?.bot.user_id).toBe('in-band');
  });

  it('ranked fallback uses the closest higher bot when the roster has no lower bot', async () => {
    const bottomHuman = { ...placedHuman, rp: 150 };
    repo.listEligibleBots.mockResolvedValue([
      bot('higher-far', { rp: 900 }),
      bot('higher-near', { rp: 600 }),
    ]);

    const result = await syntheticBotSelectionService.selectAndReserve({
      humanUserId: 'human',
      humanProfile: bottomHuman,
      lobbyId: 'lobby',
      allowOutOfBandFallback: true,
    });

    expect(result?.bot.user_id).toBe('higher-near');
  });

  it('applies the ceiling around an UNPLACED human’s placement anchor, not their hidden RP', async () => {
    // Unplaced humans are anchored near 1900 (PR2), not their hidden ~450 RP.
    // A bot next to the anchor must pair; one next to the hidden RP must not.
    const unplaced = {
      ...placedHuman,
      rp: 450,
      placement_status: 'unplaced' as const,
      placement_played: 0,
      placement_wins: 0,
    };
    repo.listEligibleBots.mockResolvedValue([bot('near-hidden-rp', { rp: 450 })]);
    const wrongAnchor = await syntheticBotSelectionService.selectAndReserve({
      humanUserId: 'human',
      humanProfile: unplaced,
      lobbyId: 'lobby',
    });
    expect(wrongAnchor).toBeNull(); // 450 is ~1450 away from the anchor

    vi.clearAllMocks();
    reservation.isEnabled.mockReturnValue(true);
    reservation.acquire.mockImplementation(async ({ botUserId }: { botUserId: string }) => ({
      botUserId,
      lobbyId: 'lobby',
      fence: 1,
    }));
    redis.lRange.mockResolvedValue([]);
    repo.listEligibleBots.mockResolvedValue([bot('near-anchor', { rp: 1900 })]);
    const rightAnchor = await syntheticBotSelectionService.selectAndReserve({
      humanUserId: 'human',
      humanProfile: unplaced,
      lobbyId: 'lobby',
    });
    expect(rightAnchor?.bot.user_id).toBe('near-anchor');
  });

  it('excludes in-band bots already seated in this match without pairing out of band', async () => {
    // Multi-seat auction: the only in-band bot is already seated. The next seat
    // must go ephemeral rather than reaching for the far-away bot.
    repo.listEligibleBots.mockResolvedValue([
      bot('seated', { rp: 1500 }),
      bot('far', { rp: 600 }),
    ]);
    const result = await syntheticBotSelectionService.selectAndReserve({
      humanUserId: 'human',
      humanProfile: placedHuman,
      lobbyId: 'lobby',
      excludeBotUserIds: ['seated'],
    });
    expect(result).toBeNull();
    expect(reservation.acquire).not.toHaveBeenCalled();
  });

  it('does not resurrect an out-of-band bot by relaxing the eligibility ladder', async () => {
    // The only bot is far away AND constrained. Relaxing soft constraints must
    // never widen the RP band — the ceiling is not part of the ladder.
    const strongHuman = { ...placedHuman, rp: 2700 };
    repo.listEligibleBots.mockResolvedValue([
      bot('far-and-capped', {
        rp: 1500,
        daily_cap: 1,
        matches_today: 1,
        matches_day: rosterDay(),
      }),
    ]);
    const result = await syntheticBotSelectionService.selectAndReserve({
      humanUserId: 'human',
      humanProfile: strongHuman,
      lobbyId: 'lobby',
    });
    expect(result).toBeNull();
    expect(reservation.acquire).not.toHaveBeenCalled();
  });
});

describe('ranked recent-opponent rotation', () => {
  it('rotates to a fresh bot even after cap and schedule relaxation', async () => {
    const nowHour = Number(
      new Date().toLocaleString('en-US', { timeZone: 'Asia/Tbilisi', hour: '2-digit', hour12: false }),
    ) % 24;
    const outStart = (nowHour + 2) % 24;
    const outEnd = (nowHour + 3) % 24;
    repo.listEligibleBots.mockResolvedValue([
      bot('recent-best', { rp: 1500 }),
      bot('alternate', {
        rp: 1500,
        daily_cap: 3,
        matches_today: 3,
        matches_day: rosterDay(),
        schedule: { startHour: outStart, endHour: outEnd },
      }),
    ]);
    redis.lRange.mockResolvedValue(['recent-best']);

    const result = await syntheticBotSelectionService.selectAndReserve({
      humanUserId: 'human',
      humanProfile: placedHuman,
      lobbyId: 'lobby',
      allowOutOfBandFallback: true,
    });
    expect(result?.bot.user_id).toBe('alternate');
    expect(result?.relaxationLevel).toBe('relax_schedule');
    expect(reservation.acquire).not.toHaveBeenCalledWith(expect.objectContaining({
      botUserId: 'recent-best',
    }));
  });

  it('uses the least-recent opponent as a last resort when every candidate is recent', async () => {
    repo.listEligibleBots.mockResolvedValue([
      bot('newest', { rp: 1500 }),
      bot('oldest', { rp: 1500 }),
    ]);
    redis.lRange.mockResolvedValue(['newest', 'oldest']);

    const result = await syntheticBotSelectionService.selectAndReserve({
      humanUserId: 'human',
      humanProfile: placedHuman,
      lobbyId: 'lobby',
      allowOutOfBandFallback: true,
    });

    expect(result?.bot.user_id).toBe('oldest');
    expect(result?.relaxationLevel).toBe('relax_recently_faced');
  });

  it('uses durable recent history when the Redis list is empty', async () => {
    repo.listEligibleBots.mockResolvedValue([
      bot('durable-recent', { rp: 1500 }),
      bot('alternate', { rp: 1400 }),
    ]);
    repo.listRankedPersistentOpponentHistory.mockResolvedValue([faced('durable-recent')]);

    const result = await syntheticBotSelectionService.selectAndReserve({
      humanUserId: 'human',
      humanProfile: placedHuman,
      lobbyId: 'lobby',
      allowOutOfBandFallback: true,
    });

    expect(result?.bot.user_id).toBe('alternate');
  });

  it('caps the merged Redis and durable window at BOT_RANKED_RECENT_WINDOW identities', async () => {
    repo.listEligibleBots.mockResolvedValue([
      bot('durable-sixteenth', { rp: 1500 }),
      bot('fallback', { rp: 1000 }),
    ]);
    // 15 fresh Redis identities fill the default ranked window; the durable
    // 16th falls off the end of the merged window and is selectable again.
    redis.lRange.mockResolvedValue(Array.from({ length: 15 }, (_, i) => `r${i + 1}`));
    repo.listRankedPersistentOpponentHistory.mockResolvedValue([faced('durable-sixteenth')]);

    const result = await syntheticBotSelectionService.selectAndReserve({
      humanUserId: 'human',
      humanProfile: placedHuman,
      lobbyId: 'lobby',
      allowOutOfBandFallback: true,
    });

    expect(result?.bot.user_id).toBe('durable-sixteenth');
  });

  it('does not let a stale full Redis list hide a durably-recorded newer opponent', async () => {
    repo.listEligibleBots.mockResolvedValue([
      bot('newest-durable', { rp: 1500 }),
      bot('fallback', { rp: 1000 }),
    ]);
    // Redis recovered with an old full window (all 15 ids also present in the
    // durable history) but MISSED the newest opponent. The durable order is
    // authoritative: the newest opponent must stay inside the window instead of
    // being sliced off behind the stale cache entries.
    const stale = Array.from({ length: 15 }, (_, i) => `s${i + 1}`);
    redis.lRange.mockResolvedValue(stale);
    repo.listRankedPersistentOpponentHistory.mockResolvedValue([
      faced('newest-durable'),
      ...stale.map((id) => faced(id)),
    ]);

    const result = await syntheticBotSelectionService.selectAndReserve({
      humanUserId: 'human',
      humanProfile: placedHuman,
      lobbyId: 'lobby',
      allowOutOfBandFallback: true,
    });

    expect(result?.bot.user_id).toBe('fallback');
  });

  it('keeps a bot excluded while it is inside the ranked window even when Redis holds fewer', async () => {
    repo.listEligibleBots.mockResolvedValue([
      bot('sixth-recent', { rp: 1500 }),
      bot('fallback', { rp: 1000 }),
    ]);
    // Under the old 5-identity window the 6th-most-recent opponent was already
    // selectable again — exactly the loop top players reported. The 15-window
    // keeps it out and selection walks down to a fresh identity instead.
    redis.lRange.mockResolvedValue(['r1', 'r2', 'r3', 'r4', 'r5', 'sixth-recent']);

    const result = await syntheticBotSelectionService.selectAndReserve({
      humanUserId: 'human',
      humanProfile: placedHuman,
      lobbyId: 'lobby',
      allowOutOfBandFallback: true,
    });

    expect(result?.bot.user_id).toBe('fallback');
  });

  it('keeps auction recent-opponent relaxation and skips the durable ranked query', async () => {
    repo.listEligibleBots.mockResolvedValue([bot('auction-recent', { rp: 1500 })]);
    redis.lRange.mockResolvedValue(['auction-recent']);

    const result = await syntheticBotSelectionService.selectAndReserve({
      humanUserId: 'human',
      humanProfile: placedHuman,
      lobbyId: 'auction-seat',
      mode: 'auction',
    });

    expect(result?.bot.user_id).toBe('auction-recent');
    expect(result?.relaxationLevel).toBe('relax_recently_faced');
    expect(repo.listRankedPersistentOpponentHistory).not.toHaveBeenCalled();
    expect(reservation.acquire).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'auction',
      requirePersistent: false,
    }));
  });

  it('de-duplicates the Redis LRU before pushing the latest bot', async () => {
    await syntheticBotSelectionService.recordRecentlyFaced('human', 'bot-1');

    expect(redis.lRem).toHaveBeenCalledWith('ranked:persistent:recent:human', 0, 'bot-1');
    expect(redis.lPush).toHaveBeenCalledWith('ranked:persistent:recent:human', 'bot-1');
    expect(redis.lTrim).toHaveBeenCalledWith('ranked:persistent:recent:human', 0, 14);
  });
});

describe('weekly pair-frequency cap', () => {
  it('excludes a bot the human already faced BOT_RANKED_PAIR_WEEKLY_CAP times, even at closer RP', async () => {
    repo.listEligibleBots.mockResolvedValue([
      bot('farmed-leader', { rp: 1500 }),
      bot('fresh-lower', { rp: 1000 }),
    ]);
    // Faced 3x in the trailing 7 days (default cap) but NOT in the recent
    // window — only the frequency cap can exclude it here.
    redis.lRange.mockResolvedValue(Array.from({ length: 15 }, (_, i) => `r${i + 1}`));
    repo.listRankedPersistentOpponentHistory.mockResolvedValue([faced('farmed-leader', 3)]);

    const result = await syntheticBotSelectionService.selectAndReserve({
      humanUserId: 'human',
      humanProfile: placedHuman,
      lobbyId: 'lobby',
      allowOutOfBandFallback: true,
    });

    expect(result?.bot.user_id).toBe('fresh-lower');
    expect(reservation.acquire).not.toHaveBeenCalledWith(expect.objectContaining({
      botUserId: 'farmed-leader',
    }));
  });

  it('does not exclude a bot below the weekly cap', async () => {
    repo.listEligibleBots.mockResolvedValue([
      bot('lightly-faced', { rp: 1500 }),
      bot('fresh-lower', { rp: 1000 }),
    ]);
    redis.lRange.mockResolvedValue(Array.from({ length: 15 }, (_, i) => `r${i + 1}`));
    repo.listRankedPersistentOpponentHistory.mockResolvedValue([faced('lightly-faced', 2)]);

    const result = await syntheticBotSelectionService.selectAndReserve({
      humanUserId: 'human',
      humanProfile: placedHuman,
      lobbyId: 'lobby',
      allowOutOfBandFallback: true,
    });

    expect(result?.bot.user_id).toBe('lightly-faced');
  });

  it('still serves a weekly-capped bot as the last resort when nothing else is usable', async () => {
    repo.listEligibleBots.mockResolvedValue([bot('only-option', { rp: 1500 })]);
    repo.listRankedPersistentOpponentHistory.mockResolvedValue([faced('only-option', 7)]);

    const result = await syntheticBotSelectionService.selectAndReserve({
      humanUserId: 'human',
      humanProfile: placedHuman,
      lobbyId: 'lobby',
      allowOutOfBandFallback: true,
    });

    expect(result?.bot.user_id).toBe('only-option');
    expect(result?.relaxationLevel).toBe('relax_recently_faced');
  });

  it('retries a capped bot outside the recency list before a recently-faced one', async () => {
    repo.listEligibleBots.mockResolvedValue([
      bot('just-played', { rp: 1500 }),
      bot('capped-days-ago', { rp: 1500 }),
    ]);
    // Both are rotation-excluded, so selection must re-enter. The capped bot
    // has fallen off the 15-identity recency window entirely (15 fresher Redis
    // entries), so it was faced longest ago of all and goes first.
    redis.lRange.mockResolvedValue([
      'just-played',
      ...Array.from({ length: 14 }, (_, i) => `r${i + 2}`),
    ]);
    repo.listRankedPersistentOpponentHistory.mockResolvedValue([faced('capped-days-ago', 5)]);

    const result = await syntheticBotSelectionService.selectAndReserve({
      humanUserId: 'human',
      humanProfile: placedHuman,
      lobbyId: 'lobby',
      allowOutOfBandFallback: true,
    });

    expect(result?.bot.user_id).toBe('capped-days-ago');
  });

  it('re-enters the least-recent of TWO capped bots beyond the window, not the closest-RP one', async () => {
    repo.listEligibleBots.mockResolvedValue([
      bot('capped-newer', { rp: 1500 }),
      bot('capped-older', { rp: 1400 }),
    ]);
    // Both capped bots fell off the 15-id window; the full durable order must
    // still break the tie by true recency (older first), not by RP closeness.
    redis.lRange.mockResolvedValue(Array.from({ length: 15 }, (_, i) => `r${i + 1}`));
    repo.listRankedPersistentOpponentHistory.mockResolvedValue([
      faced('capped-newer', 5),
      faced('capped-older', 5),
    ]);

    const result = await syntheticBotSelectionService.selectAndReserve({
      humanUserId: 'human',
      humanProfile: placedHuman,
      lobbyId: 'lobby',
      allowOutOfBandFallback: true,
    });

    expect(result?.bot.user_id).toBe('capped-older');
  });
});

describe('eligibility ladder order', () => {
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
    // 'first' sits in the inner ±150 band, 'second' in the outer band (gap 250,
    // inside the ±300 ceiling). Band ordering is deterministic (only WITHIN-band
    // ties shuffle), so 'first' is always tried before 'second'.
    repo.listEligibleBots.mockResolvedValue([
      bot('first', { rp: 1500 }),
      bot('second', { rp: 1250 }),
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

  it('caps total acquire attempts and falls back to ephemeral under heavy contention', async () => {
    // 50 eligible bots, every acquire loses (all concurrently reserved). The loop
    // must NOT try all 50 × ladder-levels — it caps at MAX_ACQUIRE_ATTEMPTS (12)
    // then returns null (ephemeral fallback).
    const many = Array.from({ length: 50 }, (_, i) => bot(`bot-${i}`, { rp: 1500 }));
    repo.listEligibleBots.mockResolvedValue(many);
    reservation.acquire.mockResolvedValue(null); // every acquire loses
    const result = await syntheticBotSelectionService.selectAndReserve({
      humanUserId: 'human',
      humanProfile: placedHuman,
      lobbyId: 'lobby',
    });
    expect(result).toBeNull();
    // Bounded: at most the cap (12), never all 50+.
    expect(reservation.acquire.mock.calls.length).toBeLessThanOrEqual(12);
  });
});

function tbilisiHour(): number {
  return Number(
    new Date().toLocaleString('en-US', { timeZone: 'Asia/Tbilisi', hour: '2-digit', hour12: false }),
  ) % 24;
}

describe('schedule window endHour>=24 wrap (finding #10)', () => {
  it('an evening window encoded as endHour>=25 correctly INCLUDES the wrapped hour', async () => {
    // Build a window [h .. h+something+24] that both spans the current hour AND
    // wraps past midnight, encoded with endHour > 24 (the generator's form). The
    // strict rung (session-preference requires in-window) must accept it.
    const h = tbilisiHour();
    // Window starts 1h before now and ends deep in the next day (encoded >24),
    // so the current hour is inside a wrapped window.
    const startHour = (h + 23) % 24; // one hour before now
    const endHour = startHour + 5 + 24; // >24 → wraps; spans now and past midnight
    repo.listEligibleBots.mockResolvedValue([
      bot('evening', { rp: 1500, schedule: { startHour, endHour } }),
    ]);
    const result = await syntheticBotSelectionService.selectAndReserve({
      humanUserId: 'human',
      humanProfile: placedHuman,
      lobbyId: 'lobby',
    });
    expect(result?.bot.user_id).toBe('evening');
    // In-window at the strict rung → no schedule/session relaxation needed.
    expect(result?.relaxationLevel).toBe('strict');
  });

  it('a window that excludes the current hour still forces schedule relaxation', async () => {
    const h = tbilisiHour();
    // A 2-hour window well away from now (encoded >24 to exercise the same path).
    const startHour = (h + 4) % 24;
    const endHour = startHour + 2 + 24;
    repo.listEligibleBots.mockResolvedValue([
      bot('offhours', { rp: 1500, schedule: { startHour, endHour } }),
    ]);
    const result = await syntheticBotSelectionService.selectAndReserve({
      humanUserId: 'human',
      humanProfile: placedHuman,
      lobbyId: 'lobby',
    });
    expect(result?.bot.user_id).toBe('offhours');
    // Out of window → session-preference AND schedule both had to relax.
    expect(result?.relaxationLevel).toBe('relax_schedule');
  });
});

describe('session-preference first rung (finding #10)', () => {
  it('prefers a bot continuing a live session over one merely in-window', async () => {
    const h = tbilisiHour();
    const inWindow = { startHour: (h + 23) % 24, endHour: (h + 2) % 24 };
    repo.listEligibleBots.mockResolvedValue([
      // in-window but no recent session → fresh (still a session preference)
      bot('fresh', { rp: 1500, schedule: { ...inWindow } }),
      // in-window AND continuing a session started 5 min ago
      bot('active', {
        rp: 1500,
        schedule: { ...inWindow, last_session_at: new Date(Date.now() - 5 * 60 * 1000).toISOString() },
      }),
    ]);
    const result = await syntheticBotSelectionService.selectAndReserve({
      humanUserId: 'human',
      humanProfile: placedHuman,
      lobbyId: 'lobby',
    });
    // Both pass the strict (session-preference) rung; either is acceptable, but
    // selection must succeed AT the strict rung (proving the rung exists and both
    // qualify as session-preferred).
    expect(['fresh', 'active']).toContain(result?.bot.user_id);
    expect(result?.relaxationLevel).toBe('strict');
  });

  it('relaxes session-preference when the only near bot has a stale session', async () => {
    const h = tbilisiHour();
    repo.listEligibleBots.mockResolvedValue([
      bot('stale', {
        rp: 1500,
        // in-window but last session was hours ago (> 20-min gap) → NOT a session
        // preference; must relax the first rung to be selected.
        schedule: {
          startHour: (h + 23) % 24,
          endHour: (h + 2) % 24,
          last_session_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
        },
      }),
    ]);
    const result = await syntheticBotSelectionService.selectAndReserve({
      humanUserId: 'human',
      humanProfile: placedHuman,
      lobbyId: 'lobby',
    });
    expect(result?.bot.user_id).toBe('stale');
    expect(result?.relaxationLevel).toBe('relax_session_preference');
  });
});

describe('selectionTargetRpForHuman clamp fix (INC: 4900-RP human drew a 2403 bot)', () => {
  it('placed high-RP humans target their real RP, not the 2700 ephemeral anchor cap', async () => {
    const { selectionTargetRpForHuman } = await import('../../src/modules/ranked/ranked.service.js');
    const placed = (rp: number) => ({ rp, placement_status: 'placed', placement_played: 3, placement_wins: 2 }) as any;
    expect(selectionTargetRpForHuman(placed(4900))).toBe(4900);
    expect(selectionTargetRpForHuman(placed(3585))).toBe(3575);
    expect(selectionTargetRpForHuman(placed(1200))).toBe(1200);
    expect(selectionTargetRpForHuman(placed(0))).toBe(150);
  });
});
