import type { QuizballServer, QuizballSocket } from '../socket-server.js';
import { logger } from '../../core/logger.js';
import { matchPlayersRepo } from '../../modules/matches/match-players.repo.js';
import { matchesRepo } from '../../modules/matches/matches.repo.js';
import { usersRepo } from '../../modules/users/users.repo.js';
import { matchesService, resolveMatchVariant } from '../../modules/matches/matches.service.js';
import type { MatchRow } from '../../modules/matches/matches.types.js';
import { objectivesService } from '../../modules/objectives/index.js';
import { progressionService } from '../../modules/progression/progression.service.js';
import { rankedService } from '../../modules/ranked/ranked.service.js';
import { rankedRepo } from '../../modules/ranked/ranked.repo.js';
import { cancelMatchQuestionTimer } from '../match-flow.js';
import { cancelPossessionHalftimeTimer } from '../possession-match-flow.js';
import { deleteMatchCache, type MatchCache } from '../match-cache.js';
import { getRedisClient } from '../redis.js';
import {
  lastMatchKey,
  matchDisconnectKey,
  matchExitPendingKey,
  matchForfeitPendingUserKey,
  matchGraceKey,
  matchPauseKey,
  matchPresenceKey,
  matchReconnectCountKey,
} from '../match-keys.js';
import { rankedAiMatchKey } from '../ai-ranked.constants.js';
import { buildStandings } from '../match-utils.js';
import { acquireLock, releaseLock, startLockHeartbeat } from '../locks.js';
import type { MatchForfeitPendingPayload } from '../socket.types.js';
import { userSessionGuardService } from './user-session-guard.service.js';
import { getParticipantSnapshot } from './match-participants.helpers.js';
import {
  buildFinalResultsPayload,
  emitFinalResultsToMatchParticipants,
} from './match-final-results.service.js';
import { resolveMatchReplayEvidence } from './match-entry.service.js';
import { applyPartyQuizDropouts } from './party-quiz-dropout.service.js';
import {
  findOpponentInDisconnectGrace,
  markExcusedExitPending,
} from './match-excused-exit.service.js';
import { finalizeRankedNoContest, matchForfeitKey } from './ranked-no-contest.service.js';

export { matchForfeitKey };

const FORFEIT_REPLAY_TTL_SEC = 600;
const FORFEIT_PENDING_TTL_SEC = 60;

// Ranked early-forfeit grace: if a ranked match is forfeited/abandoned before
// at least this many rounds have been played, it's treated as a no-contest —
// the match is cancelled, NO RP changes for either player (+0), and both human
// players get their consumed ranked ticket refunded. At or beyond this many
// rounds the normal forfeit penalty (-50 / +50) and ticket consumption stand.
// current_q_index is the 0-based round counter, so "< 2 rounds played" means
// the index has not yet reached 2.
const RANKED_EARLY_FORFEIT_MIN_ROUNDS = 2;

// Early-forfeit abuse penalty: the first N early-forfeits in a 24h window are
// treated leniently (no-contest, ticket refunded, no RP change). Beyond that,
// the user is penalized — 100 RP deducted and the ticket is NOT refunded — to
// prevent infinite reload-and-dodge farming.
const EARLY_FORFEIT_FREE_LIMIT = 3;
const EARLY_FORFEIT_PENALTY_RP = 100;


// ─── Forfeit-pending payload helpers ──────────────────────────────────────
// These produce the "we're finalizing the match for you/your opponent"
// banner payloads stashed in Redis until the loser's socket sees them.

export function buildReconnectLimitForfeitPendingPayload(matchId: string): MatchForfeitPendingPayload {
  return {
    matchId,
    reason: 'reconnect_limit',
    message: 'You lost the match after exceeding the reconnect limit. Finalizing results...',
  };
}

export function buildOpponentForfeitPendingPayload(
  matchId: string,
  reason: 'opponent_forfeit' | 'opponent_reconnect_limit'
): MatchForfeitPendingPayload {
  return {
    matchId,
    reason,
    message: reason === 'opponent_forfeit'
      ? 'Opponent forfeited. Finalizing results...'
      : 'Opponent did not reconnect in time. Finalizing results...',
  };
}

