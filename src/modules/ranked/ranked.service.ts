import { logger } from '../../core/logger.js';
import { matchesRepo } from '../matches/matches.repo.js';
import { usersRepo } from '../users/users.repo.js';
import { rankedRepo } from './ranked.repo.js';
import type {
  RankedAiMatchContext,
  PlacementStatus,
  RankedMatchOutcome,
  RankedPlacementAiContext,
  RankedProfileRow,
  RankedTier,
  RankedUserOutcome,
} from './ranked.types.js';

const DEFAULT_PLACEMENT_MATCHES = 3;
const DEFAULT_PLACEMENT_ANCHOR_RP = 1900;
const MIN_PLACEMENT_ANCHOR_RP = 150;
const MAX_PLACEMENT_ANCHOR_RP = 2700;
const RANKED_BASE_WIN_DELTA = 25;
const RANKED_BASE_LOSS_DELTA = -25;
const RANKED_FORFEIT_EXTRA_LOSS_DELTA = -10;
// How much correctness affects each placement perf score.
// 0% correct → -(SWING/2), 50% → 0, 100% → +(SWING/2)
const PLACEMENT_CORRECTNESS_SWING = 1400;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function roundToNearest25(value: number): number {
  return Math.round(value / 25) * 25;
}

function parseRankedContext(raw: unknown): {
  isPlacement: boolean;
  aiAnchorRp?: number;
} {
  if (!raw || typeof raw !== 'object') {
    return { isPlacement: false };
  }
  const candidate = raw as { isPlacement?: unknown; aiAnchorRp?: unknown };
  return {
    isPlacement: candidate.isPlacement === true,
    aiAnchorRp: typeof candidate.aiAnchorRp === 'number' ? candidate.aiAnchorRp : undefined,
  };
}

function parseWinnerDecisionMethod(raw: unknown): 'goals' | 'penalty_goals' | 'total_points_fallback' | 'forfeit' | null {
  if (!raw) return null;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof raw !== 'object') return null;
  const candidate = (raw as { winnerDecisionMethod?: unknown }).winnerDecisionMethod;
  if (
    candidate === 'goals'
    || candidate === 'penalty_goals'
    || candidate === 'total_points_fallback'
    || candidate === 'forfeit'
  ) {
    return candidate;
  }
  return null;
}

function tierFromRp(rp: number): RankedTier {
  if (rp >= 3200) return 'GOAT';
  if (rp >= 2900) return 'Legend';
  if (rp >= 2600) return 'World-Class';
  if (rp >= 2200) return 'Captain';
  if (rp >= 1850) return 'Key Player';
  if (rp >= 1500) return 'Starting11';
  if (rp >= 1200) return 'Rotation';
  if (rp >= 900) return 'Bench';
  if (rp >= 600) return 'Reserve';
  if (rp >= 300) return 'Youth Prospect';
  return 'Academy';
}

function needsPlacement(profile: RankedProfileRow): boolean {
  return profile.placement_status !== 'placed' || profile.placement_played < profile.placement_required;
}

function computeRankedDelta(playerRp: number, opponentRp: number, isWin: boolean, isForfeitLoss = false): number {
  const rankDiff = opponentRp - playerRp;
  if (isWin) {
    return Math.round(RANKED_BASE_WIN_DELTA + clamp(rankDiff / 50, -15, 20));
  }
  const lossDelta = Math.round(RANKED_BASE_LOSS_DELTA + clamp(rankDiff / 50, -25, 10));
  if (isForfeitLoss) {
    return lossDelta + RANKED_FORFEIT_EXTRA_LOSS_DELTA;
  }
  return lossDelta;
}

function computeNextPlacementAnchor(profile: RankedProfileRow): number {
  if (profile.placement_played <= 0) {
    return DEFAULT_PLACEMENT_ANCHOR_RP;
  }
  const estimate = DEFAULT_PLACEMENT_ANCHOR_RP + (profile.placement_wins * 400) - ((profile.placement_played - profile.placement_wins) * 500);
  return clamp(estimate, MIN_PLACEMENT_ANCHOR_RP, MAX_PLACEMENT_ANCHOR_RP);
}

