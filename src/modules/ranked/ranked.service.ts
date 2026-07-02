import { logger } from '../../core/logger.js';
import { getRequestId } from '../../core/request-context.js';
import { trackRankPointsChanged } from '../../core/analytics/game-events.js';
import { matchesRepo } from '../matches/matches.repo.js';
import { matchPlayersRepo } from '../matches/match-players.repo.js';
import { usersRepo } from '../users/users.repo.js';
import { storeRepo } from '../store/store.repo.js';
import type { Json } from '../../db/types.js';
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

// ── Placement seed range ─────────────────────────────────────────────────────
// The best possible placement run lands at the TOP OF RESERVE (875 RP) — every
// higher tier (Bench → GOAT) must be climbed through regular ranked play.
//
// The internal perf-score scale (anchors ~1900, ±550 win/loss swing, ±350
// correctness, ±150 dominance) is deliberately left untouched: it produces
// well-differentiated raw scores on the legacy 0–2600 scale. The final seed is
// then linearly mapped down to 0–875. A naive clamp at 875 instead would have
// collapsed nearly every player (even 0-3 runs) onto the cap, since raw
// scores rarely fall below ~850.
// Coin participation rewards granted once per settled ranked match.
const RANKED_WIN_COINS = 300;
const RANKED_LOSS_COINS = 100;
const MIN_PLACEMENT_ANCHOR_RP = 150;
const MAX_PLACEMENT_ANCHOR_RP = 2700;
// ── Season 2026 RP formula ──────────────────────────────────────────────────
// Transparent, margin-based scoring (replaces the old Elo-style delta). A win
// is worth a flat base by how it was decided, plus a goal-margin bonus, plus a
// small bonus for beating a higher-ranked opponent. Losses subtract.
const SEASON_REGULAR_WIN_RP = 50;
const SEASON_PENALTY_WIN_RP = 35;
const SEASON_REGULAR_LOSS_RP = -25;
const SEASON_PENALTY_LOSS_RP = -15;
const SEASON_FORFEIT_LOSS_RP = -50; // you quit
const SEASON_OPPONENT_FORFEIT_WIN_RP = 50; // opponent quit → you get a regular win
const SEASON_BEAT_STRONGER_BONUS_RP = 10; // opponent's current RP was higher than yours
// Goal-margin bonus added to a win (by goal difference). Win by 1 → +0.
// Signed margin: bonus only when the player was AHEAD (margin > 0). A winner who
// took the result while behind on goals (e.g. an opponent-forfeit win at 0-2)
// earns no margin bonus.
function seasonMarginBonus(signedGoalMargin: number): number {
  if (signedGoalMargin >= 4) return 40;
  if (signedGoalMargin === 3) return 30;
  if (signedGoalMargin === 2) return 15;
  return 0;
}
// Hidden starting rank for a brand-new ranked profile (Youth Prospect band).
// Mirrors the literal used in ranked.repo.ts ensureProfile().
export const SEASON_INITIAL_RP = 450;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function roundToNearest25(value: number): number {
  return Math.round(value / 25) * 25;
}

