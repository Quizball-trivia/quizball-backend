import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('../../src/core/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../src/modules/matches/matches.repo.js', () => ({
  matchesRepo: {
    getMatch: vi.fn(),
  },
}));

vi.mock('../../src/modules/matches/match-players.repo.js', () => ({
  matchPlayersRepo: {
    listMatchPlayers: vi.fn(),
  },
}));

vi.mock('../../src/modules/users/users.repo.js', () => {
  const getById = vi.fn();
  return {
    usersRepo: {
      getById,
      getByIds: vi.fn(async (ids: string[]) => {
        const usersById = new Map<string, Awaited<ReturnType<typeof getById>>>();
        for (const id of [...new Set(ids)]) {
          const user = await getById(id);
          if (user) usersById.set(id, user);
        }
        return usersById;
      }),
    },
  };
});

vi.mock('../../src/modules/ranked/ranked.repo.js', () => ({
  rankedRepo: {
    ensureProfile: vi.fn(),
    getProfile: vi.fn(),
    getProfilesByUserIds: vi.fn(),
    getRpChangesForMatch: vi.fn(),
    applySettlement: vi.fn(),
    listLeaderboard: vi.fn(),
  },
}));

import { matchesRepo } from '../../src/modules/matches/matches.repo.js';
import { matchPlayersRepo } from '../../src/modules/matches/match-players.repo.js';
import { usersRepo } from '../../src/modules/users/users.repo.js';
import { rankedRepo } from '../../src/modules/ranked/ranked.repo.js';
import { rankedService } from '../../src/modules/ranked/ranked.service.js';
import { withSeed } from '../../src/core/rng.js';
import type { MatchPlayerRow, MatchRow } from '../../src/modules/matches/matches.types.js';
import type { RankedProfileRow, RankedRpChangeRow, RankedTier } from '../../src/modules/ranked/ranked.types.js';

const NOW_ISO = new Date().toISOString();

function createProfile(overrides: Partial<RankedProfileRow> & {
  user_id: string;
  rp: number;
  tier: RankedTier;
}): RankedProfileRow {
  return {
    user_id: overrides.user_id,
    rp: overrides.rp,
    tier: overrides.tier,
    placement_status: overrides.placement_status ?? 'unplaced',
    placement_required: overrides.placement_required ?? 3,
    placement_played: overrides.placement_played ?? 0,
    placement_wins: overrides.placement_wins ?? 0,
    placement_seed_rp: overrides.placement_seed_rp ?? null,
    placement_perf_sum: overrides.placement_perf_sum ?? 0,
    placement_points_for_sum: overrides.placement_points_for_sum ?? 0,
    placement_points_against_sum: overrides.placement_points_against_sum ?? 0,
    current_win_streak: overrides.current_win_streak ?? 0,
    last_ranked_match_at: overrides.last_ranked_match_at ?? null,
    created_at: overrides.created_at ?? NOW_ISO,
    updated_at: overrides.updated_at ?? NOW_ISO,
  };
}

function createCompletedRankedMatch(
  matchId: string,
  winnerUserId: string | null,
  rankedContext?: unknown,
  winnerDecisionMethod: 'goals' | 'penalty_goals' | 'total_points_fallback' | 'forfeit' | null = null
): MatchRow {
  return {
    id: matchId,
    lobby_id: null,
    mode: 'ranked',
    status: 'completed',
    category_a_id: 'cat-a',
    category_b_id: 'cat-b',
    current_q_index: 10,
    total_questions: 12,
    state_payload: winnerDecisionMethod ? { winnerDecisionMethod } : null,
    ranked_context: (rankedContext as Record<string, unknown> | null) ?? null,
    started_at: NOW_ISO,
    ended_at: NOW_ISO,
    winner_user_id: winnerUserId,
  };
}

function createPlayer(
  userId: string,
  seat: number,
  totalPoints: number,
  correctAnswers = 0,
  goals = 0,
  penaltyGoals = 0
): MatchPlayerRow {
  return {
    match_id: 'm-1',
    user_id: userId,
    seat,
    total_points: totalPoints,
    correct_answers: correctAnswers,
    avg_time_ms: null,
    goals,
    penalty_goals: penaltyGoals,
  };
}

