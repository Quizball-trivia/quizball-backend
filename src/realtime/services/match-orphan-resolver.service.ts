import type { QuizballServer } from '../socket-server.js';
import { logger } from '../../core/logger.js';
import type { MatchRow } from '../../modules/matches/matches.types.js';
import { resolveMatchVariant } from '../../modules/matches/matches.service.js';
import { usersRepo } from '../../modules/users/users.repo.js';
import { storeService } from '../../modules/store/store.service.js';
import { rankedAiMatchKey } from '../ai-ranked.constants.js';
import { completePossessionMatchFromProgress } from '../possession-completion.js';
import { getRedisClient } from '../redis.js';
import {
  matchDisconnectKey,
  matchGraceKey,
  matchPauseKey,
  matchPresenceKey,
  matchReconnectCountKey,
  matchResumeCountdownKey,
} from '../match-keys.js';
import {
  buildFinalResultsPayload,
  emitFinalResultsToMatchParticipants,
} from './match-final-results.service.js';
import {
  finalizeMatchAsForfeit,
  isRankedEarlyForfeitMatch,
} from './match-forfeit.service.js';
import { canForfeitToPresentPlayers, resolveMatchPresence } from './match-presence.service.js';
import { abandonMatchWithCompleteLock } from './match-terminal.service.js';

type OrphanRosterPlayer = { user_id: string };

export type OrphanTerminalResolution =
  | { outcome: 'forfeited'; forfeitingUserId: string; winnerId: string | null }
  | { outcome: 'completed_from_progress'; winnerId: string | null; decisionBasis?: string }
  | { outcome: 'abandoned' }
  | { outcome: 'skipped'; reason: 'forfeit_not_finalized' | 'progress_lock_or_inactive' | 'abandon_lock_or_inactive' };

export function orphanMatchCleanupKeys(matchId: string, userIds: string[]): string[] {
  return [
    matchPauseKey(matchId),
    matchGraceKey(matchId),
    matchResumeCountdownKey(matchId),
    rankedAiMatchKey(matchId),
    ...userIds.flatMap((userId) => [
      matchDisconnectKey(matchId, userId),
      matchPresenceKey(matchId, userId),
      matchReconnectCountKey(matchId, userId),
    ]),
  ];
}

async function cleanupOrphanMatchRedisKeys(matchId: string, userIds: string[]): Promise<void> {
  const redis = getRedisClient();
  if (!redis || !redis.isOpen) return;
  await redis.del(orphanMatchCleanupKeys(matchId, userIds)).catch((error) => {
    logger.warn({ error, matchId }, 'Orphan match Redis cleanup failed');
  });
}

/**
 * Shared terminal resolution for orphaned 1v1 possession matches (stale-match
 * sweeper + user-session guard).
 *
 * FORFEIT-FIRST, mirroring the live disconnect path (#72): if presence can
 * isolate exactly one absent player with a present counterpart, the absent
 * player loses by forfeit — no matter what the score says. Previously both
 * safety nets tried progress-based completion FIRST, so a disconnector ahead
 * on points could still be handed the win whenever the durable grace timer was
 * lost and one of these nets resolved the match instead.
 *
 * Order: presence → forfeit; else progress completion; else abandon.
 * Every path re-checks `status='active'` under the shared completion lock and
 * is idempotent; `skipped` outcomes mean "leave it, a retry will happen".
 */