export async function setForfeitPendingForUser(
  userId: string,
  payload: MatchForfeitPendingPayload
): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;
  await redis.set(matchForfeitPendingUserKey(userId), JSON.stringify(payload), { EX: FORFEIT_PENDING_TTL_SEC });
}

export function parseForfeitPendingPayload(raw: string): MatchForfeitPendingPayload | null {
  try {
    const parsed = JSON.parse(raw) as Partial<MatchForfeitPendingPayload>;
    if (
      !parsed.matchId ||
      !(
        parsed.reason === 'reconnect_limit' ||
        parsed.reason === 'opponent_forfeit' ||
        parsed.reason === 'opponent_reconnect_limit'
      )
    ) return null;
    return {
      matchId: parsed.matchId,
      reason: parsed.reason,
      message: parsed.message ?? 'You lost the match. Finalizing results...',
    };
  } catch {
    return null;
  }
}

export interface FinalizeMatchAsForfeitParams {
  matchId: string;
  forfeitingUserId: string;
  activeMatch?: MatchRow | null;
  cacheSnapshot?: MatchCache | null;
  cleanupRedisKeys?: string[];
}

export interface FinalizeMatchAsForfeitResult {
  matchId: string;
  winnerId: string | null;
  resultVersion: number;
  completed: boolean;
  /** True when a ranked match was cancelled as a no-contest early forfeit
   *  (no RP change, tickets refunded). */
  cancelledNoContest?: boolean;
}