describe('rankedService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('maps RP to tier at boundaries', () => {
    const cases: Array<{ rp: number; expected: RankedTier }> = [
      { rp: 0, expected: 'Academy' },
      { rp: 299, expected: 'Academy' },
      { rp: 300, expected: 'Youth Prospect' },
      { rp: 599, expected: 'Youth Prospect' },
      { rp: 600, expected: 'Reserve' },
      { rp: 899, expected: 'Reserve' },
      { rp: 900, expected: 'Bench' },
      { rp: 1199, expected: 'Bench' },
      { rp: 1200, expected: 'Rotation' },
      { rp: 1499, expected: 'Rotation' },
      { rp: 1500, expected: 'Starting11' },
      { rp: 1849, expected: 'Starting11' },
      { rp: 1850, expected: 'Key Player' },
      { rp: 2199, expected: 'Key Player' },
      { rp: 2200, expected: 'Captain' },
      { rp: 2599, expected: 'Captain' },
      { rp: 2600, expected: 'World-Class' },
      { rp: 2899, expected: 'World-Class' },
      { rp: 2900, expected: 'Legend' },
      { rp: 4999, expected: 'Legend' },
      { rp: 5000, expected: 'GOAT' },
      { rp: 6000, expected: 'GOAT' },
    ];

    for (const entry of cases) {
      expect(rankedService.tierFromRp(entry.rp)).toBe(entry.expected);
    }
  });

  it('evaluates placement requirement by status and count', () => {
    const unplaced = createProfile({
      user_id: 'u-1',
      rp: 1200,
      tier: 'Rotation',
      placement_status: 'unplaced',
      placement_played: 0,
      placement_required: 3,
    });
    const inProgress = createProfile({
      user_id: 'u-2',
      rp: 1200,
      tier: 'Rotation',
      placement_status: 'in_progress',
      placement_played: 2,
      placement_required: 3,
    });
    const placedIncompleteCount = createProfile({
      user_id: 'u-3',
      rp: 1200,
      tier: 'Rotation',
      placement_status: 'placed',
      placement_played: 2,
      placement_required: 3,
    });
    const placedComplete = createProfile({
      user_id: 'u-4',
      rp: 1200,
      tier: 'Rotation',
      placement_status: 'placed',
      placement_played: 3,
      placement_required: 3,
    });

    expect(rankedService.isPlacementRequired(unplaced)).toBe(true);
    expect(rankedService.isPlacementRequired(inProgress)).toBe(true);
    expect(rankedService.isPlacementRequired(placedIncompleteCount)).toBe(true);
    expect(rankedService.isPlacementRequired(placedComplete)).toBe(false);
  });

  it('builds progressive placement AI context (harder after wins, easier after losses)', () => {
    const freshProfile = createProfile({
      user_id: 'fresh',
      rp: 1200,
      tier: 'Rotation',
      placement_status: 'unplaced',
      placement_played: 0,
      placement_wins: 0,
    });
    const winningProfile = createProfile({
      user_id: 'win',
      rp: 1200,
      tier: 'Rotation',
      placement_status: 'in_progress',
      placement_played: 1,
      placement_wins: 1,
    });
    const losingProfile = createProfile({
      user_id: 'loss',
      rp: 1200,
      tier: 'Rotation',
      placement_status: 'in_progress',
      placement_played: 1,
      placement_wins: 0,
    });

    const fresh = rankedService.buildPlacementAiContext(freshProfile);
    const harder = rankedService.buildPlacementAiContext(winningProfile);
    const easier = rankedService.buildPlacementAiContext(losingProfile);

    expect(fresh.placementGameNo).toBe(1);
    expect(fresh.aiAnchorRp).toBe(1900);
    expect(harder.aiAnchorRp).toBeGreaterThan(fresh.aiAnchorRp);
    expect(easier.aiAnchorRp).toBeLessThan(fresh.aiAnchorRp);
    expect(harder.aiCorrectness).toBeGreaterThan(fresh.aiCorrectness);
    expect(easier.aiCorrectness).toBeLessThan(fresh.aiCorrectness);
    expect(harder.aiDelayProfile.minMs).toBeLessThanOrEqual(fresh.aiDelayProfile.minMs);
    expect(harder.aiDelayProfile.maxMs).toBeLessThanOrEqual(fresh.aiDelayProfile.maxMs);
    expect(fresh.aiDelayProfile.minMs).toBeLessThanOrEqual(fresh.aiDelayProfile.maxMs);
  });

  it('builds a non-placement AI context around the player RP for placed players', () => {
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      const placedProfile = createProfile({
        user_id: 'placed',
        rp: 525,
        tier: 'Youth Prospect',
        placement_status: 'placed',
        placement_played: 3,
        placement_wins: 2,
      });

      const context = rankedService.buildAiMatchContext(placedProfile);

      expect(context.isPlacement).toBe(false);
      expect(context.placementGameNo).toBeUndefined();
      expect(context.aiAnchorRp).toBe(525);
      expect(context.aiCorrectness).toBeGreaterThanOrEqual(0.35);
      expect(context.aiCorrectness).toBeLessThanOrEqual(0.75);
      expect(context.aiDelayProfile.minMs).toBeLessThanOrEqual(context.aiDelayProfile.maxMs);
    } finally {
      randomSpy.mockRestore();
    }
  });

  it('builds high-RP AI context with a jittered uncapped anchor', () => {
    const placedProfile = createProfile({
      user_id: 'high-rp',
      rp: 20795,
      tier: 'GOAT',
      placement_status: 'placed',
      placement_played: 3,
      placement_wins: 3,
    });

    const first = withSeed('ranked-ai-high-rp-anchor', () =>
      rankedService.buildAiMatchContext(placedProfile)
    );
    const second = withSeed('ranked-ai-high-rp-anchor', () =>
      rankedService.buildAiMatchContext(placedProfile)
    );

    expect(second.aiAnchorRp).toBe(first.aiAnchorRp);
    expect(first.isPlacement).toBe(false);
    expect(first.aiAnchorRp).toBeGreaterThanOrEqual(150);
    expect(first.aiAnchorRp).toBeGreaterThanOrEqual(Math.round(20795 * 0.9));
    expect(first.aiAnchorRp).toBeLessThanOrEqual(Math.round(20795 * 1.1));
    expect(first.aiAnchorRp % 25).toBe(0);
    expect(first.aiCorrectness).toBe(0.85);
    expect(first.aiDelayProfile).toEqual({ minMs: 500, maxMs: 2200 });
  });

  it('never lets jitter drop a high-band player onto the low-band curve', () => {
    const profile = createProfile({
      user_id: 'band-edge',
      rp: 2800,
      tier: 'GOAT',
      placement_status: 'placed',
      placement_played: 3,
      placement_wins: 3,
    });

    for (let i = 0; i < 25; i += 1) {
      const ctx = withSeed(`ranked-ai-band-edge-${i}`, () => rankedService.buildAiMatchContext(profile));
      expect(ctx.aiAnchorRp).toBeGreaterThanOrEqual(2700);
    }
  });

  it('keeps placed low-RP AI anchors unchanged when jitter is neutral', () => {
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      const placedProfile = createProfile({
        user_id: 'low-rp',
        rp: 800,
        tier: 'Reserve',
        placement_status: 'placed',
        placement_played: 3,
        placement_wins: 2,
      });

      const context = rankedService.buildAiMatchContext(placedProfile);

      expect(context.aiAnchorRp).toBe(800);
    } finally {
      randomSpy.mockRestore();
    }
  });

  // Season 2026 formula, regular (goals) win/loss with goal margin 0 (both
  // players' goals default to 0 in createPlayer → no margin bonus):
  //   win  = +50, +10 more if the opponent was strictly higher-ranked
  //   loss = -25 (floored at 0 RP)
  it.each([
    { name: 'equal-rank win', playerRp: 1200, opponentRp: 1200, winnerUserId: 'u-1', delta: 50, newRp: 1250 },
    { name: 'equal-rank loss', playerRp: 1200, opponentRp: 1200, winnerUserId: 'u-2', delta: -25, newRp: 1175 },
    { name: 'win vs higher rank (+10 stronger)', playerRp: 1000, opponentRp: 1500, winnerUserId: 'u-1', delta: 60, newRp: 1060 },
    { name: 'loss vs higher rank', playerRp: 1000, opponentRp: 1500, winnerUserId: 'u-2', delta: -25, newRp: 975 },
    { name: 'win vs lower rank (no stronger bonus)', playerRp: 1500, opponentRp: 1000, winnerUserId: 'u-1', delta: 50, newRp: 1550 },
    { name: 'loss vs lower rank', playerRp: 1500, opponentRp: 1000, winnerUserId: 'u-2', delta: -25, newRp: 1475 },
    { name: 'win vs much-higher rank (+10 stronger)', playerRp: 200, opponentRp: 4000, winnerUserId: 'u-1', delta: 60, newRp: 260 },
    { name: 'win vs much-lower rank (flat +50)', playerRp: 4000, opponentRp: 200, winnerUserId: 'u-1', delta: 50, newRp: 4050 },
    { name: 'loss floored at zero RP', playerRp: 7, opponentRp: 1200, winnerUserId: 'u-2', delta: -7, newRp: 0 },
  ])('applies ranked RP formula correctly: $name', async ({ playerRp, opponentRp, winnerUserId, delta, newRp }) => {
    (matchesRepo.getMatch as Mock).mockResolvedValue(createCompletedRankedMatch('m-1', winnerUserId));
    (matchPlayersRepo.listMatchPlayers as Mock).mockResolvedValue([
      createPlayer('u-1', 1, 800),
      createPlayer('u-2', 2, 700),
    ]);
    (usersRepo.getById as Mock).mockImplementation(async (userId: string) => ({
      id: userId,
      is_ai: false,
    }));
    (rankedRepo.getRpChangesForMatch as Mock).mockResolvedValue([]);
    (rankedRepo.ensureProfile as Mock).mockImplementation(async (userId: string) => {
      if (userId === 'u-1') {
        return createProfile({
          user_id: 'u-1',
          rp: playerRp,
          tier: rankedService.tierFromRp(playerRp),
          placement_status: 'placed',
          placement_played: 3,
        });
      }
      return createProfile({
        user_id: 'u-2',
        rp: opponentRp,
        tier: rankedService.tierFromRp(opponentRp),
        placement_status: 'placed',
        placement_played: 3,
      });
    });
    (rankedRepo.applySettlement as Mock).mockResolvedValue(undefined);

    const outcome = await rankedService.settleCompletedRankedMatch('m-1');
    const userOutcome = outcome?.byUserId['u-1'];
    expect(userOutcome).toBeDefined();
    expect(userOutcome?.deltaRp).toBe(delta);
    expect(userOutcome?.newRp).toBe(newRp);
  });

  it('applies a flat -50 forfeit loss', async () => {
    (matchesRepo.getMatch as Mock).mockResolvedValue(
      createCompletedRankedMatch('m-1', 'u-2', undefined, 'forfeit')
    );
    (matchPlayersRepo.listMatchPlayers as Mock).mockResolvedValue([
      createPlayer('u-1', 1, 400),
      createPlayer('u-2', 2, 900),
    ]);
    (usersRepo.getById as Mock).mockImplementation(async (userId: string) => ({
      id: userId,
      is_ai: false,
    }));
    (rankedRepo.getRpChangesForMatch as Mock).mockResolvedValue([]);
    (rankedRepo.ensureProfile as Mock).mockImplementation(async (userId: string) => {
      if (userId === 'u-1') {
        return createProfile({
          user_id: 'u-1',
          rp: 1200,
          tier: rankedService.tierFromRp(1200),
          placement_status: 'placed',
          placement_played: 3,
        });
      }
      return createProfile({
        user_id: 'u-2',
        rp: 1200,
        tier: rankedService.tierFromRp(1200),
        placement_status: 'placed',
        placement_played: 3,
      });
    });
    (rankedRepo.applySettlement as Mock).mockResolvedValue(undefined);

    const outcome = await rankedService.settleCompletedRankedMatch('m-1');
    const userOutcome = outcome?.byUserId['u-1'];
    expect(userOutcome).toBeDefined();
    expect(userOutcome?.deltaRp).toBe(-50);
    expect(userOutcome?.newRp).toBe(1150);
  });

  it.each([
    { name: 'opponent forfeits while winner leads 4-0', winnerGoals: 4, loserGoals: 0, winnerRp: 1200, loserRp: 1200, expectedDelta: 90 }, // +50 + 40
    { name: 'opponent forfeits while winner leads 3-0', winnerGoals: 3, loserGoals: 0, winnerRp: 1200, loserRp: 1200, expectedDelta: 80 }, // +50 + 30
    { name: 'stronger opponent forfeits while winner leads 3-0', winnerGoals: 3, loserGoals: 0, winnerRp: 1200, loserRp: 1400, expectedDelta: 90 }, // +50 + 30 + 10
    { name: 'opponent forfeits while winner leads 2-0', winnerGoals: 2, loserGoals: 0, winnerRp: 1200, loserRp: 1200, expectedDelta: 65 }, // +50 + 15
    { name: 'opponent forfeits with no goal lead', winnerGoals: 0, loserGoals: 0, winnerRp: 1200, loserRp: 1200, expectedDelta: 50 },      // +50 flat
    // Signed-margin guard: the forfeit winner was BEHIND on goals (1-3) when the
    // opponent quit → margin is negative → NO bonus, flat +50. (A |margin| bonus
    // would have wrongly paid +65 here.)
    { name: 'opponent forfeits while winner trails 1-3', winnerGoals: 1, loserGoals: 3, winnerRp: 1200, loserRp: 1200, expectedDelta: 50 },
  ])('awards forfeit-win RP like a regular win at the frozen score: $name', async ({ winnerGoals, loserGoals, winnerRp, loserRp, expectedDelta }) => {
    // u-2 is the WINNER (the forfeiter is u-1, the absent player). A dominant
    // lead when the opponent quits earns the forfeit-win base + the margin bonus.
    (matchesRepo.getMatch as Mock).mockResolvedValue(
      createCompletedRankedMatch('m-1', 'u-2', undefined, 'forfeit')
    );
    (matchPlayersRepo.listMatchPlayers as Mock).mockResolvedValue([
      createPlayer('u-1', 1, 200, 2, loserGoals, 0),  // forfeiter (loser)
      createPlayer('u-2', 2, 900, 8, winnerGoals, 0), // winner, leads by margin
    ]);
    (usersRepo.getById as Mock).mockImplementation(async (userId: string) => ({ id: userId, is_ai: false }));
    (rankedRepo.getRpChangesForMatch as Mock).mockResolvedValue([]);
    (rankedRepo.ensureProfile as Mock).mockImplementation(async (userId: string) => {
      const rp = userId === 'u-2' ? winnerRp : loserRp;
      return createProfile({
        user_id: userId,
        rp,
        tier: rankedService.tierFromRp(rp),
        placement_status: 'placed',
        placement_played: 3,
      });
    });
    (rankedRepo.applySettlement as Mock).mockResolvedValue(undefined);

    const outcome = await rankedService.settleCompletedRankedMatch('m-1');
    const winnerOutcome = outcome?.byUserId['u-2'];
    const loserOutcome = outcome?.byUserId['u-1'];
    expect(winnerOutcome).toBeDefined();
    expect(winnerOutcome?.newRp).toBe(winnerRp + expectedDelta); // a win → RP goes up by the delta
    expect(winnerOutcome?.deltaRp).toBe(expectedDelta);
    expect(loserOutcome?.deltaRp).toBe(-50);
  });

  it('clamps forfeit loss at zero and persists the applied delta', async () => {
    (matchesRepo.getMatch as Mock).mockResolvedValue(
      createCompletedRankedMatch('m-1', 'u-2', undefined, 'forfeit')
    );
    (matchPlayersRepo.listMatchPlayers as Mock).mockResolvedValue([
      createPlayer('u-1', 1, 400),
      createPlayer('u-2', 2, 900),
    ]);
    (usersRepo.getById as Mock).mockImplementation(async (userId: string) => ({
      id: userId,
      is_ai: false,
    }));
    (rankedRepo.getRpChangesForMatch as Mock).mockResolvedValue([]);
    (rankedRepo.ensureProfile as Mock).mockImplementation(async (userId: string) => {
      if (userId === 'u-1') {
        return createProfile({
          user_id: 'u-1',
          rp: 5,
          tier: rankedService.tierFromRp(5),
          placement_status: 'placed',
          placement_played: 3,
        });
      }
      return createProfile({
        user_id: 'u-2',
        rp: 1200,
        tier: rankedService.tierFromRp(1200),
        placement_status: 'placed',
        placement_played: 3,
      });
    });
    (rankedRepo.applySettlement as Mock).mockResolvedValue(undefined);

    const outcome = await rankedService.settleCompletedRankedMatch('m-1');
    const userOutcome = outcome?.byUserId['u-1'];
    expect(userOutcome).toBeDefined();
    expect(userOutcome?.deltaRp).toBe(-5);
    expect(userOutcome?.newRp).toBe(0);
  });

  it('returns null for completed ranked match without winner_user_id', async () => {
    (matchesRepo.getMatch as Mock).mockResolvedValue(createCompletedRankedMatch('m-1', null));
    (matchPlayersRepo.listMatchPlayers as Mock).mockResolvedValue([
      createPlayer('u-1', 1, 800),
      createPlayer('u-2', 2, 700),
    ]);
    (usersRepo.getById as Mock).mockImplementation(async (userId: string) => ({
      id: userId,
      is_ai: false,
    }));
    (rankedRepo.getRpChangesForMatch as Mock).mockResolvedValue([]);

    const outcome = await rankedService.settleCompletedRankedMatch('m-1');

    expect(outcome).toBeNull();
    expect(rankedRepo.ensureProfile).not.toHaveBeenCalled();
    expect(rankedRepo.applySettlement).not.toHaveBeenCalled();
  });

  it('settles null-winner forfeit as losses for both ranked players', async () => {
    (matchesRepo.getMatch as Mock).mockResolvedValue(
      createCompletedRankedMatch('m-1', null, undefined, 'forfeit')
    );
    (matchPlayersRepo.listMatchPlayers as Mock).mockResolvedValue([
      createPlayer('u-1', 1, 800),
      createPlayer('u-2', 2, 700),
    ]);
    (usersRepo.getById as Mock).mockImplementation(async (userId: string) => ({
      id: userId,
      is_ai: false,
    }));
    (rankedRepo.getRpChangesForMatch as Mock).mockResolvedValue([]);
    (rankedRepo.ensureProfile as Mock).mockImplementation(async (userId: string) =>
      createProfile({
        user_id: userId,
        rp: 1200,
        tier: rankedService.tierFromRp(1200),
        placement_status: 'placed',
        placement_played: 3,
      })
    );
    (rankedRepo.applySettlement as Mock).mockResolvedValue(undefined);

    const outcome = await rankedService.settleCompletedRankedMatch('m-1');

    expect(outcome?.byUserId['u-1']?.deltaRp).toBe(-50);
    expect(outcome?.byUserId['u-2']?.deltaRp).toBe(-50);
    expect(rankedRepo.applySettlement).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          change: expect.objectContaining({ userId: 'u-1', result: 'loss' }),
        }),
        expect.objectContaining({
          change: expect.objectContaining({ userId: 'u-2', result: 'loss' }),
        }),
      ])
    );
  });

  it('applies the season formula during placement game 1 but keeps the rank hidden (in_progress)', async () => {
    // Season 2026: placement games apply RP like any other game (no perf-seed).
    // Human wins by 2 goals (3-1) vs a weaker opponent → +50 base + 15 margin = +65.
    (matchesRepo.getMatch as Mock).mockResolvedValue(
      createCompletedRankedMatch('m-1', 'human-1', { isPlacement: true, aiAnchorRp: 2000 }, 'goals')
    );
    (matchPlayersRepo.listMatchPlayers as Mock).mockResolvedValue([
      createPlayer('human-1', 1, 900, 6, 3, 0),
      createPlayer('ai-1', 2, 400, 4, 1, 0),
    ]);
    (usersRepo.getById as Mock).mockImplementation(async (userId: string) => ({
      id: userId,
      is_ai: userId === 'ai-1',
    }));
    (rankedRepo.getRpChangesForMatch as Mock).mockResolvedValue([]);
    (rankedRepo.ensureProfile as Mock).mockResolvedValue(
      createProfile({
        user_id: 'human-1',
        rp: 450,
        tier: 'Youth Prospect',
        placement_status: 'unplaced',
        placement_played: 0,
        placement_wins: 0,
      })
    );
    (rankedRepo.applySettlement as Mock).mockResolvedValue(undefined);

    const outcome = await rankedService.settleCompletedRankedMatch('m-1');
    const userOutcome = outcome?.byUserId['human-1'];
    expect(userOutcome).toBeDefined();
    expect(userOutcome?.isPlacement).toBe(true);
    expect(userOutcome?.deltaRp).toBe(65); // +50 win + 15 (win by 2)
    expect(userOutcome?.newRp).toBe(515);
    expect(userOutcome?.placementStatus).toBe('in_progress'); // still hidden
    expect(userOutcome?.placementPlayed).toBe(1);
  });

  it('finalizes placement on game 3 and reveals the running rank', async () => {
    // Human is at 580 after 2 placement games; wins game 3 by 1 goal (1-0) vs a
    // weaker opponent → +50 base + 0 margin = +50 → 630, placement complete.
    (matchesRepo.getMatch as Mock).mockResolvedValue(
      createCompletedRankedMatch('m-1', 'human-1', { isPlacement: true, aiAnchorRp: 2000 }, 'goals')
    );
    (matchPlayersRepo.listMatchPlayers as Mock).mockResolvedValue([
      createPlayer('human-1', 1, 8200, 8, 1, 0),
      createPlayer('ai-1', 2, 0, 0, 0, 0),
    ]);
    (usersRepo.getById as Mock).mockImplementation(async (userId: string) => ({
      id: userId,
      is_ai: userId === 'ai-1',
    }));
    (rankedRepo.getRpChangesForMatch as Mock).mockResolvedValue([]);
    (rankedRepo.ensureProfile as Mock).mockResolvedValue(
      createProfile({
        user_id: 'human-1',
        rp: 580,
        tier: 'Youth Prospect',
        placement_status: 'in_progress',
        placement_played: 2,
        placement_wins: 1,
      })
    );
    (rankedRepo.applySettlement as Mock).mockResolvedValue(undefined);

    const outcome = await rankedService.settleCompletedRankedMatch('m-1');
    const userOutcome = outcome?.byUserId['human-1'];
    expect(userOutcome).toBeDefined();
    expect(userOutcome?.isPlacement).toBe(true);
    expect(userOutcome?.placementStatus).toBe('placed');
    expect(userOutcome?.placementPlayed).toBe(3);
    expect(userOutcome?.deltaRp).toBe(50); // +50 win by 1
    expect(userOutcome?.newRp).toBe(630); // 580 + 50, revealed → Reserve
    expect(userOutcome?.newTier).toBe('Reserve');
  });

  it('awards the win-by-4+ margin bonus and the beat-stronger bonus together', async () => {
    // Post-placement: player 600 RP beats a STRONGER opponent (700 RP) 4-0.
    // +50 base + 40 (win by 4+) + 10 (beat stronger) = +100 → 700.
    (matchesRepo.getMatch as Mock).mockResolvedValue(
      createCompletedRankedMatch('m-1', 'human-1', undefined, 'goals')
    );
    (matchPlayersRepo.listMatchPlayers as Mock).mockResolvedValue([
      createPlayer('human-1', 1, 9000, 12, 4, 0),
      createPlayer('human-2', 2, 200, 2, 0, 0),
    ]);
    (usersRepo.getById as Mock).mockImplementation(async (userId: string) => ({
      id: userId,
      is_ai: false,
    }));
    (rankedRepo.getRpChangesForMatch as Mock).mockResolvedValue([]);
    (rankedRepo.ensureProfile as Mock).mockImplementation(async (userId: string) =>
      userId === 'human-1'
        ? createProfile({ user_id: 'human-1', rp: 600, tier: 'Reserve', placement_status: 'placed', placement_played: 3 })
        : createProfile({ user_id: 'human-2', rp: 700, tier: 'Reserve', placement_status: 'placed', placement_played: 3 })
    );
    (rankedRepo.applySettlement as Mock).mockResolvedValue(undefined);

    const outcome = await rankedService.settleCompletedRankedMatch('m-1');
    const userOutcome = outcome?.byUserId['human-1'];
    expect(userOutcome).toBeDefined();
    expect(userOutcome?.placementStatus).toBe('placed');
    expect(userOutcome?.deltaRp).toBe(100); // 50 + 40 + 10
    expect(userOutcome?.newRp).toBe(700);
  });

  it('uses pre-existing rp changes (idempotent read path) without reapplying settlement', async () => {
    (matchesRepo.getMatch as Mock).mockResolvedValue(createCompletedRankedMatch('m-1', 'u-1'));
    (matchPlayersRepo.listMatchPlayers as Mock).mockResolvedValue([
      createPlayer('u-1', 1, 900),
      createPlayer('u-2', 2, 800),
    ]);
    (usersRepo.getById as Mock).mockImplementation(async (userId: string) => ({
      id: userId,
      is_ai: false,
    }));

    const existingRows: RankedRpChangeRow[] = [
      {
        id: 'c-1',
        match_id: 'm-1',
        user_id: 'u-1',
        opponent_user_id: 'u-2',
        opponent_is_ai: false,
        old_rp: 1200,
        delta_rp: 25,
        new_rp: 1225,
        result: 'win',
        is_placement: false,
        placement_game_no: null,
        placement_anchor_rp: null,
        placement_perf_score: null,
        calculation_method: 'ranked_formula',
        created_at: NOW_ISO,
      },
      {
        id: 'c-2',
        match_id: 'm-1',
        user_id: 'u-2',
        opponent_user_id: 'u-1',
        opponent_is_ai: false,
        old_rp: 1200,
        delta_rp: -25,
        new_rp: 1175,
        result: 'loss',
        is_placement: false,
        placement_game_no: null,
        placement_anchor_rp: null,
        placement_perf_score: null,
        calculation_method: 'ranked_formula',
        created_at: NOW_ISO,
      },
    ];
    (rankedRepo.getRpChangesForMatch as Mock).mockResolvedValue(existingRows);
    (rankedRepo.getProfilesByUserIds as Mock).mockResolvedValue([
      createProfile({
        user_id: 'u-1',
        rp: 1225,
        tier: rankedService.tierFromRp(1225),
        placement_status: 'placed',
        placement_played: 3,
      }),
      createProfile({
        user_id: 'u-2',
        rp: 1175,
        tier: rankedService.tierFromRp(1175),
        placement_status: 'placed',
        placement_played: 3,
      }),
    ]);
    (rankedRepo.applySettlement as Mock).mockResolvedValue(undefined);

    const outcome = await rankedService.settleCompletedRankedMatch('m-1');
    expect(outcome).toBeDefined();
    expect(outcome?.isPlacement).toBe(false);
    expect(outcome?.byUserId['u-1']?.deltaRp).toBe(25);
    expect(outcome?.byUserId['u-2']?.deltaRp).toBe(-25);
    expect(rankedRepo.applySettlement).not.toHaveBeenCalled();
    expect(rankedRepo.ensureProfile).not.toHaveBeenCalled();
  });
});