export async function resolveOrphanPossessionMatchTerminal(params: {
  io: QuizballServer;
  match: MatchRow;
  roster: OrphanRosterPlayer[];
  source: string;
  connectingUserId?: string | null;
}): Promise<OrphanTerminalResolution> {
  const { io, match, roster, source, connectingUserId } = params;
  const userIds = roster.map((player) => player.user_id);

  const presence = await resolveMatchPresence(io, match.id, roster, {
    staleCleanup: true,
    // A live socket in user:<id> (e.g. a token-refresh reconnect that never
    // re-entered the match room) proves the player is online — they must be
    // credited the forfeit win, not dragged into the progress tiebreak.
    includeUserRoomSockets: true,
    ...(connectingUserId ? { connectingUserId } : {}),
  });

  // Same guard as the live disconnect path: an AI-only "present" set must not
  // receive a normal forfeit win. Inside the ranked <2-round window, route the
  // absent human through the shared finalizer so it cancels as a no-contest;
  // later matches still fall through to progress and preserve the earned score.
  const canAwardForfeitWin = canForfeitToPresentPlayers(presence);
  const shouldFinalizeEarlyNoContest =
    !canAwardForfeitWin
    && presence.presentPlayers.length > 0
    && isRankedEarlyForfeitMatch(match);
  if (
    (canAwardForfeitWin || shouldFinalizeEarlyNoContest) &&
    presence.absentPlayers.length === 1 &&
    presence.presentPlayers.length > 0
  ) {
    const forfeitingUserId = presence.absentPlayers[0]?.user_id;
    if (forfeitingUserId) {
      const finalized = await finalizeMatchAsForfeit({
        matchId: match.id,
        forfeitingUserId,
        activeMatch: match,
        cleanupRedisKeys: orphanMatchCleanupKeys(match.id, userIds),
      });
      if (!finalized.completed) {
        // Lock contention or already resolved — leave it for the next pass.
        return { outcome: 'skipped', reason: 'forfeit_not_finalized' };
      }
      const finalPayload = await buildFinalResultsPayload(match.id, finalized.resultVersion);
      if (finalPayload) {
        await emitFinalResultsToMatchParticipants(io, match.id, finalPayload);
      }
      if (finalized.cancelledNoContest) {
        logger.info(
          { matchId: match.id, mode: match.mode, source, forfeitingUserId },
          'Orphan resolver cancelled early AI match as no-contest'
        );
        return { outcome: 'abandoned' };
      }
      logger.info(
        {
          matchId: match.id,
          mode: match.mode,
          source,
          forfeitingUserId,
          winnerId: finalized.winnerId,
          presentUserIds: presence.presentPlayers.map((player) => player.user_id),
        },
        'Orphan resolver forfeited absent player'
      );
      return { outcome: 'forfeited', forfeitingUserId, winnerId: finalized.winnerId };
    }
  }

  const progressResult = await completePossessionMatchFromProgress(io, match.id, source);
  if (progressResult.completed) {
    await cleanupOrphanMatchRedisKeys(match.id, userIds);
    logger.info(
      {
        matchId: match.id,
        mode: match.mode,
        source,
        winnerId: progressResult.winnerId,
        decisionBasis: progressResult.decisionBasis,
      },
      'Orphan resolver completed match from existing progress'
    );
    return {
      outcome: 'completed_from_progress',
      winnerId: progressResult.winnerId,
      decisionBasis: progressResult.decisionBasis,
    };
  }
  if (progressResult.reason === 'lock_not_acquired' || progressResult.reason === 'not_active') {
    return { outcome: 'skipped', reason: 'progress_lock_or_inactive' };
  }

  const abandoned = await abandonMatchWithCompleteLock(match.id);
  if (!abandoned.abandoned) {
    return { outcome: 'skipped', reason: 'abandon_lock_or_inactive' };
  }

  // A ranked no-contest abandon must refund every human's consumed ranked ticket,
  // mirroring the live disconnect path (abandonPossessionTerminalMatch). Without
  // this, an orphan/stale abandon — now also reachable when the AI-forfeit guard
  // routes an AI-only-present match here and progress is undecidable — silently
  // costs the human a ticket. Best-effort; party-quiz uses its own flow.
  const variant = resolveMatchVariant(match.state_payload, match.mode);
  if (match.mode === 'ranked' && variant !== 'friendly_party_quiz') {
    // Best-effort over the WHOLE refund computation: the match is already
    // abandoned above, so a throw in usersRepo.getByIds must not skip the Redis
    // cleanup / return below. Wrap the lookup too, not just the refund call.
    let humanUserIds: string[] = [];
    try {
      const rosterUsers = await usersRepo.getByIds(userIds);
      // Only refund ids that resolved to an explicitly human row — never assume a
      // missing/deleted id is human (no ghost refunds).
      humanUserIds = roster
        .map((player) => rosterUsers.get(player.user_id))
        .filter((user): user is NonNullable<typeof user> => user != null && user.is_ai === false)
        .map((user) => user.id);
      if (humanUserIds.length > 0) {
        await storeService.refundRankedTickets(humanUserIds);
      }
    } catch (error) {
      logger.warn(
        { error, matchId: match.id, humanUserIds },
        'Failed to refund ranked tickets on orphan no-contest abandon'
      );
    }
  }

  await cleanupOrphanMatchRedisKeys(match.id, userIds);
  logger.info(
    {
      matchId: match.id,
      mode: match.mode,
      source,
      rosterSize: roster.length,
      absentUserIds: presence.absentPlayers.map((player) => player.user_id),
      presentUserIds: presence.presentPlayers.map((player) => player.user_id),
    },
    'Orphan resolver abandoned match (no clear absent loser, progress undecidable)'
  );
  return { outcome: 'abandoned' };
}
