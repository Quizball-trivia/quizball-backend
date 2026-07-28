import { logger } from '../../core/logger.js';
import { deleteJsonCacheKeys, getOrLoadJson } from '../../core/json-cache.js';
import { getRequestId } from '../../core/request-context.js';
import { trackRankPointsChanged } from '../../core/analytics/game-events.js';
import { matchesRepo } from '../matches/matches.repo.js';
import { matchPlayersRepo } from '../matches/match-players.repo.js';
import { usersRepo } from '../users/users.repo.js';
import { isPersistentBot, isRankedSettleEligible, isUserAccountFinalized } from '../users/ai-classification.js';
import { governorService } from '../bots/governor/governor.service.js';
import { storeRepo } from '../store/store.repo.js';
import type { Json } from '../../db/types.js';
import { rankedRepo } from './ranked.repo.js';
import {
  computeParticipantSettlement,
  computeSeasonRpDelta,
  tierFromRp,
} from './season-rp-formula.js';
import type {
  RankedAiMatchContext,
  PlacementStatus,
  RankedMatchOutcome,
  RankedPlacementAiContext,
  RankedProfileRow,
  RankedRpChangeRow,
  RankedTier,
  RankedUserOutcome,
} from './ranked.types.js';

const DEFAULT_PLACEMENT_MATCHES = 3;
const DEFAULT_PLACEMENT_ANCHOR_RP = 1900;
const LIVE_LEADERBOARD_CACHE_TTL_SECONDS = 5;
// Rank is expensive to derive because it compares a player with the eligible
// leaderboard. Keep read traffic off Postgres during active sessions, then
// invalidate the affected player's exact global/country keys after settlement
// so the post-match response is still fresh.
const USER_RANK_CACHE_TTL_SECONDS = 300;

function userRankCacheKey(userId: string, country?: string | null): string {
  const scope = country ? `country:${encodeURIComponent(country)}` : 'global';
  return `ranked:user-rank:v2:${scope}:${userId}`;
}

async function invalidateUserRankCaches(
  users: Array<{ userId: string; country?: string | null }>
): Promise<void> {
  await deleteJsonCacheKeys(users.flatMap(({ userId, country }) => [
    userRankCacheKey(userId),
    ...(country ? [userRankCacheKey(userId, country)] : []),
  ]));
}

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
const MIN_PLACEMENT_ANCHOR_RP = 150;
const MAX_PLACEMENT_ANCHOR_RP = 2700;
// ── Season 2026 RP formula ──────────────────────────────────────────────────
// The delta math itself lives in ./season-rp-formula.js so the burn-in dry-run
// can predict outcomes offline from the SAME source. Re-exported below so
// existing importers of these symbols from ranked.service are unaffected.
export {
  SEASON_INITIAL_RP,
  SEASON_REGULAR_WIN_RP,
  SEASON_PENALTY_WIN_RP,
  SEASON_REGULAR_LOSS_RP,
  SEASON_PENALTY_LOSS_RP,
  SEASON_FORFEIT_LOSS_RP,
  SEASON_OPPONENT_FORFEIT_WIN_RP,
  SEASON_BEAT_STRONGER_BONUS_RP,
  seasonMarginBonus,
  computeSeasonRpDelta,
  tierFromRp,
  computeParticipantSettlement,
} from './season-rp-formula.js';

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

