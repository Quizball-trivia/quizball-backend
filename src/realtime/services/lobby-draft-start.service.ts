import type { QuizballServer } from '../socket-server.js';
import { lobbiesRepo } from '../../modules/lobbies/lobbies.repo.js';
import { lobbiesService } from '../../modules/lobbies/lobbies.service.js';
import { MIN_QUESTIONS_PER_CATEGORY } from '../../modules/lobbies/lobbies.constants.js';
import { getRedisClient } from '../redis.js';
import { acquireLock, releaseLock } from '../locks.js';
import { logger } from '../../core/logger.js';
import { isDbWriteOutage, DbWriteOutageDeferral } from '../../db/readonly-breaker.js';
import { rankedAiLobbyKey } from '../ai-ranked.constants.js';
import { reservationService } from '../../modules/synthetic-bots/reservation.service.js';
import { syntheticBotsRepo } from '../../modules/synthetic-bots/synthetic-bots.repo.js';
import { emitLobbyState } from '../lobby-utils.js';
import { warmupRealtimeService } from './warmup-realtime.service.js';
import { userSessionGuardService } from './user-session-guard.service.js';
import { withSpan } from '../../core/tracing.js';
import { trackDraftStarted } from '../../core/analytics/game-events.js';
import {
  detachAllSocketsFromLobby,
  emitClosedLobbyStateForMode,
  resolveRankedAiUserIdForDraft,
} from './lobby-lifecycle.helpers.js';

const DRAFT_START_GUARD_PREFIX = 'draft:starting:';
const DRAFT_START_GUARD_TTL_SEC = 15;

// Fallback guard when Redis is unavailable (single instance only).
// Lives co-located with the only two consumers below so the Set is
// guaranteed to be a single module instance.
const draftStartingSet = new Set<string>();

export async function tryAcquireDraftStartGuard(lobbyId: string): Promise<boolean> {
  const redis = getRedisClient();
  if (redis) {
    const key = `${DRAFT_START_GUARD_PREFIX}${lobbyId}`;
    const result = await redis.set(key, '1', { NX: true, EX: DRAFT_START_GUARD_TTL_SEC });
    return result === 'OK';
  }

  if (draftStartingSet.has(lobbyId)) return false;
  draftStartingSet.add(lobbyId);
  return true;
}

export async function releaseDraftStartGuard(lobbyId: string): Promise<void> {
  const redis = getRedisClient();
  if (redis) {
    await redis.del(`${DRAFT_START_GUARD_PREFIX}${lobbyId}`);
  }
  draftStartingSet.delete(lobbyId);
}

export async function abortRankedDraftStartForTickets(
  io: QuizballServer,
  lobby: { id: string; mode: 'friendly' | 'ranked' },
  humanUserIds: string[]
): Promise<void> {
  // Ticket failure fires POST-activation (committed_at is set), so it must be
  // able to reclaim a genuinely-stuck draft → teardown-intent. The AUTHORITATIVE
  // in-lock live-match check inside the locked abort decides: if a reconnect
  // activated + created a match first, the abort no-ops (the live match keeps the
  // bot); if the draft is truly stuck (no match), it reclaims + tears down.
  await reservationService.abortLobby(lobby.id, 'abort_start_for_tickets', { draftTeardown: true });
  await warmupRealtimeService.cleanupLobby(lobby.id);
  const redis = getRedisClient();
  if (redis) {
    await redis.del(rankedAiLobbyKey(lobby.id));
  }
  await emitClosedLobbyStateForMode(io, lobby.id, lobby.mode);
  await detachAllSocketsFromLobby(io, lobby.id);

  for (const userId of humanUserIds) {
    io.to(`user:${userId}`).emit('ranked:queue_left');
    io.to(`user:${userId}`).emit('error', {
      code: 'INSUFFICIENT_TICKETS',
      message: 'A player does not have enough tickets to start ranked.',
      meta: {
        lobbyId: lobby.id,
        source: 'ranked_ticket_check',
      },
    });
    await userSessionGuardService.emitState(io, userId);
  }

  logger.info({ lobbyId: lobby.id, humanUserIds }, 'Ranked draft start aborted: insufficient tickets');
}

/**
 * Discriminated outcome so callers that own a user-facing flow (ranked AI
 * callbacks) can distinguish a silent no-op from a started draft. All previous
 * callers ignored the void return, so widening the type is non-breaking.
 */
