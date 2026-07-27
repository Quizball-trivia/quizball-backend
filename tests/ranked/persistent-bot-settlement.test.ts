/**
 * Unit tests for persistent-bot ranked settlement (PR2).
 *
 * Covers, with the DB mocked (mirrors ranked.service.test.ts):
 *   - the single settle-eligibility predicate (human OR persistent, never
 *     "not ephemeral")
 *   - per-participant placement: a placed bot vs an unplaced human settle each
 *     side by its OWN status in the same match
 *   - persistent bots settle RP but earn ZERO coins (economy stays AI)
 *   - a persistent-bot opponent's RP comes from its real profile (beat-stronger
 *     bonus fires), not the aiAnchorRp fallback
 *   - ephemeral AI regression: only the human settles, aiAnchorRp fallback used,
 *     opponent_is_ai stays true
 *   - the zero-interaction no-contest guard still treats a persistent bot as AI
 */
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('../../src/core/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../src/core/json-cache.js', () => ({
  deleteJsonCacheKeys: vi.fn(),
  getOrLoadJson: <T>(_key: string, _ttl: number, loader: () => Promise<T>) => loader(),
}));

const trackRankPointsChangedMock = vi.fn();
vi.mock('../../src/core/analytics/game-events.js', () => ({
  trackRankPointsChanged: (...args: unknown[]) => trackRankPointsChangedMock(...args),
}));

vi.mock('../../src/modules/matches/matches.repo.js', () => ({
  matchesRepo: { getMatch: vi.fn() },
}));

vi.mock('../../src/modules/matches/match-players.repo.js', () => ({
  matchPlayersRepo: { listMatchPlayers: vi.fn() },
}));