export async function finalizeMatchAsForfeit(
  params: FinalizeMatchAsForfeitParams
): Promise<FinalizeMatchAsForfeitResult> {
  const lockKey = `lock:match:${params.matchId}:complete`;
  const lockTtlMs = 15_000;
  const lock = await acquireLock(lockKey, lockTtlMs);
  if (!lock.acquired || !lock.token) {
    return {
      matchId: params.matchId,
      winnerId: null,
      resultVersion: Date.now(),
      completed: false,
    };
  }
  // Renew the lock across the full finalization (settlement, XP, objectives,
  // avg-times, Redis, emits) so a slow >TTL run can't expire it and let a second
  // worker re-finalize.
  const heartbeat = startLockHeartbeat(lockKey, lock.token, lockTtlMs);

  try {
    const activeMatch = await matchesRepo.getMatch(params.matchId);
    if (!activeMatch || activeMatch.status !== 'active') {
      return {
        matchId: params.matchId,
        winnerId: null,
        resultVersion: Date.now(),
        completed: false,
      };
    }

    const variant = resolveMatchVariant(activeMatch.state_payload, activeMatch.mode);
    const roster = await matchPlayersRepo.listMatchPlayers(params.matchId);
    const winnerId =
      variant === 'friendly_party_quiz'
        ? buildStandings(
            roster.filter((player) => player.user_id !== params.forfeitingUserId)
          )[0]?.userId ?? null
        : roster.find((player) => player.user_id !== params.forfeitingUserId)?.user_id ?? null;

    if (params.cacheSnapshot && params.cacheSnapshot.status === 'active' && variant !== 'friendly_party_quiz') {
      await matchesRepo.setMatchStatePayload(
        params.matchId,
        params.cacheSnapshot.statePayload,
        params.cacheSnapshot.currentQIndex
      );
      await Promise.all(
        params.cacheSnapshot.players.map((player) =>
          matchPlayersRepo.setPlayerFinalTotals(params.matchId, player.userId, {
            totalPoints: player.totalPoints,
            correctAnswers: player.correctAnswers,
            goals: player.goals,
            penaltyGoals: player.penaltyGoals,
          })
        )
      );
    }

    const currentPayload = (
      params.cacheSnapshot?.statePayload ?? activeMatch.state_payload ?? {}
    ) as Record<string, unknown>;

    // Ranked early forfeit / disconnect: if too few rounds have been played,
    // cancel the match as a no-contest — abandon it (no winner, no RP), and
    // refund both human players' consumed ranked tickets. This prevents a
    // network drop in the first round or two from costing RP + a ticket.
    const roundsPlayed = params.cacheSnapshot?.currentQIndex ?? activeMatch.current_q_index;
    const isRankedEarlyForfeit =
      activeMatch.mode === 'ranked'
      && variant !== 'friendly_party_quiz'
      && roundsPlayed < RANKED_EARLY_FORFEIT_MIN_ROUNDS;

    if (isRankedEarlyForfeit) {
      // Bump the forfeiter's rolling 24h early-forfeit counter. Beyond the
      // free limit, the forfeiter is penalized: no ticket refund and a direct
      // 100 RP deduction. The opponent (victim) always gets their ticket back.
      // The refund suppression only takes effect if the RP deduction actually
      // committed — if the penalty call throws or the user has no ranked
      // profile, the forfeiter still gets their ticket refunded (safe default).
      let penaltyApplied = false;
      let earlyForfeitCount = 0;
      try {
        earlyForfeitCount = await usersRepo.bumpEarlyForfeitCount(params.forfeitingUserId);
      } catch (error) {
        logger.warn(
          { error, matchId: params.matchId, forfeitingUserId: params.forfeitingUserId },
          'Failed to bump early-forfeit counter — treating as non-penalized fallback'
        );
      }

      if (earlyForfeitCount > EARLY_FORFEIT_FREE_LIMIT) {
        try {
          const rpResult = await rankedRepo.applyEarlyForfeitRpPenalty(
            params.forfeitingUserId,
            params.matchId,
            EARLY_FORFEIT_PENALTY_RP
          );
          // rpResult is null when the user has no ranked profile — in that case
          // there's nothing to deduct, so don't suppress the ticket refund.
          penaltyApplied = rpResult != null;
          if (penaltyApplied) {
            logger.info(
              {
                matchId: params.matchId,
                forfeitingUserId: params.forfeitingUserId,
                earlyForfeitCount,
                oldRp: rpResult!.oldRp,
                newRp: rpResult!.newRp,
                penaltyRp: EARLY_FORFEIT_PENALTY_RP,
              },
              'Early-forfeit RP penalty applied (serial early-forfeit abuse)'
            );
          } else {
            logger.warn(
              { matchId: params.matchId, forfeitingUserId: params.forfeitingUserId, earlyForfeitCount },
              'Early-forfeit penalty skipped (no ranked profile) — ticket still refunded'
            );
          }
        } catch (error) {
          logger.warn(
            { error, matchId: params.matchId, forfeitingUserId: params.forfeitingUserId },
            'Failed to apply early-forfeit RP penalty — ticket still refunded'
          );
        }
      }

      // Refund the ranked ticket to every human participant EXCEPT the
      // penalized forfeiter (best-effort). The opponent always gets refunded.
      const resultVersion = await finalizeRankedNoContest({
        matchId: params.matchId,
        roster,
        statePayload: currentPayload,
        roundsPlayed,
        cleanupRedisKeys: params.cleanupRedisKeys,
        suppressRefundUserIds: penaltyApplied ? [params.forfeitingUserId] : [],
      });

      logger.info(
        {
          matchId: params.matchId,
          roundsPlayed,
          forfeitingUserId: params.forfeitingUserId,
          penaltyApplied,
          earlyForfeitCount,
        },
        penaltyApplied
          ? 'Ranked match cancelled as no-contest (early forfeit) — forfeiter penalized, opponent ticket refunded'
          : 'Ranked match cancelled as no-contest (early forfeit) — RP unchanged, tickets refunded'
      );

      return {
        matchId: params.matchId,
        winnerId: null,
        resultVersion,
        completed: true,
        cancelledNoContest: true,
      };
    }

    await matchesRepo.setMatchStatePayload(params.matchId, {
      ...currentPayload,
      winnerDecisionMethod: 'forfeit',
    });

    await matchesService.completeMatch(params.matchId, winnerId);
    await deleteMatchCache(params.matchId);

    if (activeMatch.mode === 'ranked') {
      try {
        await rankedService.settleCompletedRankedMatch(params.matchId);
      } catch (error) {
        logger.warn({ error, matchId: params.matchId }, 'Ranked settlement failed during forfeit finalization');
      }
    }

    try {
      await progressionService.awardCompletedMatchXp(params.matchId);
    } catch (error) {
      logger.warn({ error, matchId: params.matchId }, 'Match XP award failed during forfeit finalization');
    }

    try {
      await objectivesService.evaluateForMatchBestEffort(params.matchId);
    } catch (error) {
      logger.warn({ error, matchId: params.matchId }, 'Objectives evaluation failed during forfeit finalization');
    }

    const avgTimes = await matchesService.computeAvgTimes(params.matchId);
    await Promise.all(
      roster.map((player) =>
        matchPlayersRepo.updatePlayerAvgTime(
          params.matchId,
          player.user_id,
          avgTimes.get(player.user_id) ?? null
        )
      )
    );

    const resultVersion = Date.now();
    const redis = getRedisClient();
    if (redis) {
      const cleanupKeys = params.cleanupRedisKeys?.filter(Boolean) ?? [];
      if (cleanupKeys.length > 0) {
        await redis.del(cleanupKeys);
      }
      await redis.set(matchForfeitKey(params.matchId), winnerId ?? 'draw', {
        EX: FORFEIT_REPLAY_TTL_SEC,
      });
      await Promise.all(
        roster.map((player) =>
          redis.set(
            lastMatchKey(player.user_id),
            JSON.stringify({ matchId: params.matchId, resultVersion }),
            { EX: FORFEIT_REPLAY_TTL_SEC }
          )
        )
      );
    }

    return {
      matchId: params.matchId,
      winnerId,
      resultVersion,
      completed: true,
    };
  } finally {
    heartbeat.stop();
    await releaseLock(lockKey, lock.token);
  }
}