export type DraftStartResult = 'started' | 'lobby_missing' | 'lock_busy' | 'already_active' | 'insufficient_categories';

export async function startDraft(
  io: QuizballServer,
  lobbyId: string,
  options?: {
    /**
     * Enforce (under the lobby lock) that the lobby is still 'waiting' before
     * starting. Queue-flow callers (ranked-AI lock-busy retry) set this so a
     * competitor's just-committed draft is never double-started. Recovery
     * callers must NOT set it — the post-failure draft restart legitimately
     * runs on an already-active lobby (draft-realtime match-creation failure).
     */
    expectWaiting?: boolean;
  }
): Promise<DraftStartResult> {
  return withSpan('lobby.start_draft', {
    'quizball.lobby_id': lobbyId,
  }, async (span): Promise<DraftStartResult> => {
    // A draft started during a write outage cannot persist its questions or its
    // match. THROW rather than return: when this runs from the durable timer a
    // clean return would mark the timer handled and delete its payload, leaving
    // a committed lobby waiting forever for a draft that never restarts. The
    // deferral is rethrown by runRankedDraftStart so the scheduler re-arms it.
    if (isDbWriteOutage()) {
      span.setAttribute('quizball.db_write_outage', true);
      logger.error({ lobbyId }, 'Draft start deferred: database write outage in progress');
      throw new DbWriteOutageDeferral(`draft start for lobby ${lobbyId}`);
    }

    const lobby = await lobbiesRepo.getById(lobbyId);
    if (!lobby) {
      span.setAttribute('quizball.lobby_found', false);
      return 'lobby_missing';
    }
    span.setAttribute('quizball.lobby_found', true);
    span.setAttribute('quizball.lobby_mode', lobby.mode);

    const lockKey = `lock:lobby:${lobbyId}`;
    const lock = await acquireLock(lockKey, 3000);
    if (!lock.acquired || !lock.token) {
      span.setAttribute('quizball.lock_acquired', false);
      logger.warn({ lobbyId }, 'Draft start skipped: lobby lock not acquired');
      return 'lock_busy';
    }

    span.setAttribute('quizball.lock_acquired', true);
    try {
      // Authoritative status check UNDER the lock (opt-in): a competitor that
      // held the lock a moment ago may have activated (or deleted) this lobby
      // between our pre-lock read and acquisition. Without this, a retrying
      // queue-flow caller could replace the categories of a live draft and
      // emit a second draft:start.
      if (options?.expectWaiting) {
        const lockedLobby = await lobbiesRepo.getById(lobbyId);
        if (!lockedLobby) {
          span.setAttribute('quizball.lobby_found', false);
          return 'lobby_missing';
        }
        if (lockedLobby.status !== 'waiting') {
          span.setAttribute('quizball.lobby_status', lockedLobby.status);
          logger.info({ lobbyId, status: lockedLobby.status }, 'Draft start skipped: lobby already advanced');
          return 'already_active';
        }
      }

      let rankedMembers: Awaited<ReturnType<typeof lobbiesRepo.listMembersWithUser>> | null = null;
      let rankedAiUserId: string | null = null;

      // Members are needed BEFORE category selection for ranked: the draft
      // candidates avoid categories the human players recently played (AI
      // opponents never have recents recorded, so excluding the AI user id
      // also keeps the lookup minimal for bot matches).
      let recentFilterApplied = false;
      let categories;
      if (lobby.mode === 'ranked') {
        rankedMembers = await lobbiesRepo.listMembersWithUser(lobbyId);
        rankedAiUserId = await resolveRankedAiUserIdForDraft(lobbyId, rankedMembers);
        const humanUserIds = rankedMembers
          .filter((member) => member.user_id !== rankedAiUserId)
          .map((member) => member.user_id);
        const selection = await lobbiesService.selectRankedCategoriesForDraft({
          count: 3,
          userIds: humanUserIds,
        });
        categories = selection.categories;
        recentFilterApplied = selection.recentFilterApplied;
      } else {
        categories = await lobbiesService.selectRandomCategories(3, MIN_QUESTIONS_PER_CATEGORY, 'possession');
      }
      span.setAttribute('quizball.category_count', categories.length);
      span.setAttribute('quizball.recent_filter_applied', recentFilterApplied);
      if (categories.length < 3) {
        logger.warn(
          { lobbyId, categoryCount: categories.length },
          'Draft start failed: insufficient categories with questions'
        );
        await lobbiesRepo.setAllReady(lobbyId, false);
        await emitLobbyState(io, lobbyId);
        io.to(`lobby:${lobbyId}`).emit('error', {
          code: 'INSUFFICIENT_CATEGORIES',
          message: 'Not enough categories with questions to start the game',
        });
        return 'insufficient_categories';
      }

      // Flip to 'active' under the shared per-lobby advisory lock so this
      // waiting→active transition serializes with any concurrent persistent-bot
      // reservation ABORT (which takes the same lock). This closes the
      // abort-vs-activate TOCTOU: an aborter either ran first (freed the bot →
      // the later reservation transfer finds nothing → match creation rolls back)
      // or blocks behind us and observes 'active' → no-ops.
      //
      // expectWaiting: PROVE ownership via the waiting→active CAS BEFORE any
      // category write — a lost CAS must leave the winner's draft state
      // untouched. Runs after selection (read-only) so insufficient_categories
      // still exits with the lobby waiting. A post-CAS write failure throws
      // into caller teardown paths that already handle an activated lobby.
      // The bare (recovery) path keeps writes-then-unconditional-activate.
      if (options?.expectWaiting) {
        const activation = await syntheticBotsRepo.activateLobbyForDraftLocked(lobbyId, {
          requireWaiting: true,
        });
        if (!activation.activated) {
          // Atomic CAS lost: a competitor whose Redis lease outlived its 3s TTL
          // activated between our under-lock status read and here. It owns the
          // draft; a second draft:start (or a category rewrite) would corrupt it.
          logger.info({ lobbyId }, 'Draft start skipped: activation CAS lost to a concurrent starter');
          return 'already_active';
        }
      }

      await lobbiesRepo.clearLobbyCategoryBans(lobbyId);
      await lobbiesRepo.clearLobbyCategories(lobbyId);
      await lobbiesRepo.insertLobbyCategories(
        lobbyId,
        categories.map((category, index) => ({
          slot: index + 1,
          categoryId: category.id,
        }))
      );
      if (!options?.expectWaiting) {
        await syntheticBotsRepo.activateLobbyForDraftLocked(lobbyId, { requireWaiting: false });
      }
      await warmupRealtimeService.cleanupLobby(lobbyId);

      let turnUserId = lobby.host_user_id;
      if (lobby.mode === 'ranked') {
        const members = rankedMembers ?? await lobbiesRepo.listMembersWithUser(lobbyId);
        const aiUserId = rankedAiUserId ?? await resolveRankedAiUserIdForDraft(lobbyId, members);
        if (aiUserId) {
          turnUserId =
            members.find((member) => member.user_id !== aiUserId)?.user_id ?? lobby.host_user_id;
        }
      }

      span.setAttribute('quizball.turn_user_id', turnUserId);
      io.to(`lobby:${lobbyId}`).emit('draft:start', {
        lobbyId,
        categories,
        turnUserId,
        // Info for the client: candidates were chosen with recent-category
        // filtering (no client-side filtering — display as-is).
        recentFilterApplied,
      });

      // Analytics: per-member draft_started event.
      try {
        const draftMembers = rankedMembers ?? await lobbiesRepo.listMembersWithUser(lobbyId);
        for (const member of draftMembers) {
          trackDraftStarted({ userId: member.user_id, lobbyId, mode: lobby.mode });
        }
      } catch (err) {
        logger.warn({ err, lobbyId }, 'draft_started analytics failed');
      }
      void import('./draft-realtime.service.js')
        .then(({ scheduleDraftAutoBanForCurrentTurn }) => scheduleDraftAutoBanForCurrentTurn(io, lobbyId))
        .catch((error) => {
          logger.warn({ error, lobbyId }, 'Failed to schedule automatic draft ban fallback');
        });
      logger.debug(
        {
          lobbyId,
          hostUserId: lobby.host_user_id,
          turnUserId,
          categoryCount: categories.length,
          recentFilterApplied,
        },
        'Draft started'
      );
      return 'started';
    } finally {
      await releaseLock(lockKey, lock.token);
    }
  });
}
