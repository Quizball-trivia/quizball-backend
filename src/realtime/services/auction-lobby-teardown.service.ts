import { logger } from '../../core/logger.js';
import { acquireLock, releaseLock } from '../locks.js';
import { lobbiesRepo } from '../../modules/lobbies/lobbies.repo.js';
import {
  auctionMatchOrigin,
  type AuctionMatchState,
} from '../../modules/auction/auction-match-state.js';
import type { QuizballServer } from '../socket-server.js';
import { userSessionGuardService } from './user-session-guard.service.js';

const LOBBY_LOCK_TTL_MS = 3000;

export async function teardownFinishedLobbyAuction(
  io: QuizballServer,
  state: AuctionMatchState,
): Promise<void> {
  if (state.phase !== 'finished' || auctionMatchOrigin(state) !== 'lobby' || !state.sourceLobbyId) {
    return;
  }

  const lobbyId = state.sourceLobbyId;
  // Under lock contention (e.g. the start path's final status write is still in
  // flight) skip rather than interleave — the stale-lobby heal closes it later.
  const lockKey = `lock:lobby:${lobbyId}`;
  const lock = await acquireLock(lockKey, LOBBY_LOCK_TTL_MS);
  if (!lock.acquired || !lock.token) {
    logger.warn({ lobbyId, matchId: state.matchId }, 'Finished auction lobby teardown skipped: lobby lock not acquired');
    return;
  }

  let members: Awaited<ReturnType<typeof lobbiesRepo.listMembersWithUser>>;
  try {
    members = await lobbiesRepo.listMembersWithUser(lobbyId);
    await lobbiesRepo.setLobbyStatus(lobbyId, 'closed');
    await lobbiesRepo.removeMembers(lobbyId, members.map((member) => member.user_id));
  } finally {
    await releaseLock(lockKey, lock.token);
  }

  const [matchSockets, lobbySockets] = await Promise.all([
    io.in(`match:${state.matchId}`).fetchSockets(),
    io.in(`lobby:${lobbyId}`).fetchSockets(),
  ]);
  matchSockets.forEach((socket) => {
    socket.leave(`match:${state.matchId}`);
    if (socket.data.matchId === state.matchId) {
      socket.data.matchId = undefined;
    }
  });
  lobbySockets.forEach((socket) => {
    socket.leave(`lobby:${lobbyId}`);
    if (socket.data.lobbyId === lobbyId) {
      socket.data.lobbyId = undefined;
    }
  });

  await Promise.all(members.map((member) => (
    userSessionGuardService.emitState(io, member.user_id).catch((error) => {
      logger.warn(
        { error, matchId: state.matchId, lobbyId, userId: member.user_id },
        'Failed to emit session state after auction lobby teardown'
      );
    })
  )));
  logger.info(
    { matchId: state.matchId, lobbyId, memberUserIds: members.map((member) => member.user_id) },
    'Finished auction lobby closed'
  );
}
