import type { QuizballServer } from '../socket-server.js';
import { lobbiesRepo } from '../../modules/lobbies/lobbies.repo.js';
import { lobbiesService } from '../../modules/lobbies/lobbies.service.js';
import { getRedisClient } from '../redis.js';
import { acquireLock, releaseLock } from '../locks.js';
import { logger } from '../../core/logger.js';
import { rankedAiLobbyKey } from '../ai-ranked.constants.js';
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
  await lobbiesRepo.deleteLobby(lobby.id);
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

export async function startDraft(io: QuizballServer, lobbyId: string): Promise<void> {
  await withSpan('lobby.start_draft', {
    'quizball.lobby_id': lobbyId,
  }, async (span) => {
    const lobby = await lobbiesRepo.getById(lobbyId);
    if (!lobby) {
      span.setAttribute('quizball.lobby_found', false);
      return;
    }
    span.setAttribute('quizball.lobby_found', true);
    span.setAttribute('quizball.lobby_mode', lobby.mode);

    const lockKey = `lock:lobby:${lobbyId}`;
    const lock = await acquireLock(lockKey, 3000);
    if (!lock.acquired || !lock.token) {
      span.setAttribute('quizball.lock_acquired', false);
      logger.warn({ lobbyId }, 'Draft start skipped: lobby lock not acquired');
      return;
    }

    span.setAttribute('quizball.lock_acquired', true);
    try {
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
        categories = await lobbiesService.selectRandomCategories(3);
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
        return;
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
      await lobbiesRepo.setLobbyStatus(lobbyId, 'active');
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
      const forceAtMs = Date.now() + 45_000;
      io.to(`lobby:${lobbyId}`).emit('draft:start', {
        lobbyId,
        categories,
        turnUserId,
        forceAtMs,
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
        .then(async ({ isDraftPlayerMarkedDisconnected, pauseDraftForDisconnectedPlayerAtStart, scheduleDraftAutoBanForCurrentTurn }) => {
          const draftMembers = rankedMembers ?? await lobbiesRepo.listMembersWithUser(lobbyId);
          const disconnectedMember = (await Promise.all(
            draftMembers.map(async (member) => ({
              userId: member.user_id,
              disconnected: await isDraftPlayerMarkedDisconnected(lobbyId, member.user_id),
            }))
          )).find((member) => member.disconnected);
          if (disconnectedMember) {
            await pauseDraftForDisconnectedPlayerAtStart(io, lobbyId, disconnectedMember.userId);
            return;
          }
          await scheduleDraftAutoBanForCurrentTurn(io, lobbyId, { forceAtMs });
        })
        .catch((error) => {
          logger.warn({ error, lobbyId }, 'Failed to schedule automatic draft ban fallback');
        });
      logger.info(
        {
          lobbyId,
          hostUserId: lobby.host_user_id,
          turnUserId,
          categoryCount: categories.length,
          recentFilterApplied,
        },
        'Draft started'
      );
    } finally {
      await releaseLock(lockKey, lock.token);
    }
  });
}
