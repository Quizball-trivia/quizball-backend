import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('../../src/core/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../src/core/config.js', () => ({
  config: {
    RANKED_RP_V1_ENABLED: true,
  },
}));

vi.mock('../../src/modules/matches/matches.repo.js', () => ({
  matchesRepo: {
    getMatch: vi.fn(),
    listMatchPlayers: vi.fn(),
  },
}));

vi.mock('../../src/modules/users/users.repo.js', () => ({
  usersRepo: {
    getById: vi.fn(),
  },
}));

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
import { usersRepo } from '../../src/modules/users/users.repo.js';
import { rankedRepo } from '../../src/modules/ranked/ranked.repo.js';
import { rankedService } from '../../src/modules/ranked/ranked.service.js';
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

function createCompletedRankedMatch(matchId: string, winnerUserId: string | null, rankedContext?: unknown): MatchRow {
  return {
    id: matchId,
    lobby_id: null,
    mode: 'ranked',
    status: 'completed',
    category_a_id: 'cat-a',
    category_b_id: 'cat-b',
    current_q_index: 10,
    total_questions: 12,
    state_payload: null,
    ranked_context: (rankedContext as Record<string, unknown> | null) ?? null,
    started_at: NOW_ISO,
    ended_at: NOW_ISO,
    winner_user_id: winnerUserId,
  };
}

