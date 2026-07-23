import type { QuizballServer, QuizballSocket } from '../socket-server.js';
import { lobbiesRepo } from '../../modules/lobbies/lobbies.repo.js';
import { lobbiesService } from '../../modules/lobbies/lobbies.service.js';
import { getRedisClient } from '../redis.js';
import { logger } from '../../core/logger.js';
import { rankedAiLobbyKey } from '../ai-ranked.constants.js';
import {
  attachUserSocketsToLobby,
  emitLobbyState,
  syncFriendlyLobbyModeForMemberCount,
} from '../lobby-utils.js';
import { userSessionGuardService } from './user-session-guard.service.js';
import {
  autoLeaveAllWaitingLobbies,
  closeLobbyIfEmpty,
  getFirstDraftActorId,
  getNextDraftActorId,
  getRankedAiUserIdForLobby,
  isRankedAiLobby,
  resolveRankedAiUserIdForDraft,
  transferHostIfNeeded,
} from './lobby-lifecycle.helpers.js';
import { startDraft } from './lobby-draft-start.service.js';
import { socketDbTaskLimiter } from '../socket-db-task-limiter.js';

const LOBBY_DISCONNECT_GRACE_MS = 15000;
let delayedLobbyCleanupRejections = 0;

interface ActiveDraftRejoinOptions {
  resume?: boolean;
  lobbyId?: string;
}

export async function rejoinWaitingLobbyOnConnect(io: QuizballServer, socket: QuizballSocket): Promise<void> {
  const userId = socket.data.user.id;
  const openLobbies = await lobbiesRepo.listOpenLobbiesForUser(userId);
  const waitingLobbies = openLobbies.filter((lobby) => lobby.status === 'waiting');
  if (waitingLobbies.length === 0) return;

  const newestLobby = waitingLobbies[0];
  await autoLeaveAllWaitingLobbies(io, userId, newestLobby.id);

  await attachUserSocketsToLobby(io, userId, newestLobby.id);
  const state = await lobbiesService.buildLobbyState(newestLobby);
  socket.emit('lobby:state', state);
  await userSessionGuardService.emitState(io, userId);

  if (newestLobby.mode === 'ranked') {
    const members = await lobbiesRepo.listMembersWithUser(newestLobby.id);
    if (members.length === 2) {
      setTimeout(() => {
        void (async () => {
          const latest = await lobbiesRepo.getById(newestLobby.id);
          if (!latest || latest.status !== 'waiting' || latest.mode !== 'ranked') return;
          await startDraft(io, newestLobby.id);
        })().catch((error) => {
          logger.warn({ error, lobbyId: newestLobby.id }, 'Failed to recover ranked waiting lobby draft start');
        });
      }, 250);
    }
  }

  logger.info({ userId, lobbyId: newestLobby.id }, 'Socket rejoined waiting lobby');
}

export async function rejoinActiveDraftLobbyOnConnect(
  io: QuizballServer,
  socket: QuizballSocket,
  options: ActiveDraftRejoinOptions = {}
): Promise<void> {
  const userId = socket.data.user.id;
  const openLobbies = await lobbiesRepo.listOpenLobbiesForUser(userId);
  const activeLobbies = openLobbies.filter((lobby) =>
    lobby.status === 'active' &&
    (!options.lobbyId || lobby.id === options.lobbyId)
  );
  if (activeLobbies.length === 0) return;

  const newestLobby = activeLobbies[0];
  await attachUserSocketsToLobby(io, userId, newestLobby.id);
  const [state, categories, bans, members] = await Promise.all([
    lobbiesService.buildLobbyState(newestLobby),
    lobbiesService.getLobbyCategories(newestLobby.id),
    lobbiesRepo.listLobbyCategoryBans(newestLobby.id),
    lobbiesRepo.listMembersWithUser(newestLobby.id),
  ]);

  socket.emit('lobby:state', state);

  if (categories.length > 0 && members.length === 2) {
    const aiUserId = newestLobby.mode === 'ranked'
      ? await resolveRankedAiUserIdForDraft(newestLobby.id, members)
      : null;
    const firstActorUserId = getFirstDraftActorId(members, newestLobby.host_user_id, aiUserId);
    const turnUserId = getNextDraftActorId(members, bans, firstActorUserId);

    socket.emit('draft:start', {
      lobbyId: newestLobby.id,
      categories,
      turnUserId,
    });
    for (const ban of bans) {
      socket.emit('draft:banned', {
        actorId: ban.user_id,
        categoryId: ban.category_id,
      });
    }

    if (options.resume) {
      void import('./draft-realtime.service.js')
        .then(async ({ draftRealtimeService, resumeActiveDraftTimers }) => {
          await draftRealtimeService.resumeDraftForReconnectedPlayer(io, newestLobby.id, userId);
          await resumeActiveDraftTimers(io, newestLobby.id);
        })
        .catch((error) => {
          logger.warn({ error, lobbyId: newestLobby.id }, 'Failed to resume active draft timers on reconnect');
        });
    }
  }

  logger.info(
    { userId, lobbyId: newestLobby.id, categoryCount: categories.length, banCount: bans.length, resumed: Boolean(options.resume) },
    'Socket rejoined active draft lobby'
  );
}

