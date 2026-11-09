import { declares, declaresRoomOptions, NEEDS_RELOAD_CODE, NEEDS_RELOAD_MESSAGE } from '../client-games.js';
import type { QuizballServer, QuizballSocket } from '../socket-server.js';
import { lobbiesRepo } from '../../modules/lobbies/lobbies.repo.js';
import { lobbiesService } from '../../modules/lobbies/lobbies.service.js';
import { logger } from '../../core/logger.js';
import { attachUserSocketsToLobby } from '../lobby-utils.js';
import { userSessionGuardService } from './user-session-guard.service.js';
import {
  autoLeaveAllWaitingLobbies,
  acquireLobbyLockWithRetry,
  getFirstDraftActorId,
  getNextDraftActorId,
  resolveRankedAiUserIdForDraft,
} from './lobby-lifecycle.helpers.js';
import { startDraft } from './lobby-draft-start.service.js';

import { releaseLock } from '../locks.js';
import { reserveWaitingLobbyDisconnect } from './lobby-disconnect.service.js';
export { expireWaitingLobbyDisconnect } from './lobby-disconnect.service.js';

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
  if (!declares(socket.data, newestLobby.game_mode === 'room_game' ? newestLobby.room_game : null) || !declaresRoomOptions(socket.data, newestLobby)) {
    socket.emit('error', { code: NEEDS_RELOAD_CODE, message: NEEDS_RELOAD_MESSAGE });
    return;
  }
  await autoLeaveAllWaitingLobbies(io, userId, newestLobby.id);

  // Reconnect invalidation and disconnect reservation share the room lock. A
  // transport closing during hydration must not clear a newer absence lease.
  const lock = await acquireLobbyLockWithRetry(newestLobby.id, 10_000, 1_200);
  if (!lock.acquired || !lock.token) throw new Error('Waiting lobby reconnect is busy');
  try {
    const current = await lobbiesRepo.getById(newestLobby.id);
    if (!current || current.status !== 'waiting') return;
    const members = await lobbiesRepo.listMembersWithUser(newestLobby.id);
    if (!members.some(member => member.user_id === userId)) return;
    await attachUserSocketsToLobby(io, userId, newestLobby.id);
    socket.emit('lobby:state', await lobbiesService.buildLobbyState(current));
  } finally {
    await releaseLock(`lock:lobby:${newestLobby.id}`, lock.token);
  }
  await userSessionGuardService.emitState(io, userId);

  // Room-game ranked lobbies are the zone queue's synthetic anchors: they never run the legacy draft.
  if (newestLobby.mode === 'ranked' && newestLobby.game_mode !== 'room_game') {
    const members = await lobbiesRepo.listMembersWithUser(newestLobby.id);
    if (members.length === 2) {
      setTimeout(() => {
        void (async () => {
          const latest = await lobbiesRepo.getById(newestLobby.id);
          if (!latest || latest.status !== 'waiting' || latest.mode !== 'ranked') return;
          await startDraft(io, newestLobby.id, { expectWaiting: true });
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
  if (!declares(socket.data, newestLobby.game_mode === 'room_game' ? newestLobby.room_game : null) || !declaresRoomOptions(socket.data, newestLobby)) {
    socket.emit('error', { code: NEEDS_RELOAD_CODE, message: NEEDS_RELOAD_MESSAGE });
    return;
  }
  await attachUserSocketsToLobby(io, userId, newestLobby.id);
  // A duel room has no draft: re-bind the socket (Ready/Start after the duel need it) and show
  // the room. The duel runtime points the player back at the live duel itself (duel:found).
  if (newestLobby.game_mode === 'duel' || newestLobby.game_mode === 'room_game') {
    socket.emit('lobby:state', await lobbiesService.buildLobbyState(newestLobby));
    logger.info({ userId, lobbyId: newestLobby.id }, 'Socket rejoined active duel room');
    return;
  }
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
    // Duels are deadline-driven: a disconnect pauses nothing (idle strikes and the ready gate decide).
    if (lobby.game_mode === 'duel' || lobby.game_mode === 'room_game') return;
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

  await reserveWaitingLobbyDisconnect(io, socket, lobbyId);
}