// ─── Realtime adapters ────────────────────────────────────────────────────
// Socket-bound entrypoints that wrap finalizeMatchAsForfeit with the
// transition-lock, cleanup, and emit choreography.

export async function handleMatchForfeit(
  io: QuizballServer,
  socket: QuizballSocket,
  requestedMatchId: string | null
): Promise<void> {
  const userId = socket.data.user.id;
  const completed = await userSessionGuardService.runWithUserTransitionLock(
    io,
    socket,
    async () => {
      const activeMatch =
        (requestedMatchId ? await matchesRepo.getMatch(requestedMatchId) : null) ??
        (socket.data.matchId ? await matchesRepo.getMatch(socket.data.matchId) : null) ??
        (await matchesRepo.getActiveMatchForUser(userId));

      if (!activeMatch || activeMatch.status !== 'active') {
        socket.emit('error', {
          code: 'MATCH_NOT_ACTIVE',
          message: 'No active match to forfeit',
        });
        return;
      }

      const { participants: roster, cache } = await getParticipantSnapshot(activeMatch.id);
      const variant = resolveMatchVariant(activeMatch.state_payload, activeMatch.mode);
      const isParticipant = roster.some((player) => player.user_id === userId);
      if (!isParticipant) {
        socket.emit('error', {
          code: 'MATCH_NOT_ALLOWED',
          message: 'You are not a participant in this match',
        });
        return;
      }

      if (variant !== 'friendly_party_quiz') {
        const disconnectedOpponentId = await findOpponentInDisconnectGrace(
          activeMatch.id,
          userId,
          roster
        );
        if (disconnectedOpponentId) {
          await markExcusedExitPending({
            matchId: activeMatch.id,
            userId,
            opponentId: disconnectedOpponentId,
            source: 'match_forfeit',
          });
          socket.leave(`match:${activeMatch.id}`);
          socket.data.matchId = undefined;
          return;
        }
      }

      if (variant !== 'friendly_party_quiz') {
        cancelMatchQuestionTimer(activeMatch.id, activeMatch.current_q_index);
        cancelPossessionHalftimeTimer(activeMatch.id);
      }
      if (variant === 'friendly_party_quiz') {
        const redis = getRedisClient();
        const pauseStartedRaw = redis ? await redis.get(matchPauseKey(activeMatch.id)) : null;
        const pauseStartedAtMs = Number(pauseStartedRaw);
        const players = await matchPlayersRepo.listMatchPlayers(activeMatch.id);
        logger.info(
          {
            eventName: 'match:forfeit',
            matchId: activeMatch.id,
            userId,
            variant,
            playerCount: players.length,
            pauseStartedAtMs: Number.isFinite(pauseStartedAtMs) ? pauseStartedAtMs : null,
          },
          'Party quiz forfeit requested'
        );
        await applyPartyQuizDropouts({
          io,
          match: activeMatch,
          players,
          droppedUserIds: [userId],
          reason: 'self_forfeit',
          resumeIfContinuing: true,
          pauseStartedAtMs: Number.isFinite(pauseStartedAtMs) ? pauseStartedAtMs : Date.now(),
        });
        socket.leave(`match:${activeMatch.id}`);
        socket.data.matchId = undefined;
        return;
      }
      const cleanupKeys = [
        matchPauseKey(activeMatch.id),
        matchGraceKey(activeMatch.id),
        ...roster.flatMap((player) => [
          matchDisconnectKey(activeMatch.id, player.user_id),
          matchExitPendingKey(activeMatch.id, player.user_id),
          matchPresenceKey(activeMatch.id, player.user_id),
          matchReconnectCountKey(activeMatch.id, player.user_id),
        ]),
        rankedAiMatchKey(activeMatch.id),
      ];
      const opponentPendingPayload = buildOpponentForfeitPendingPayload(activeMatch.id, 'opponent_forfeit');
      for (const player of roster) {
        if (player.user_id === userId) continue;
        io.to(`user:${player.user_id}`).emit('match:forfeit_pending', opponentPendingPayload);
      }
      const finalized = await finalizeMatchAsForfeit({
        matchId: activeMatch.id,
        forfeitingUserId: userId,
        activeMatch,
        cacheSnapshot: cache,
        cleanupRedisKeys: cleanupKeys,
      });
      const resultVersion = finalized.resultVersion;
      const finalPayload = await buildFinalResultsPayload(activeMatch.id, resultVersion);
      if (finalPayload) {
        await emitFinalResultsToMatchParticipants(io, activeMatch.id, finalPayload);
      }

      const redis = getRedisClient();
      if (redis) {
        await redis.del(cleanupKeys);
      }

      socket.leave(`match:${activeMatch.id}`);
      socket.data.matchId = undefined;
    },
    {
      code: 'TRANSITION_IN_PROGRESS',
      message: 'Match transition is in progress. Please retry.',
      operation: 'match:forfeit',
    }
  );
  if (!completed) return;

  await userSessionGuardService.emitState(io, userId);
}

export async function emitPendingForfeitIfAny(socket: QuizballSocket): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;

  const userId = socket.data.user.id;
  const raw = await redis.get(matchForfeitPendingUserKey(userId));
  if (!raw) return;
  const payload = parseForfeitPendingPayload(raw);
  if (!payload) {
    await redis.del(matchForfeitPendingUserKey(userId));
    return;
  }
  const evidence = await resolveMatchReplayEvidence(payload.matchId, userId);
  if (!evidence.allowed) {
    logger.warn(
      {
        userId,
        matchId: payload.matchId,
        reason: payload.reason,
        isParticipant: evidence.isParticipant,
        hasEnteredMarker: evidence.hasEnteredMarker,
        hasRecordedActivity: evidence.hasRecordedActivity,
      },
      'Suppressing pending forfeit replay for user without entered-match evidence'
    );
    await redis.del(matchForfeitPendingUserKey(userId));
    return;
  }
  socket.emit('match:forfeit_pending', payload);
}