function needsPlacement(profile: RankedProfileRow): boolean {
  return profile.placement_status !== 'placed' || profile.placement_played < profile.placement_required;
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

export function delayProfileFromAnchor(anchorRp: number): { minMs: number; maxMs: number } {
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

/**
 * The RP that persistent-bot selection targets for a human opponent — the SAME
 * anchor the ephemeral path pins into ranked_context, so nearest-RP bot
 * selection preserves today's balancing exactly:
 *   - unplaced / in-placement humans → the current placement anchor
 *     (1900-adaptive per PR2), NOT their hidden 450 RP.
 *   - placed humans → their nearest current RP (rounded to 25).
 * The bot's displayed RP/tier is always its own real profile; this target only
 * drives which bot is a good match.
 */
export function selectionTargetRpForHuman(profile: RankedProfileRow): number {
  return needsPlacement(profile)
    ? computeNextPlacementAnchor(profile)
    : computeRankedAiAnchor(profile);
}

// Reconstruct a settled participant's outcome from its persisted ledger row +
// current profile, WITHOUT recomputing. Used by both the idempotent re-read and
// the partial-recovery merge so an already-settled side is never re-derived.
function outcomeFromLedgerRow(row: RankedRpChangeRow, profile: RankedProfileRow): RankedUserOutcome {
  return {
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

export const rankedService = {
  /**
   * Admin: reset the leaderboard for an event. Archives current standings, then
   * zeroes every real user's RP (tier 'Academy', placement cleared). Records an
   * audit entry in store_transaction_logs with the acting admin's id.
   */
  async resetLeaderboard(options: {
    actorId: string;
    notes?: string | null;
    seasonNumber?: number | null;
  }): Promise<{
    batchId: string;
    profilesReset: number;
    profilesArchived: number;
    rpChangesArchived: number;
  }> {
    const result = await rankedRepo.resetLeaderboard(
      options.actorId,
      options.notes ?? null,
      options.seasonNumber ?? null
    );

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

  async ensureProfiles(userIds: string[]): Promise<Map<string, RankedProfileRow>> {
    const uniqueUserIds = [...new Set(userIds)];
    if (uniqueUserIds.length === 0) return new Map();

    const existing = await rankedRepo.getProfilesByUserIds(uniqueUserIds);
    const profilesByUserId = new Map(existing.map((profile) => [profile.user_id, profile]));
    const needsEnsure = uniqueUserIds.filter((userId) => {
      const profile = profilesByUserId.get(userId);
      return !profile || profile.tier !== tierFromRp(profile.rp);
    });

    const ensured = await Promise.all(needsEnsure.map((userId) => rankedService.ensureProfile(userId)));
    for (const profile of ensured) profilesByUserId.set(profile.user_id, profile);
    return profilesByUserId;
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

  /**
   * Ranked context for a PERSISTENT roster bot match (PR7).
   *
   * Deliberately carries NO aiAnchorRp: PR3 made settlement + payloads read the
   * bot's REAL ranked profile for persistent opponents, so pinning a synthetic
   * anchor would fight that. Placement is likewise never forced on the persistent
   * side — the match-wide isPlacement flag is derived from the human at creation
   * and each side settles from its own profile.
   *
   * TEMPORARY difficulty bridge (until PR8 replaces it with the calibrated model
   * + per-question snapshot): the bot plays with correctness/delay derived from
   * its OWN current RP via the same correctnessFromAnchor / delayProfileFromAnchor
   * the ephemeral path uses, so a persistent bot is no easier/harder than an
   * ephemeral opponent of the same rank today. correctnessFromAnchor already
   * clamps to ≤0.75.
   */
  buildPersistentBotMatchContext(botRp: number): { aiCorrectness: number; aiDelayProfile: { minMs: number; maxMs: number } } {
    const anchor = clamp(botRp, MIN_PLACEMENT_ANCHOR_RP, MAX_PLACEMENT_ANCHOR_RP);
    return {
      aiCorrectness: correctnessFromAnchor(anchor),
      aiDelayProfile: delayProfileFromAnchor(anchor),
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

  async settleCompletedRankedMatch(
    matchId: string,
    occurredAt?: Date,
  ): Promise<RankedMatchOutcome | null> {
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
    // Settle-eligible = real humans PLUS persistent roster bots (both accrue RP,
    // W/L/D, streak, placement). Ephemeral/auction AI never settle a profile.
    // A FINALIZED account is excluded: finalization zeroes its ranked_profiles
    // row, so settling it afterwards would resurrect RP/tier/placement on a
    // deleted player. Merely pending-deletion accounts still settle — they can
    // still cancel and must keep their standing. Re-checked inside the write
    // transaction (applySettlement) against a finalization racing this read.
    const settleEligiblePlayers = players.filter((player) => {
      const user = byUserId.get(player.user_id);
      return user != null && isRankedSettleEligible(user) && !isUserAccountFinalized(user);
    });
    if (settleEligiblePlayers.length === 0) {
      logger.debug({ matchId }, 'Ranked settlement skipped: no settle-eligible players');
      return null;
    }

    // Per-participant idempotency. A match may carry a PARTIAL ledger (a crash
    // between the two per-row writes, or a pre-deploy human-only row now being
    // replayed alongside a newly settle-eligible persistent bot). Reuse the row
    // for every already-settled participant untouched (no recompute, no
    // analytics re-emit) and compute ONLY the players still missing a row.
    const existing = await rankedRepo.getRpChangesForMatch(matchId);
    const existingByUser = new Map(existing.map((row) => [row.user_id, row]));
    const missingPlayers = settleEligiblePlayers.filter((p) => !existingByUser.has(p.user_id));

    if (missingPlayers.length === 0) {
      // Fully settled already — pure idempotent re-read, no writes, no analytics.
      const profiles = await rankedRepo.getProfilesByUserIds(settleEligiblePlayers.map((p) => p.user_id));
      const profileByUser = new Map(profiles.map((p) => [p.user_id, p]));
      await invalidateUserRankCaches(profiles.map((profile) => ({
        userId: profile.user_id,
        country: profile.country,
      })));
      const outcomeByUser: Record<string, RankedUserOutcome> = {};
      for (const row of existing) {
        const profile = profileByUser.get(row.user_id);
        if (!profile) continue;
        outcomeByUser[row.user_id] = outcomeFromLedgerRow(row, profile);
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
      settleEligiblePlayerIds: settleEligiblePlayers.map((player) => player.user_id),
      missingPlayerIds: missingPlayers.map((player) => player.user_id),
      reusedExistingRowCount: existing.length,
      rankedContext,
    }, 'Ranked settlement started');
    // Ensure profiles for ALL eligible players (a missing side reads the
    // already-settled side's profile as its opponent RP), but only the missing
    // players are recomputed below.
    const profiles = await Promise.all(settleEligiblePlayers.map((player) => rankedRepo.ensureProfile(player.user_id)));
    const profileByUser = new Map(profiles.map((profile) => [profile.user_id, profile]));

    const settlementEntries: Array<{
      profile: {
        userId: string;
        country: string | null;
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

    for (const player of missingPlayers) {
      const profile = profileByUser.get(player.user_id);
      if (!profile) continue;

      const playerUser = byUserId.get(player.user_id);
      // Coins are a human-only participation reward. Persistent bots settle RP
      // but must never earn coins (capability matrix: economy stays AI).
      const playerIsHuman = playerUser != null && !playerUser.is_ai;

      const opponent = players.find((candidate) => candidate.user_id !== player.user_id) ?? null;
      const opponentUser = opponent ? byUserId.get(opponent.user_id) ?? null : null;
      // Opponent RP comes from a real profile for humans AND persistent bots;
      // ephemeral/auction opponents fall back to the pinned aiAnchorRp below.
      // A FINALIZED opponent is excluded here too: its profile was zeroed by
      // deletion finalization, so rating against it would read 0 RP as a genuine
      // rating (and ensureProfile would recreate a row for a deleted user).
      const opponentProfile = opponent
        && opponentUser
        && isRankedSettleEligible(opponentUser)
        && !isUserAccountFinalized(opponentUser)
        ? (profileByUser.get(opponent.user_id) ?? await rankedRepo.ensureProfile(opponent.user_id))
        : null;

      const isWin = !bothForfeit && match.winner_user_id === player.user_id;
      const oldRp = profile.rp;

      const opponentRp = opponentProfile?.rp ?? rankedContext.aiAnchorRp ?? DEFAULT_PLACEMENT_ANCHOR_RP;
      const goalMargin = (player.goals ?? 0) - (opponent?.goals ?? 0);
      const opponentIsStronger = opponentProfile != null && opponentProfile.rp > oldRp;
      const settlement = computeParticipantSettlement({
        oldRp,
        placementStatus: profile.placement_status,
        placementPlayed: profile.placement_played,
        placementWins: profile.placement_wins,
        placementSeedRp: profile.placement_seed_rp,
        placementPerfSum: profile.placement_perf_sum,
        placementPointsForSum: profile.placement_points_for_sum,
        placementPointsAgainstSum: profile.placement_points_against_sum,
        currentWinStreak: profile.current_win_streak,
        placementRequired: profile.placement_required,
        isWin,
        decision: winnerDecisionMethod,
        goalMargin,
        opponentRp,
        opponentIsStronger,
        isHumanForCoins: playerIsHuman,
      });
      const formulaDeltaRp = computeSeasonRpDelta(
        isWin,
        winnerDecisionMethod,
        goalMargin,
        opponentIsStronger,
      );

      logger.info({
        matchId,
        userId: player.user_id,
        opponentUserId: opponent?.user_id ?? null,
        result: settlement.result,
        winnerDecisionMethod,
        isPlacement: settlement.isPlacement,
        calculationMethod: settlement.calculationMethod,
        oldRp,
        formulaDeltaRp,
        appliedDeltaRp: settlement.deltaRp,
        newRp: settlement.newRp,
        clampedByFloor: formulaDeltaRp !== settlement.deltaRp,
        oldTier: settlement.oldTier,
        newTier: settlement.newTier,
        placementStatus: settlement.placementStatus,
        placementPlayed: settlement.placementPlayed,
        placementRequired: profile.placement_required,
      }, 'Ranked settlement computed player outcome');

      settlementEntries.push({
        profile: {
          userId: player.user_id,
          country: profile.country,
          rp: settlement.newRp,
          tier: settlement.newTier,
          placementStatus: settlement.placementStatus,
          placementPlayed: settlement.placementPlayed,
          placementWins: settlement.placementWins,
          placementSeedRp: settlement.placementSeedRp,
          placementPerfSum: settlement.placementPerfSum,
          placementPointsForSum: settlement.placementPointsForSum,
          placementPointsAgainstSum: settlement.placementPointsAgainstSum,
          currentWinStreak: settlement.currentWinStreak,
        },
        change: {
          matchId,
          userId: player.user_id,
          opponentUserId: opponent?.user_id ?? null,
          opponentIsAi: Boolean(opponentUser?.is_ai ?? false),
          oldRp,
          deltaRp: settlement.deltaRp,
          newRp: settlement.newRp,
          result: settlement.result,
          isPlacement: settlement.isPlacement,
          placementGameNo: settlement.placementGameNo,
          placementAnchorRp: settlement.placementAnchorRp,
          placementPerfScore: settlement.placementPerfScore,
          calculationMethod: settlement.calculationMethod,
        },
        coinsAwarded: settlement.coinsAwarded,
        outcome: {
          userId: player.user_id,
          oldRp,
          newRp: settlement.newRp,
          deltaRp: settlement.deltaRp,
          coinsAwarded: settlement.coinsAwarded,
          oldTier: settlement.oldTier,
          newTier: settlement.newTier,
          placementStatus: settlement.placementStatus,
          placementPlayed: settlement.placementPlayed,
          placementRequired: profile.placement_required,
          isPlacement: settlement.isPlacement,
        },
      });
    }

    logger.info({
      matchId,
      entryCount: settlementEntries.length,
      userIds: settlementEntries.map((entry) => entry.outcome.userId),
    }, 'Ranked settlement applying persistence');
    // Only the participants THIS call actually wrote. A concurrent settlement of
    // the same match loses the ON CONFLICT, and a finalized account is skipped
    // inside the transaction — neither may fire the post-write side effects below.
    const applied = await rankedRepo.applySettlement(settlementEntries.map((entry) => ({
      profile: entry.profile,
      change: entry.change,
      coinsAwarded: entry.coinsAwarded,
    })), occurredAt);
    // A writer that does not report an applied set (the burn-in writer's stub)
    // is treated as "everything landed", which is the pre-existing behaviour.
    const appliedUserIds = applied ?? new Set(settlementEntries.map((entry) => entry.outcome.userId));
    const appliedEntries = settlementEntries.filter((entry) => appliedUserIds.has(entry.outcome.userId));
    await invalidateUserRankCaches(appliedEntries.map((entry) => ({
      userId: entry.outcome.userId,
      country: entry.profile.country,
    })));
    logger.info({
      matchId,
      entryCount: settlementEntries.length,
      userIds: settlementEntries.map((entry) => entry.outcome.userId),
      appliedUserIds: [...appliedUserIds],
    }, 'Ranked settlement persistence applied');

    const byUserIdOutcome: Record<string, RankedUserOutcome> = {};
    // Reuse the untouched outcome for any participant already settled in a prior
    // (partial) run — no recompute.
    for (const row of existing) {
      const profile = profileByUser.get(row.user_id);
      if (!profile) continue;
      byUserIdOutcome[row.user_id] = outcomeFromLedgerRow(row, profile);
    }
    // Overlay the participants whose row this call actually wrote. Anything this
    // call did NOT write is re-read from the committed ledger below rather than
    // reported from the in-memory computation, which would be fiction: a
    // finalized account never settled at all, and a participant lost to a racing
    // replica settled with THAT replica's numbers.
    for (const entry of appliedEntries) {
      byUserIdOutcome[entry.outcome.userId] = entry.outcome;
    }
    const unappliedEntries = settlementEntries.filter(
      (entry) => !appliedUserIds.has(entry.outcome.userId)
    );
    if (unappliedEntries.length > 0) {
      const committed = await rankedRepo.getRpChangesForMatch(matchId);
      const committedByUser = new Map(committed.map((row) => [row.user_id, row]));
      const committedProfiles = await rankedRepo.getProfilesByUserIds(
        unappliedEntries.map((entry) => entry.outcome.userId)
      );
      const committedProfileByUser = new Map(committedProfiles.map((p) => [p.user_id, p]));
      for (const entry of unappliedEntries) {
        const row = committedByUser.get(entry.outcome.userId);
        const committedProfile = committedProfileByUser.get(entry.outcome.userId);
        // No committed row => the participant genuinely did not settle (finalized
        // account): leave it out of the outcome entirely.
        if (!row || !committedProfile) continue;
        byUserIdOutcome[entry.outcome.userId] = outcomeFromLedgerRow(row, committedProfile);
      }
      logger.info({
        matchId,
        unappliedUserIds: unappliedEntries.map((entry) => entry.outcome.userId),
      }, 'Ranked settlement reconciled participants this call did not write');
    }
    const outcome = {
      isPlacement: Object.values(byUserIdOutcome).some((o) => o.isPlacement),
      byUserId: byUserIdOutcome,
    };

    logger.info(
      { matchId, outcome: Object.values(outcome.byUserId).map((o) => ({ userId: o.userId, oldRp: o.oldRp, newRp: o.newRp, deltaRp: o.deltaRp, placementStatus: o.placementStatus, placementPlayed: o.placementPlayed, isPlacement: o.isPlacement })) },
      'Ranked settlement completed'
    );

    // Analytics: emit once per human player ONLY for rows THIS call actually
    // inserted (never the reused/idempotent ones, and never a row a racing
    // replica won), so ranked progression is visible in PostHog without
    // double-counting a replay. Persistent bots stay out of analytics.
    for (const entry of appliedEntries) {
      const settledUser = byUserId.get(entry.outcome.userId);
      if (settledUser && settledUser.is_ai) continue;
      const o = entry.outcome;
      trackRankPointsChanged(o.userId, o.oldRp, o.newRp, o.isPlacement ? 'placement' : 'ranked_match');
    }

    // Rubber-band governor (PR9): fold this result into each PERSISTENT BOT's
    // win-rate EMA and re-evaluate its effective-skill offset. Only entries this
    // call actually WROTE (a replay must not double-count a sample) and only
    // matches against a HUMAN opponent — the 40-45%/45-55% targets are defined
    // against humans, and a bot-vs-bot result would be a self-referential
    // signal. Awaited so the write lands before the reservation is released
    // (possession-completion releases only after settlement returns), but the
    // service swallows its own errors so a governor fault can never fail
    // settlement or strand a reservation.
    for (const entry of appliedEntries) {
      const settledUser = byUserId.get(entry.outcome.userId);
      if (!settledUser || !isPersistentBot(settledUser)) continue;
      const opponentUserId = entry.change.opponentUserId;
      const opponentUser = opponentUserId ? byUserId.get(opponentUserId) : null;
      if (!opponentUser || opponentUser.is_ai) continue;
      await governorService.recordSettledMatch({
        botUserId: entry.outcome.userId,
        botRp: entry.outcome.newRp,
        won: entry.change.result === 'win',
        matchId,
      });
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
      byUserId[change.user_id] = outcomeFromLedgerRow(change, profile);
    }

    return {
      isPlacement: changes.some((change) => change.is_placement),
      byUserId,
    };
  },

  async getLeaderboard(limit: number, offset: number, country?: string) {
    const scope = country ? `country:${encodeURIComponent(country)}` : 'global';
    const key = `ranked:leaderboard:v1:${scope}:${limit}:${offset}`;
    return getOrLoadJson(key, LIVE_LEADERBOARD_CACHE_TTL_SECONDS, () =>
      rankedRepo.listLeaderboard(limit, offset, country)
    );
  },

  async listSeasons() {
    return rankedRepo.listSeasons();
  },

  async getArchivedLeaderboard(batchId: string, limit: number, offset: number, country?: string) {
    return rankedRepo.listArchivedLeaderboard(batchId, limit, offset, country);
  },

  async getArchivedUserRank(batchId: string, userId: string, country?: string) {
    return rankedRepo.getArchivedUserRank(batchId, userId, country);
  },

  async getUserRank(userId: string, country?: string) {
    return getOrLoadJson(
      userRankCacheKey(userId, country),
      USER_RANK_CACHE_TTL_SECONDS,
      () => rankedRepo.getUserRank(userId, country)
    );
  },

  tierFromRp,
  DEFAULT_AI_OPPONENT_RP: DEFAULT_PLACEMENT_ANCHOR_RP,
};