export function parseRankedContext(raw: unknown): {
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

export function tierFromRp(rp: number): RankedTier {
  if (rp >= 5000) return 'GOAT';
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

function coinsForRankedResult(result: 'win' | 'loss'): number {
  return result === 'win' ? RANKED_WIN_COINS : RANKED_LOSS_COINS;
}

/**
 * Season 2026 RP delta for one player in a settled match.
 * @param isWin            did this player win
 * @param decision         how the winner was decided ('penalty_goals' = shootout,
 *                         'forfeit' = a player quit, else a regular goals result)
 * @param goalMargin       signed myGoals - oppGoals (bonuses a win only when ahead)
 * @param opponentIsStronger  opponent's current RP was strictly higher than mine
 */
function computeSeasonRpDelta(
  isWin: boolean,
  decision: 'goals' | 'penalty_goals' | 'total_points_fallback' | 'forfeit' | null,
  goalMargin: number,
  opponentIsStronger: boolean,
): number {
  const isPenalty = decision === 'penalty_goals';
  const isForfeit = decision === 'forfeit';

  if (!isWin) {
    if (isForfeit) return SEASON_FORFEIT_LOSS_RP; // -50: this player quit
    return isPenalty ? SEASON_PENALTY_LOSS_RP : SEASON_REGULAR_LOSS_RP; // -15 / -25
  }

  // Win. Opponent forfeited → base forfeit-win RP, PLUS the goal-margin bonus
  // if this player was already ahead by a margin when the opponent quit (a
  // dominant 4-0 lead earns the win bonus + the +40 margin, not a flat +50).
  if (isForfeit) return SEASON_OPPONENT_FORFEIT_WIN_RP + seasonMarginBonus(goalMargin);

  let delta = isPenalty ? SEASON_PENALTY_WIN_RP : SEASON_REGULAR_WIN_RP; // +35 / +50
  // Margin bonus only applies to a decisive (goals) win — a shootout is by
  // definition level on goals, so no margin bonus there.
  if (!isPenalty) delta += seasonMarginBonus(goalMargin);
  if (opponentIsStronger) delta += SEASON_BEAT_STRONGER_BONUS_RP; // +10
  return delta;
}

function computeNextPlacementAnchor(profile: RankedProfileRow): number {
  if (profile.placement_played <= 0) {
    return DEFAULT_PLACEMENT_ANCHOR_RP;
  }
  const estimate = DEFAULT_PLACEMENT_ANCHOR_RP + (profile.placement_wins * 400) - ((profile.placement_played - profile.placement_wins) * 500);
  return clamp(estimate, MIN_PLACEMENT_ANCHOR_RP, MAX_PLACEMENT_ANCHOR_RP);
}

export function correctnessFromAnchor(anchorRp: number): number {
  return clamp(0.35 + ((anchorRp - 150) / 2550) * 0.40, 0.35, 0.75);
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
  /**
   * Admin: reset the leaderboard for an event. Archives current standings, then
   * zeroes every real user's RP (tier 'Academy', placement cleared). Records an
   * audit entry in store_transaction_logs with the acting admin's id.
   */
  async resetLeaderboard(options: { actorId: string; notes?: string | null }): Promise<{
    batchId: string;
    profilesReset: number;
    profilesArchived: number;
    rpChangesArchived: number;
  }> {
    const result = await rankedRepo.resetLeaderboard(options.actorId, options.notes ?? null);

    await storeRepo.insertTransactionLog({
      eventType: 'leaderboard_reset',
      outcome: 'success',
      actorUserId: options.actorId,
      reason: options.notes ?? 'Leaderboard reset for event',
      requestId: getRequestId(),
      metadata: {
        batchId: result.batchId,
        profilesReset: result.profilesReset,
        profilesArchived: result.profilesArchived,
        rpChangesArchived: result.rpChangesArchived,
      } as unknown as Json,
    });

    logger.info(
      { actorId: options.actorId, ...result },
      'Leaderboard reset applied'
    );

    return result;
  },

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
        coinsAwarded: 0, // tier normalization only — no reward
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

    const players = await matchPlayersRepo.listMatchPlayers(matchId);
    if (players.length < 2) {
      logger.debug({ matchId, playerCount: players.length }, 'Ranked settlement skipped: not enough players');
      return null;
    }

    const usersById = await usersRepo.getByIds(players.map((player) => player.user_id));
    const byUserId = new Map(players.map((player) => [player.user_id, usersById.get(player.user_id) ?? null]));
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
          coinsAwarded: row.coins_awarded,
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

    const rankedContext = parseRankedContext(match.ranked_context);
    const winnerDecisionMethod = parseWinnerDecisionMethod(match.state_payload);
    const bothForfeit = !match.winner_user_id && winnerDecisionMethod === 'forfeit';
    if (!match.winner_user_id && !bothForfeit) {
      logger.warn({ matchId }, 'Ranked settlement skipped: no winner_user_id for completed match');
      return null;
    }

    logger.info({
      matchId,
      winnerUserId: match.winner_user_id,
      winnerDecisionMethod,
      bothForfeit,
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
      coinsAwarded: number;
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

      const isWin = !bothForfeit && match.winner_user_id === player.user_id;
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

      // Season 2026: BOTH placement and post-placement games use the same
      // transparent formula applied to the running RP. Placement no longer
      // computes a separate perf-based seed — every player starts hidden at
      // SEASON_INITIAL_RP (450) and the 3 placement games move that rank like
      // any other game; the rank is simply kept "in_progress" (hidden) until
      // the 3rd game, then revealed.
      const goalMargin = (player.goals ?? 0) - (opponent?.goals ?? 0);
      const opponentIsStronger = opponentProfile != null && opponentProfile.rp > oldRp;
      const seasonDeltaRp = computeSeasonRpDelta(isWin, winnerDecisionMethod, goalMargin, opponentIsStronger);

      if (isPlacement) {
        calculationMethod = 'placement_seed';
        placementStatus = 'in_progress';
        placementPlayed = Math.min(DEFAULT_PLACEMENT_MATCHES, profile.placement_played + 1);
        placementWins = profile.placement_wins + (isWin ? 1 : 0);
        placementGameNo = placementPlayed;
        placementAnchorRp = opponentRp;

        // Apply the same formula during placement; just keep the rank hidden
        // until the player has finished all placement games.
        formulaDeltaRp = seasonDeltaRp;
        newRp = Math.max(0, oldRp + seasonDeltaRp);
        deltaRp = newRp - oldRp;
        newTier = tierFromRp(newRp);

        if (placementPlayed >= DEFAULT_PLACEMENT_MATCHES) {
          placementStatus = 'placed';
          placementSeedRp = newRp; // record where they landed after placement
          placementPerfSum = 0;
          placementPointsForSum = 0;
          placementPointsAgainstSum = 0;
        }
        // Note: placement games 1–2 keep status 'in_progress' (rank hidden) but
        // DO apply the RP delta above — the running rank is revealed at game 3.
      } else {
        calculationMethod = 'ranked_formula';
        formulaDeltaRp = seasonDeltaRp;
        newRp = Math.max(0, oldRp + seasonDeltaRp);
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
        coinsAwarded: coinsForRankedResult(result),
        outcome: {
          userId: player.user_id,
          oldRp,
          newRp,
          deltaRp,
          coinsAwarded: coinsForRankedResult(result),
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
      coinsAwarded: entry.coinsAwarded,
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

    // Analytics: emit once per human player when RP is FRESHLY settled (not on the
    // idempotent re-read path above), so ranked progression is visible in PostHog.
    for (const o of Object.values(outcome.byUserId)) {
      trackRankPointsChanged(o.userId, o.oldRp, o.newRp, o.isPlacement ? 'placement' : 'ranked_match');
    }

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
        coinsAwarded: change.coins_awarded,
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