function correctnessFromAnchor(anchorRp: number): number {
  return clamp(0.52 + (anchorRp / 9000), 0.52, 0.86);
}

function delayProfileFromAnchor(anchorRp: number): { minMs: number; maxMs: number } {
  // Higher-anchor AI answers a bit faster.
  const normalized = (anchorRp - MIN_PLACEMENT_ANCHOR_RP) / (MAX_PLACEMENT_ANCHOR_RP - MIN_PLACEMENT_ANCHOR_RP);
  const minMs = Math.round(900 - (normalized * 400));
  const maxMs = Math.round(5000 - (normalized * 1300));
  return {
    minMs: clamp(minMs, 350, 1000),
    maxMs: clamp(maxMs, 2500, 5200),
  };
}

function computeRankedAiAnchor(profile: RankedProfileRow): number {
  return clamp(roundToNearest25(profile.rp), MIN_PLACEMENT_ANCHOR_RP, MAX_PLACEMENT_ANCHOR_RP);
}

export const rankedService = {
  async ensureProfile(userId: string): Promise<RankedProfileRow> {
    const profile = await rankedRepo.ensureProfile(userId);
    if (profile.tier !== tierFromRp(profile.rp)) {
      const normalizedTier = tierFromRp(profile.rp);
      await rankedRepo.applySettlement([{
        profile: {
          userId: profile.user_id,
          rp: profile.rp,
          tier: normalizedTier,
          placementStatus: profile.placement_status,
          placementPlayed: profile.placement_played,
          placementWins: profile.placement_wins,
          placementSeedRp: profile.placement_seed_rp,
          placementPerfSum: profile.placement_perf_sum,
          placementPointsForSum: profile.placement_points_for_sum,
          placementPointsAgainstSum: profile.placement_points_against_sum,
          currentWinStreak: profile.current_win_streak,
        },
        change: {
          matchId: `profile-normalize:${profile.user_id}`,
          userId: profile.user_id,
          opponentUserId: null,
          opponentIsAi: true,
          oldRp: profile.rp,
          deltaRp: 0,
          newRp: profile.rp,
          result: 'win',
          isPlacement: false,
          placementGameNo: null,
          placementAnchorRp: null,
          placementPerfScore: null,
          calculationMethod: 'ranked_formula',
        },
      }]);
      profile.tier = normalizedTier;
    }
    return profile;
  },

  async getProfile(userId: string): Promise<RankedProfileRow | null> {
    return rankedRepo.getProfile(userId);
  },

  isPlacementRequired(profile: RankedProfileRow): boolean {
    return needsPlacement(profile);
  },

  buildPlacementAiContext(profile: RankedProfileRow): RankedPlacementAiContext {
    const placementGameNo = Math.min(profile.placement_played + 1, DEFAULT_PLACEMENT_MATCHES);
    const aiAnchorRp = computeNextPlacementAnchor(profile);
    return {
      isPlacement: true,
      placementGameNo,
      aiAnchorRp,
      aiCorrectness: correctnessFromAnchor(aiAnchorRp),
      aiDelayProfile: delayProfileFromAnchor(aiAnchorRp),
    };
  },

  buildAiMatchContext(profile: RankedProfileRow): RankedAiMatchContext {
    if (needsPlacement(profile)) {
      return this.buildPlacementAiContext(profile);
    }

    const aiAnchorRp = computeRankedAiAnchor(profile);
    return {
      isPlacement: false,
      aiAnchorRp,
      aiCorrectness: correctnessFromAnchor(aiAnchorRp),
      aiDelayProfile: delayProfileFromAnchor(aiAnchorRp),
    };
  },

  async settleCompletedRankedMatch(matchId: string): Promise<RankedMatchOutcome | null> {
    const match = await matchesRepo.getMatch(matchId);
    if (!match || match.mode !== 'ranked' || match.status !== 'completed') {
      logger.debug({ matchId, mode: match?.mode, status: match?.status }, 'Ranked settlement skipped: match not eligible');
      return null;
    }

    const players = await matchesRepo.listMatchPlayers(matchId);
    if (players.length < 2) {
      logger.debug({ matchId, playerCount: players.length }, 'Ranked settlement skipped: not enough players');
      return null;
    }

    const users = await Promise.all(players.map((player) => usersRepo.getById(player.user_id)));
    const byUserId = new Map(players.map((player, index) => [player.user_id, users[index]]));
    const humanPlayers = players.filter((player) => !byUserId.get(player.user_id)?.is_ai);
    if (humanPlayers.length === 0) {
      logger.debug({ matchId }, 'Ranked settlement skipped: no human players');
      return null;
    }

    const existing = await rankedRepo.getRpChangesForMatch(matchId);
    if (existing.length >= humanPlayers.length) {
      const profiles = await rankedRepo.getProfilesByUserIds(humanPlayers.map((p) => p.user_id));
      const profileByUser = new Map(profiles.map((p) => [p.user_id, p]));
      const outcomeByUser: Record<string, RankedUserOutcome> = {};
      for (const row of existing) {
        if (!profileByUser.has(row.user_id)) continue;
        const profile = profileByUser.get(row.user_id)!;
        outcomeByUser[row.user_id] = {
          userId: row.user_id,
          oldRp: row.old_rp,
          newRp: row.new_rp,
          deltaRp: row.delta_rp,
          oldTier: tierFromRp(row.old_rp),
          newTier: tierFromRp(row.new_rp),
          placementStatus: profile.placement_status,
          placementPlayed: profile.placement_played,
          placementRequired: profile.placement_required,
          isPlacement: row.is_placement,
        };
      }
      return {
        isPlacement: Object.values(outcomeByUser).some((entry) => entry.isPlacement),
        byUserId: outcomeByUser,
      };
    }

    if (!match.winner_user_id) {
      logger.warn({ matchId }, 'Ranked settlement skipped: no winner_user_id for completed match');
      return null;
    }

    const rankedContext = parseRankedContext(match.ranked_context);
    const winnerDecisionMethod = parseWinnerDecisionMethod(match.state_payload);
    logger.info({
      matchId,
      winnerUserId: match.winner_user_id,
      winnerDecisionMethod,
      humanPlayerIds: humanPlayers.map((player) => player.user_id),
      reusedExistingOutcome: existing.length >= humanPlayers.length,
      rankedContext,
    }, 'Ranked settlement started');
    const profiles = await Promise.all(humanPlayers.map((player) => rankedRepo.ensureProfile(player.user_id)));
    const profileByUser = new Map(profiles.map((profile) => [profile.user_id, profile]));

    const settlementEntries: Array<{
      profile: {
        userId: string;
        rp: number;
        tier: RankedTier;
        placementStatus: PlacementStatus;
        placementPlayed: number;
        placementWins: number;
        placementSeedRp: number | null;
        placementPerfSum: number;
        placementPointsForSum: number;
        placementPointsAgainstSum: number;
        currentWinStreak: number;
      };
      change: {
        matchId: string;
        userId: string;
        opponentUserId: string | null;
        opponentIsAi: boolean;
        oldRp: number;
        deltaRp: number;
        newRp: number;
        result: 'win' | 'loss';
        isPlacement: boolean;
        placementGameNo: number | null;
        placementAnchorRp: number | null;
        placementPerfScore: number | null;
        calculationMethod: 'placement_seed' | 'ranked_formula';
      };
      outcome: RankedUserOutcome;
    }> = [];

    for (const player of humanPlayers) {
      const profile = profileByUser.get(player.user_id);
      if (!profile) continue;

      const opponent = players.find((candidate) => candidate.user_id !== player.user_id) ?? null;
      const opponentUser = opponent ? byUserId.get(opponent.user_id) ?? null : null;
      const opponentProfile = opponent && opponentUser && !opponentUser.is_ai
        ? (profileByUser.get(opponent.user_id) ?? await rankedRepo.ensureProfile(opponent.user_id))
        : null;

      const isWin = match.winner_user_id === player.user_id;
      const result: 'win' | 'loss' = isWin ? 'win' : 'loss';
      const oldRp = profile.rp;
      const oldTier = tierFromRp(oldRp);
      const isPlacement = rankedContext.isPlacement || needsPlacement(profile);

      let newRp = oldRp;
      let deltaRp = 0;
      let newTier = oldTier;
      let placementStatus: PlacementStatus = profile.placement_status;
      let placementPlayed = profile.placement_played;
      let placementWins = profile.placement_wins;
      let placementSeedRp = profile.placement_seed_rp;
      let placementPerfSum = profile.placement_perf_sum;
      let placementPointsForSum = profile.placement_points_for_sum;
      let placementPointsAgainstSum = profile.placement_points_against_sum;
      let currentWinStreak = isWin ? profile.current_win_streak + 1 : 0;

      const opponentRp = opponentProfile?.rp ?? rankedContext.aiAnchorRp ?? DEFAULT_PLACEMENT_ANCHOR_RP;

      let placementGameNo: number | null = null;
      let placementAnchorRp: number | null = null;
      let placementPerfScore: number | null = null;
      let calculationMethod: 'placement_seed' | 'ranked_formula' = 'ranked_formula';
      let formulaDeltaRp: number | null = null;

      if (isPlacement) {
        calculationMethod = 'placement_seed';
        placementStatus = 'in_progress';
        placementPlayed = Math.min(DEFAULT_PLACEMENT_MATCHES, profile.placement_played + 1);
        placementWins = profile.placement_wins + (isWin ? 1 : 0);
        placementGameNo = placementPlayed;
        placementAnchorRp = opponentRp;

        // Correctness modifier: rewards/punishes based on how well you answered
        // 0% correct → -700, 50% correct → 0 (neutral), 100% correct → +700
        const totalQs = match.total_questions || 12;
        const correctnessRate = totalQs > 0 ? player.correct_answers / totalQs : 0.5;
        const correctnessModifier = Math.round((correctnessRate - 0.5) * PLACEMENT_CORRECTNESS_SWING);

        placementPerfScore = Math.max(0, opponentRp + (isWin ? 300 : -300) + correctnessModifier);
        placementPerfSum = profile.placement_perf_sum + placementPerfScore;
        placementPointsForSum = profile.placement_points_for_sum + player.total_points;
        placementPointsAgainstSum = profile.placement_points_against_sum + (opponent?.total_points ?? 0);

        if (placementPlayed >= DEFAULT_PLACEMENT_MATCHES) {
          const base = placementPerfSum / DEFAULT_PLACEMENT_MATCHES;
          const dominanceAdj = clamp(
            Math.round((placementPointsForSum - placementPointsAgainstSum) / 50),
            -150,
            150
          );
          const seedRp = clamp(roundToNearest25(base + dominanceAdj), 0, 2600);
          newRp = seedRp;
          deltaRp = newRp - oldRp;
          newTier = tierFromRp(newRp);
          placementStatus = 'placed';
          placementSeedRp = seedRp;
          placementPerfSum = 0;
          placementPointsForSum = 0;
          placementPointsAgainstSum = 0;
          currentWinStreak = 0;
        } else {
          newRp = oldRp;
          deltaRp = 0;
          newTier = oldTier;
        }
      } else {
        formulaDeltaRp = computeRankedDelta(
          oldRp,
          opponentRp,
          isWin,
          !isWin && winnerDecisionMethod === 'forfeit'
        );
        newRp = Math.max(0, oldRp + formulaDeltaRp);
        deltaRp = newRp - oldRp;
        newTier = tierFromRp(newRp);
      }

      logger.info({
        matchId,
        userId: player.user_id,
        opponentUserId: opponent?.user_id ?? null,
        result,
        winnerDecisionMethod,
        isPlacement,
        calculationMethod,
        oldRp,
        formulaDeltaRp,
        appliedDeltaRp: deltaRp,
        newRp,
        clampedByFloor: formulaDeltaRp !== null && formulaDeltaRp !== deltaRp,
        oldTier,
        newTier,
        placementStatus,
        placementPlayed,
        placementRequired: profile.placement_required,
      }, 'Ranked settlement computed player outcome');

      settlementEntries.push({
        profile: {
          userId: player.user_id,
          rp: newRp,
          tier: newTier,
          placementStatus,
          placementPlayed,
          placementWins,
          placementSeedRp,
          placementPerfSum,
          placementPointsForSum,
          placementPointsAgainstSum,
          currentWinStreak,
        },
        change: {
          matchId,
          userId: player.user_id,
          opponentUserId: opponent?.user_id ?? null,
          opponentIsAi: Boolean(opponentUser?.is_ai ?? false),
          oldRp,
          deltaRp,
          newRp,
          result,
          isPlacement,
          placementGameNo,
          placementAnchorRp,
          placementPerfScore,
          calculationMethod,
        },
        outcome: {
          userId: player.user_id,
          oldRp,
          newRp,
          deltaRp,
          oldTier,
          newTier,
          placementStatus,
          placementPlayed,
          placementRequired: profile.placement_required,
          isPlacement,
        },
      });
    }

    logger.info({
      matchId,
      entryCount: settlementEntries.length,
      userIds: settlementEntries.map((entry) => entry.outcome.userId),
    }, 'Ranked settlement applying persistence');
    await rankedRepo.applySettlement(settlementEntries.map((entry) => ({
      profile: entry.profile,
      change: entry.change,
    })));
    logger.info({
      matchId,
      entryCount: settlementEntries.length,
      userIds: settlementEntries.map((entry) => entry.outcome.userId),
    }, 'Ranked settlement persistence applied');

    const outcome = {
      isPlacement: settlementEntries.some((entry) => entry.outcome.isPlacement),
      byUserId: settlementEntries.reduce<Record<string, RankedUserOutcome>>((acc, entry) => {
        acc[entry.outcome.userId] = entry.outcome;
        return acc;
      }, {}),
    };

    logger.info(
      { matchId, outcome: Object.values(outcome.byUserId).map((o) => ({ userId: o.userId, oldRp: o.oldRp, newRp: o.newRp, deltaRp: o.deltaRp, placementStatus: o.placementStatus, placementPlayed: o.placementPlayed, isPlacement: o.isPlacement })) },
      'Ranked settlement completed'
    );

    return outcome;
  },

  async getMatchOutcome(matchId: string): Promise<RankedMatchOutcome | null> {
    const changes = await rankedRepo.getRpChangesForMatch(matchId);
    if (changes.length === 0) return null;
    const profiles = await rankedRepo.getProfilesByUserIds(changes.map((change) => change.user_id));
    const profileByUser = new Map(profiles.map((profile) => [profile.user_id, profile]));

    const byUserId: Record<string, RankedUserOutcome> = {};
    for (const change of changes) {
      const profile = profileByUser.get(change.user_id);
      if (!profile) continue;
      byUserId[change.user_id] = {
        userId: change.user_id,
        oldRp: change.old_rp,
        newRp: change.new_rp,
        deltaRp: change.delta_rp,
        oldTier: tierFromRp(change.old_rp),
        newTier: tierFromRp(change.new_rp),
        placementStatus: profile.placement_status,
        placementPlayed: profile.placement_played,
        placementRequired: profile.placement_required,
        isPlacement: change.is_placement,
      };
    }

    return {
      isPlacement: changes.some((change) => change.is_placement),
      byUserId,
    };
  },

  async getLeaderboard(limit: number, offset: number, country?: string) {
    return rankedRepo.listLeaderboard(limit, offset, country);
  },

  async getUserRank(userId: string, country?: string) {
    return rankedRepo.getUserRank(userId, country);
  },

  tierFromRp,
  DEFAULT_AI_OPPONENT_RP: DEFAULT_PLACEMENT_ANCHOR_RP,
};