export async function handleLobbyDisconnect(io: QuizballServer, socket: QuizballSocket): Promise<void> {
  const userId = socket.data.user.id;
  let lobbyId = socket.data.lobbyId;
  let resolvedFromDb = false;

  if (!lobbyId) {
    const openLobby = await lobbiesRepo.findOpenLobbyForUser(userId);
    lobbyId = openLobby?.id;
    if (!lobbyId) {
      logger.info({ userId }, 'Lobby disconnect: no lobby attached');
      return;
    }
    resolvedFromDb = true;
    logger.info({ userId, lobbyId, status: openLobby?.status ?? null }, 'Lobby disconnect: resolved lobby from DB');
  }

  const lobby = await lobbiesRepo.getById(lobbyId);
  if (!lobby) {
    return;
  }

  if (lobby.status === 'active') {
    // DB-fallback guard: this socket was never bound to the lobby
    // (socket.data.lobbyId was unset), so it may be an unrelated tab
    // (homepage etc.). If the user still has a live socket in the draft
    // room, this disconnect is irrelevant — do NOT pause/clear timers and
    // emit draft:opponent_disconnected for a draft that's still connected.
    if (resolvedFromDb) {
      const lobbySockets = await io.in(`lobby:${lobbyId}`).fetchSockets();
      const hasLiveLobbySocket = lobbySockets.some(
        (s) => s.id !== socket.id && s.data.user.id === userId
      );
      if (hasLiveLobbySocket) {
        logger.info(
          { userId, lobbyId },
          'Lobby disconnect: skipping draft pause — user still has a live socket in the draft room'
        );
        return;
      }
    }
    try {
      const { draftRealtimeService } = await import('./draft-realtime.service.js');
      await draftRealtimeService.pauseDraftForDisconnectedPlayer(io, lobbyId, userId, {
        ignoreSocketId: socket.id,
        disconnectedConnectedAt: socket.data.connectedAt,
      });
    } catch (error) {
      logger.warn({ error, lobbyId, userId }, 'Draft disconnect pause failed');
    }
    return;
  }

  if (lobby.status !== 'waiting') {
    return;
  }

  setTimeout(() => {
    // The outer disconnect callback releases its limiter slot while this grace
    // timer is sleeping. Reacquire here so thousands of timers expiring in the
    // same event-loop turn cannot bypass the socket cleanup bulkhead and flood
    // the application DB admission queue.
    void socketDbTaskLimiter.run(async () => {
      try {
        const sockets = await io.in(`lobby:${lobbyId}`).fetchSockets();
        const stillPresent = sockets.some((s) => s.data.user.id === userId);
        if (stillPresent) return;

        await lobbiesRepo.removeMember(lobbyId, userId);
        if (isRankedAiLobby(lobby)) {
          const aiUserId = await getRankedAiUserIdForLobby(lobbyId);
          if (aiUserId) {
            await lobbiesRepo.removeMember(lobbyId, aiUserId);
          }
          const redis = getRedisClient();
          if (redis) {
            await redis.del(rankedAiLobbyKey(lobbyId));
          }
        }
        logger.info({ lobbyId, userId }, 'Lobby disconnect cleanup: removed member');

        const closed = await closeLobbyIfEmpty(io, lobbyId);
        if (closed) {
          return;
        }

        if (lobby.host_user_id === userId) {
          await transferHostIfNeeded(lobbyId, userId);
        }

        await syncFriendlyLobbyModeForMemberCount(lobbyId);

        await emitLobbyState(io, lobbyId);
      } catch (error) {
        logger.warn({ error, lobbyId, userId }, 'Lobby disconnect cleanup failed');
      }
    }).catch((error) => {
      delayedLobbyCleanupRejections += 1;
      // Avoid turning a genuine overload into a second log-volume incident.
      if (delayedLobbyCleanupRejections % 50 === 1) {
        logger.warn(
          { error, lobbyId, userId, failures: delayedLobbyCleanupRejections },
          'Lobby disconnect cleanup rejected by socket DB task limiter'
        );
      }
    });
  }, LOBBY_DISCONNECT_GRACE_MS);
}