vi.mock('../../src/modules/users/users.repo.js', () => {
  const getById = vi.fn();
  return {
    usersRepo: {
      getById,
      getByIds: vi.fn(async (ids: string[]) => {
        const map = new Map<string, Awaited<ReturnType<typeof getById>>>();
        for (const id of [...new Set(ids)]) {
          const user = await getById(id);
          if (user) map.set(id, user);
        }
        return map;
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
import { isRankedSettleEligible } from '../../src/modules/users/ai-classification.js';
import {
  hasNoHumanInteraction,
  isGenuineAnswerSubmission,
  isNoContestHuman,
} from '../../src/realtime/services/match-interaction.service.js';
import type { MatchAnswerRow } from '../../src/modules/matches/matches.types.js';
import type { MatchPlayerRow, MatchRow } from '../../src/modules/matches/matches.types.js';
import type { RankedProfileRow, RankedTier } from '../../src/modules/ranked/ranked.types.js';

const NOW_ISO = new Date().toISOString();

function createProfile(overrides: Partial<RankedProfileRow> & {
  user_id: string;
  rp: number;
  tier: RankedTier;
}): RankedProfileRow {
  return {
    user_id: overrides.user_id,
    country: overrides.country ?? null,
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

function createPlayer(userId: string, seat: number, totalPoints: number, goals = 0): MatchPlayerRow {
  return {
    match_id: 'm-1',
    user_id: userId,
    seat,
    total_points: totalPoints,
    correct_answers: 0,
    avg_time_ms: null,
    goals,
    penalty_goals: 0,
  };
}

type TestUser = { id: string; is_ai: boolean; ai_kind: string | null; coins?: number };

function wireUsers(users: TestUser[]): void {
  const byId = new Map(users.map((u) => [u.id, u]));
  (usersRepo.getById as Mock).mockImplementation(async (id: string) => byId.get(id) ?? null);
}

describe('isRankedSettleEligible', () => {
  it('allows humans and persistent bots, refuses ephemeral/auction/unknown', () => {
    expect(isRankedSettleEligible({ is_ai: false, ai_kind: null })).toBe(true);
    // A human never has ai_kind set, but is_ai=false must win regardless.
    expect(isRankedSettleEligible({ is_ai: false, ai_kind: 'persistent' })).toBe(true);
    expect(isRankedSettleEligible({ is_ai: true, ai_kind: 'persistent' })).toBe(true);
    expect(isRankedSettleEligible({ is_ai: true, ai_kind: 'ephemeral' })).toBe(false);
    expect(isRankedSettleEligible({ is_ai: true, ai_kind: 'auction' })).toBe(false);
    expect(isRankedSettleEligible({ is_ai: true, ai_kind: null })).toBe(false);
    expect(isRankedSettleEligible({ is_ai: true, ai_kind: 'something-new' })).toBe(false);
  });
});

describe('settleCompletedRankedMatch — persistent bot participation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('settles a persistent bot on BOTH sides: bot RP/streak move, ledger written, coins stay 0', async () => {
    (matchesRepo.getMatch as Mock).mockResolvedValue(
      createCompletedRankedMatch('m-1', 'bot-1', undefined, 'goals')
    );
    (matchPlayersRepo.listMatchPlayers as Mock).mockResolvedValue([
      createPlayer('human-1', 1, 400, 0),
      createPlayer('bot-1', 2, 900, 2), // bot wins 2-0
    ]);
    wireUsers([
      { id: 'human-1', is_ai: false, ai_kind: null },
      { id: 'bot-1', is_ai: true, ai_kind: 'persistent' },
    ]);
    (rankedRepo.getRpChangesForMatch as Mock).mockResolvedValue([]);
    (rankedRepo.ensureProfile as Mock).mockImplementation(async (userId: string) =>
      createProfile({
        user_id: userId,
        rp: 1200,
        tier: rankedService.tierFromRp(1200),
        placement_status: 'placed',
        placement_played: 3,
        current_win_streak: userId === 'bot-1' ? 2 : 0,
      })
    );
    (rankedRepo.applySettlement as Mock).mockResolvedValue(undefined);

    const outcome = await rankedService.settleCompletedRankedMatch('m-1');

    // Both participants got an outcome (bot is not filtered out).
    expect(outcome?.byUserId['bot-1']).toBeDefined();
    expect(outcome?.byUserId['human-1']).toBeDefined();

    // Bot won 2-0 → +50 base +15 margin = +65; streak advances 2 → 3.
    expect(outcome?.byUserId['bot-1']?.deltaRp).toBe(65);
    // Human lost → -25.
    expect(outcome?.byUserId['human-1']?.deltaRp).toBe(-25);

    const entries = (rankedRepo.applySettlement as Mock).mock.calls[0][0] as Array<{
      profile: { userId: string; currentWinStreak: number };
      change: { userId: string; result: string };
      coinsAwarded: number;
    }>;
    const botEntry = entries.find((e) => e.change.userId === 'bot-1')!;
    const humanEntry = entries.find((e) => e.change.userId === 'human-1')!;

    // Ledger row written for the bot with a win result and advancing streak.
    expect(botEntry.change.result).toBe('win');
    expect(botEntry.profile.currentWinStreak).toBe(3);
    // Bot earns NO coins; human earns the win coin reward.
    expect(botEntry.coinsAwarded).toBe(0);
    expect(humanEntry.coinsAwarded).toBeGreaterThan(0);
    expect(outcome?.byUserId['bot-1']?.coinsAwarded).toBe(0);

    // Analytics fire for the human only.
    expect(trackRankPointsChangedMock).toHaveBeenCalledTimes(1);
    expect(trackRankPointsChangedMock).toHaveBeenCalledWith('human-1', expect.any(Number), expect.any(Number), 'ranked_match');
  });

  it('per-participant placement: a placed bot vs an unplaced human settle by their own status', async () => {
    // Match-wide ranked_context.isPlacement=true (from the unplaced human) must
    // NOT force placement math onto the already-placed bot.
    (matchesRepo.getMatch as Mock).mockResolvedValue(
      createCompletedRankedMatch('m-1', 'human-1', { isPlacement: true, aiAnchorRp: 2000 }, 'goals')
    );
    (matchPlayersRepo.listMatchPlayers as Mock).mockResolvedValue([
      createPlayer('human-1', 1, 900, 1), // human wins 1-0
      createPlayer('bot-1', 2, 400, 0),
    ]);
    wireUsers([
      { id: 'human-1', is_ai: false, ai_kind: null },
      { id: 'bot-1', is_ai: true, ai_kind: 'persistent' },
    ]);
    (rankedRepo.getRpChangesForMatch as Mock).mockResolvedValue([]);
    (rankedRepo.ensureProfile as Mock).mockImplementation(async (userId: string) =>
      userId === 'human-1'
        ? createProfile({
            user_id: 'human-1', rp: 450, tier: 'Youth Prospect',
            placement_status: 'unplaced', placement_played: 0, placement_wins: 0,
          })
        : createProfile({
            user_id: 'bot-1', rp: 1200, tier: 'Bench',
            placement_status: 'placed', placement_played: 3,
          })
    );
    (rankedRepo.applySettlement as Mock).mockResolvedValue(undefined);

    const outcome = await rankedService.settleCompletedRankedMatch('m-1');

    // Human is on the placement path (rank stays hidden / in_progress).
    expect(outcome?.byUserId['human-1']?.isPlacement).toBe(true);
    expect(outcome?.byUserId['human-1']?.placementStatus).toBe('in_progress');
    // Bot is on the REGULAR path despite the match-wide placement flag.
    expect(outcome?.byUserId['bot-1']?.isPlacement).toBe(false);
    expect(outcome?.byUserId['bot-1']?.placementStatus).toBe('placed');
  });

  it("uses the persistent bot's real profile RP for the opponent (beat-stronger bonus fires)", async () => {
    // Human 600 RP beats a STRONGER persistent bot at 700 RP by 1 goal.
    // +50 base + 10 beat-stronger = +60. This only fires if opponentProfile is
    // read from the bot's real profile (not the aiAnchorRp fallback).
    (matchesRepo.getMatch as Mock).mockResolvedValue(
      createCompletedRankedMatch('m-1', 'human-1', undefined, 'goals')
    );
    (matchPlayersRepo.listMatchPlayers as Mock).mockResolvedValue([
      createPlayer('human-1', 1, 900, 1),
      createPlayer('bot-1', 2, 200, 0),
    ]);
    wireUsers([
      { id: 'human-1', is_ai: false, ai_kind: null },
      { id: 'bot-1', is_ai: true, ai_kind: 'persistent' },
    ]);
    (rankedRepo.getRpChangesForMatch as Mock).mockResolvedValue([]);
    (rankedRepo.ensureProfile as Mock).mockImplementation(async (userId: string) =>
      userId === 'human-1'
        ? createProfile({ user_id: 'human-1', rp: 600, tier: 'Reserve', placement_status: 'placed', placement_played: 3 })
        : createProfile({ user_id: 'bot-1', rp: 700, tier: 'Reserve', placement_status: 'placed', placement_played: 3 })
    );
    (rankedRepo.applySettlement as Mock).mockResolvedValue(undefined);

    const outcome = await rankedService.settleCompletedRankedMatch('m-1');
    expect(outcome?.byUserId['human-1']?.deltaRp).toBe(60); // 50 + 10 beat-stronger
  });
});

describe('settleCompletedRankedMatch — ephemeral AI regression (unchanged)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('settles the human only during placement and pins the aiAnchorRp fallback as placement anchor', async () => {
    // Placement game vs an ephemeral AI anchored ABOVE the human's RP. The
    // opponent has no real profile, so the recorded placement_anchor_rp comes
    // straight from the aiAnchorRp fallback — deleting that fallback would break
    // this assertion (it would fall back to the DEFAULT anchor 1900 instead).
    (matchesRepo.getMatch as Mock).mockResolvedValue(
      createCompletedRankedMatch('m-1', 'human-1', { isPlacement: true, aiAnchorRp: 2400 }, 'goals')
    );
    (matchPlayersRepo.listMatchPlayers as Mock).mockResolvedValue([
      createPlayer('human-1', 1, 900, 1),
      createPlayer('ai-1', 2, 200, 0),
    ]);
    wireUsers([
      { id: 'human-1', is_ai: false, ai_kind: null },
      { id: 'ai-1', is_ai: true, ai_kind: 'ephemeral' },
    ]);
    (rankedRepo.getRpChangesForMatch as Mock).mockResolvedValue([]);
    (rankedRepo.ensureProfile as Mock).mockImplementation(async (userId: string) =>
      createProfile({
        user_id: userId, rp: 450, tier: 'Youth Prospect',
        placement_status: 'unplaced', placement_played: 0, placement_wins: 0,
      })
    );
    (rankedRepo.applySettlement as Mock).mockResolvedValue(undefined);

    const outcome = await rankedService.settleCompletedRankedMatch('m-1');

    // Only the human settled.
    expect(outcome?.byUserId['human-1']).toBeDefined();
    expect(outcome?.byUserId['ai-1']).toBeUndefined();

    const entries = (rankedRepo.applySettlement as Mock).mock.calls[0][0] as Array<{
      change: {
        userId: string;
        opponentIsAi: boolean;
        placementAnchorRp: number | null;
        isPlacement: boolean;
      };
    }>;
    expect(entries).toHaveLength(1);
    // ensureProfile is called only for the human (opponent AI never ensured).
    expect(rankedRepo.ensureProfile).toHaveBeenCalledTimes(1);
    expect(rankedRepo.ensureProfile).toHaveBeenCalledWith('human-1');

    const change = entries[0].change;
    // The aiAnchorRp fallback (2400) is the recorded placement anchor — NOT the
    // opponent's (non-existent) profile RP, and NOT the default 1900.
    expect(change.isPlacement).toBe(true);
    expect(change.placementAnchorRp).toBe(2400);
    // ledger records opponent as AI.
    expect(change.opponentIsAi).toBe(true);

    // Beat-stronger bonus still requires a REAL opponent profile, so a placement
    // win by 1 goal against ephemeral AI is a flat +50 (anchor doesn't inflate it).
    expect(outcome?.byUserId['human-1']?.deltaRp).toBe(50);
  });
});

describe('settleCompletedRankedMatch — partial-ledger recovery', () => {
  beforeEach(() => vi.clearAllMocks());

  it('settles ONLY the missing bot side, leaves the human row + analytics untouched', async () => {
    // A prior run wrote the human ledger row (or a pre-deploy human-only row is
    // replayed) but not the newly settle-eligible persistent bot. Recovery must
    // insert ONE new bot row, recompute NOTHING for the human, and emit exactly
    // one analytics event total (zero for the already-settled human).
    (matchesRepo.getMatch as Mock).mockResolvedValue(
      createCompletedRankedMatch('m-1', 'bot-1', undefined, 'goals')
    );
    (matchPlayersRepo.listMatchPlayers as Mock).mockResolvedValue([
      createPlayer('human-1', 1, 400, 0),
      createPlayer('bot-1', 2, 900, 2), // bot won 2-0
    ]);
    wireUsers([
      { id: 'human-1', is_ai: false, ai_kind: null },
      { id: 'bot-1', is_ai: true, ai_kind: 'persistent' },
    ]);

    // Existing ledger: human ONLY (already settled to a loss last run).
    const humanRow = {
      id: 'c-human',
      match_id: 'm-1',
      user_id: 'human-1',
      opponent_user_id: 'bot-1',
      opponent_is_ai: true,
      old_rp: 1200,
      delta_rp: -25,
      new_rp: 1175,
      result: 'loss' as const,
      is_placement: false,
      placement_game_no: null,
      placement_anchor_rp: null,
      placement_perf_score: null,
      calculation_method: 'ranked_formula' as const,
      coins_awarded: 100,
      created_at: NOW_ISO,
    };
    (rankedRepo.getRpChangesForMatch as Mock).mockResolvedValue([humanRow]);
    (rankedRepo.getProfilesByUserIds as Mock).mockResolvedValue([
      createProfile({ user_id: 'human-1', rp: 1175, tier: rankedService.tierFromRp(1175), placement_status: 'placed', placement_played: 3 }),
    ]);
    (rankedRepo.ensureProfile as Mock).mockImplementation(async (userId: string) =>
      userId === 'human-1'
        ? createProfile({ user_id: 'human-1', rp: 1175, tier: rankedService.tierFromRp(1175), placement_status: 'placed', placement_played: 3 })
        : createProfile({ user_id: 'bot-1', rp: 1200, tier: rankedService.tierFromRp(1200), placement_status: 'placed', placement_played: 3, current_win_streak: 0 })
    );
    (rankedRepo.applySettlement as Mock).mockResolvedValue(undefined);

    const outcome = await rankedService.settleCompletedRankedMatch('m-1');

    // Exactly one NEW row persisted — the bot's.
    const entries = (rankedRepo.applySettlement as Mock).mock.calls[0][0] as Array<{
      change: { userId: string; result: string };
    }>;
    expect(entries).toHaveLength(1);
    expect(entries[0].change.userId).toBe('bot-1');
    expect(entries[0].change.result).toBe('win');

    // Merged outcome carries BOTH sides; the human side is the reused row values.
    expect(outcome?.byUserId['human-1']?.deltaRp).toBe(-25);
    expect(outcome?.byUserId['human-1']?.newRp).toBe(1175);
    expect(outcome?.byUserId['bot-1']?.deltaRp).toBe(65); // +50 base +15 win-by-2

    // Analytics: ZERO events — the only freshly settled side is the bot (AI →
    // never emits), and the human already emitted its event on the prior run.
    expect(trackRankPointsChangedMock).toHaveBeenCalledTimes(0);
  });

  it('re-reads a fully settled match without recompute, writes, or analytics', async () => {
    (matchesRepo.getMatch as Mock).mockResolvedValue(
      createCompletedRankedMatch('m-1', 'bot-1', undefined, 'goals')
    );
    (matchPlayersRepo.listMatchPlayers as Mock).mockResolvedValue([
      createPlayer('human-1', 1, 400, 0),
      createPlayer('bot-1', 2, 900, 2),
    ]);
    wireUsers([
      { id: 'human-1', is_ai: false, ai_kind: null },
      { id: 'bot-1', is_ai: true, ai_kind: 'persistent' },
    ]);

    const rows = [
      { id: 'c-h', match_id: 'm-1', user_id: 'human-1', opponent_user_id: 'bot-1', opponent_is_ai: true, old_rp: 1200, delta_rp: -25, new_rp: 1175, result: 'loss' as const, is_placement: false, placement_game_no: null, placement_anchor_rp: null, placement_perf_score: null, calculation_method: 'ranked_formula' as const, coins_awarded: 100, created_at: NOW_ISO },
      { id: 'c-b', match_id: 'm-1', user_id: 'bot-1', opponent_user_id: 'human-1', opponent_is_ai: false, old_rp: 1200, delta_rp: 65, new_rp: 1265, result: 'win' as const, is_placement: false, placement_game_no: null, placement_anchor_rp: null, placement_perf_score: null, calculation_method: 'ranked_formula' as const, coins_awarded: 0, created_at: NOW_ISO },
    ];
    (rankedRepo.getRpChangesForMatch as Mock).mockResolvedValue(rows);
    (rankedRepo.getProfilesByUserIds as Mock).mockResolvedValue([
      createProfile({ user_id: 'human-1', rp: 1175, tier: rankedService.tierFromRp(1175), placement_status: 'placed', placement_played: 3 }),
      createProfile({ user_id: 'bot-1', rp: 1265, tier: rankedService.tierFromRp(1265), placement_status: 'placed', placement_played: 3 }),
    ]);
    (rankedRepo.applySettlement as Mock).mockResolvedValue(undefined);

    const outcome = await rankedService.settleCompletedRankedMatch('m-1');

    expect(rankedRepo.applySettlement).not.toHaveBeenCalled();
    expect(rankedRepo.ensureProfile).not.toHaveBeenCalled();
    expect(trackRankPointsChangedMock).not.toHaveBeenCalled();
    expect(outcome?.byUserId['human-1']?.deltaRp).toBe(-25);
    expect(outcome?.byUserId['bot-1']?.deltaRp).toBe(65);
  });
});

describe('no-contest zero-interaction guard treats persistent bots as AI', () => {
  // Exercise the REAL production classifier (isNoContestHuman), the same helper
  // the completion path uses to build its human set — so a regression that lets
  // a persistent bot count as human would fail here.
  function buildHumanSet(roster: TestUser[]): Set<string> {
    return new Set(roster.filter((u) => isNoContestHuman(u)).map((u) => u.id));
  }

  const genuineAnswer = (userId: string): MatchAnswerRow => ({
    id: `a-${userId}`,
    match_id: 'm-1',
    q_index: 0,
    user_id: userId,
    selected_index: 2, // a genuine click
    is_correct: true,
    time_ms: 1000,
    points_earned: 50,
    answer_payload: null,
    created_at: NOW_ISO,
  }) as unknown as MatchAnswerRow;

  it('a persistent bot answering does NOT clear the guard when no human submitted', () => {
    const roster: TestUser[] = [
      { id: 'human-1', is_ai: false, ai_kind: null },
      { id: 'bot-1', is_ai: true, ai_kind: 'persistent' },
    ];
    const humanUserIds = buildHumanSet(roster);
    expect(humanUserIds.has('bot-1')).toBe(false);

    // Only the bot genuinely answered → still counts as NO human interaction.
    expect(isGenuineAnswerSubmission(genuineAnswer('bot-1'))).toBe(true);
    expect(hasNoHumanInteraction([genuineAnswer('bot-1')], humanUserIds)).toBe(true);

    // A real human submission clears it.
    expect(hasNoHumanInteraction([genuineAnswer('human-1')], humanUserIds)).toBe(false);
  });
});