function createPlayer(userId: string, seat: number, totalPoints: number, correctAnswers = 0): MatchPlayerRow {
  return {
    match_id: 'm-1',
    user_id: userId,
    seat,
    total_points: totalPoints,
    correct_answers: correctAnswers,
    avg_time_ms: null,
    goals: 0,
    penalty_goals: 0,
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
      { rp: 3199, expected: 'Legend' },
      { rp: 3200, expected: 'GOAT' },
      { rp: 4000, expected: 'GOAT' },
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

  it.each([
    { name: 'equal-rank win', playerRp: 1200, opponentRp: 1200, winnerUserId: 'u-1', delta: 25, newRp: 1225 },
    { name: 'equal-rank loss', playerRp: 1200, opponentRp: 1200, winnerUserId: 'u-2', delta: -20, newRp: 1180 },
    { name: 'win vs higher rank', playerRp: 1000, opponentRp: 1500, winnerUserId: 'u-1', delta: 35, newRp: 1035 },
    { name: 'loss vs higher rank', playerRp: 1000, opponentRp: 1500, winnerUserId: 'u-2', delta: -10, newRp: 990 },
    { name: 'win vs lower rank', playerRp: 1500, opponentRp: 1000, winnerUserId: 'u-1', delta: 15, newRp: 1515 },
    { name: 'loss vs lower rank', playerRp: 1500, opponentRp: 1000, winnerUserId: 'u-2', delta: -30, newRp: 1470 },
    { name: 'clamp upper win', playerRp: 200, opponentRp: 4000, winnerUserId: 'u-1', delta: 45, newRp: 245 },
    { name: 'clamp lower win (big gap)', playerRp: 4000, opponentRp: 200, winnerUserId: 'u-1', delta: 10, newRp: 4010 },
  ])('applies ranked RP formula correctly: $name', async ({ playerRp, opponentRp, winnerUserId, delta, newRp }) => {
    (matchesRepo.getMatch as Mock).mockResolvedValue(createCompletedRankedMatch('m-1', winnerUserId));
    (matchesRepo.listMatchPlayers as Mock).mockResolvedValue([
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

  it('keeps RP unchanged during placement game 1 and updates placement counters', async () => {
    (matchesRepo.getMatch as Mock).mockResolvedValue(
      createCompletedRankedMatch('m-1', 'human-1', { isPlacement: true, aiAnchorRp: 2000 })
    );
    (matchesRepo.listMatchPlayers as Mock).mockResolvedValue([
      createPlayer('human-1', 1, 900, 6),
      createPlayer('ai-1', 2, 400, 4),
    ]);
    (usersRepo.getById as Mock).mockImplementation(async (userId: string) => ({
      id: userId,
      is_ai: userId === 'ai-1',
    }));
    (rankedRepo.getRpChangesForMatch as Mock).mockResolvedValue([]);
    (rankedRepo.ensureProfile as Mock).mockResolvedValue(
      createProfile({
        user_id: 'human-1',
        rp: 1200,
        tier: 'Rotation',
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
    expect(userOutcome?.deltaRp).toBe(0);
    expect(userOutcome?.newRp).toBe(1200);
    expect(userOutcome?.placementStatus).toBe('in_progress');
    expect(userOutcome?.placementPlayed).toBe(1);
  });

  it('finalizes placement on game 3 and applies seeded RP with dominance adjustment clamp', async () => {
    // Human wins game 3 with 8/12 correct, anchor 2000
    // correctnessModifier = round((8/12 - 0.5) * 1400) = 233
    // perfScore = 2000 + 300 + 233 = 2533
    // perfSum = 3000 + 2533 = 5533, base = 1844.33
    // dominanceAdj = clamp(round((8400-100)/50), -150, 150) = 150 (clamped)
    // seedRp = roundToNearest25(1844.33 + 150) = 2000
    (matchesRepo.getMatch as Mock).mockResolvedValue(
      createCompletedRankedMatch('m-1', 'human-1', { isPlacement: true, aiAnchorRp: 2000 })
    );
    (matchesRepo.listMatchPlayers as Mock).mockResolvedValue([
      createPlayer('human-1', 1, 8200, 8),
      createPlayer('ai-1', 2, 0, 0),
    ]);
    (usersRepo.getById as Mock).mockImplementation(async (userId: string) => ({
      id: userId,
      is_ai: userId === 'ai-1',
    }));
    (rankedRepo.getRpChangesForMatch as Mock).mockResolvedValue([]);
    (rankedRepo.ensureProfile as Mock).mockResolvedValue(
      createProfile({
        user_id: 'human-1',
        rp: 1200,
        tier: 'Rotation',
        placement_status: 'in_progress',
        placement_played: 2,
        placement_wins: 1,
        placement_perf_sum: 3000,
        placement_points_for_sum: 200,
        placement_points_against_sum: 100,
      })
    );
    (rankedRepo.applySettlement as Mock).mockResolvedValue(undefined);

    const outcome = await rankedService.settleCompletedRankedMatch('m-1');
    const userOutcome = outcome?.byUserId['human-1'];
    expect(userOutcome).toBeDefined();
    expect(userOutcome?.isPlacement).toBe(true);
    expect(userOutcome?.placementStatus).toBe('placed');
    expect(userOutcome?.placementPlayed).toBe(3);
    expect(userOutcome?.newRp).toBe(2000);
    expect(userOutcome?.deltaRp).toBe(800);
    expect(userOutcome?.newTier).toBe('Key Player');
  });

  it('uses pre-existing rp changes (idempotent read path) without reapplying settlement', async () => {
    (matchesRepo.getMatch as Mock).mockResolvedValue(createCompletedRankedMatch('m-1', 'u-1'));
    (matchesRepo.listMatchPlayers as Mock).mockResolvedValue([
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
        delta_rp: -20,
        new_rp: 1180,
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
        rp: 1180,
        tier: rankedService.tierFromRp(1180),
        placement_status: 'placed',
        placement_played: 3,
      }),
    ]);
    (rankedRepo.applySettlement as Mock).mockResolvedValue(undefined);

    const outcome = await rankedService.settleCompletedRankedMatch('m-1');
    expect(outcome).toBeDefined();
    expect(outcome?.isPlacement).toBe(false);
    expect(outcome?.byUserId['u-1']?.deltaRp).toBe(25);
    expect(outcome?.byUserId['u-2']?.deltaRp).toBe(-20);
    expect(rankedRepo.applySettlement).not.toHaveBeenCalled();
    expect(rankedRepo.ensureProfile).not.toHaveBeenCalled();
  });
});
