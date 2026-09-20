import { randomInt, randomUUID } from 'node:crypto';
import { config } from '../../core/config.js';
import { trackFootballGridMatchFound } from '../../core/analytics/game-events.js';
import { logger } from '../../core/logger.js';
import {
  footballGridRepo,
  footballGridService,
  FOOTBALL_GRID_HANDOFF_MS,
} from '../../modules/football-grid/index.js';
import { lobbiesRepo } from '../../modules/lobbies/lobbies.repo.js';
import { lobbyChallengeInvitationsRepo } from '../../modules/lobbies/lobby-challenge-invitations.repo.js';
import type { QuizballServer, QuizballSocket } from '../socket-server.js';
import { emitLobbyState, orderLobbyMembersByJoinTime } from '../lobby-utils.js';
import { footballGridRealtimeService } from './football-grid-realtime.service.js';
import { warmupRealtimeService } from './warmup-realtime.service.js';
import { transitionFootballGridSocket } from '../football-grid-socket-transition.js';

export async function startFootballGridMatchFromLobby(
  io: QuizballServer,
  socket: QuizballSocket,
  input: { lobbyId: string; isPublic: boolean; inviteCode: string | null },
): Promise<void> {
  if (!config.FOOTBALL_GRID_LOBBY_ENABLED || !config.FOOTBALL_GRID_CONTENT_ENABLED) {
    socket.emit('error', { code: 'GRID_UNAVAILABLE', message: 'Football Tic Tac Toe lobbies are temporarily unavailable' });
    return;
  }
  const members = await lobbiesRepo.listMembersWithUser(input.lobbyId);
  if (members.length !== 2 || members.some((member) => member.is_ai)) {
    socket.emit('error', { code: 'LOBBY_NOT_READY', message: 'Football Tic Tac Toe requires exactly two players' });
    return;
  }
  const pairingToken = randomUUID();
  const isChallenge = await lobbyChallengeInvitationsRepo.existsForLobby(input.lobbyId);
  const origin = isChallenge ? 'challenge' : input.isPublic ? 'public' : input.inviteCode ? 'code' : 'private';
  // postgres.js decodes timestamptz values as Date instances at runtime even
  // though the generated lobby row contract exposes ISO strings. Normalize
  // through Date so both representations preserve deterministic seat order.
  const [first, second] = orderLobbyMembersByJoinTime(members);
  let seriesId: string | null = null;
  let createdState: Awaited<ReturnType<typeof footballGridService.createMatch>>['state'];
  try {
    seriesId = await footballGridRepo.createSeries({ origin, lobbyId: input.lobbyId });
    await footballGridRepo.createPairing({
      pairingToken,
      searchAId: input.lobbyId,
      searchBId: input.lobbyId,
      userAId: first.user_id,
      userBId: second.user_id,
      opponentType: 'human',
    });
    const openerUserId = randomInt(2) === 0 ? first.user_id : second.user_id;
    const { state } = await footballGridService.createMatch({
      pairingToken,
      lobbyId: input.lobbyId,
      origin,
      players: [
        { userId: first.user_id, seat: 1 },
        { userId: second.user_id, seat: 2 },
      ],
      openerUserId,
      seriesId,
      // The durable match and lobby activity flip commit together. A second
      // host start that outlives the short Redis lock cannot create a ghost
      // match from a stale waiting-lobby snapshot.
      afterCreateInTx: async (tx) => {
        const lockedMembers = await tx.unsafe<Array<{ user_id: string; is_ready: boolean }>>(
          `SELECT user_id, is_ready FROM lobby_members
            WHERE lobby_id = $1 ORDER BY user_id FOR UPDATE`,
          [input.lobbyId],
        );
        const expectedUserIds = [first.user_id, second.user_id].sort();
        const actualUserIds = lockedMembers.map((member) => member.user_id).sort();
        if (
          lockedMembers.length !== 2
          || lockedMembers.some((member) => !member.is_ready)
          || actualUserIds.some((userId, index) => userId !== expectedUserIds[index])
        ) {
          throw new Error('GRID_LOBBY_ROSTER_CHANGED');
        }
        const activated = await tx.unsafe<Array<{ id: string }>>(
          `UPDATE lobbies
              SET status = 'active', updated_at = now()
            WHERE id = $1 AND status = 'waiting' AND game_mode = 'football_grid'
            RETURNING id`,
          [input.lobbyId],
        );
        if (!activated[0]) throw new Error('GRID_LOBBY_START_STALE');
      },
    });
    createdState = state;
  } catch (error) {
    if (seriesId) await footballGridRepo.closeSeries(seriesId).catch(() => {});
    await footballGridRepo.markPairingFailed(pairingToken, error instanceof Error ? error.message : 'unknown').catch(() => {});
    throw error;
  }

  // Everything below is post-commit delivery. A transient socket or warmup
  // cleanup failure must not relabel the already-created match as failed; the
  // handoff reconciler will redeliver it from Postgres.
  const matchedAt = new Date(
    Date.parse(createdState.phaseDeadlineAt ?? '') - FOOTBALL_GRID_HANDOFF_MS,
  );
  for (const member of members) {
    trackFootballGridMatchFound({
      userId: member.user_id,
      matchId: createdState.matchId,
      origin,
      opponentType: 'human',
      boardId: createdState.board.boardId,
      boardVersion: createdState.board.boardVersion,
      occurredAt: matchedAt,
    });
  }
  await emitLobbyState(io, input.lobbyId).catch((error) => {
    logger.warn({ error, lobbyId: input.lobbyId }, 'Football Grid active lobby state delivery failed');
  });
  await warmupRealtimeService.cleanupLobby(input.lobbyId).catch((error) => {
    logger.warn({ error, lobbyId: input.lobbyId }, 'Football Grid lobby warmup cleanup failed');
  });
  const lobbySockets = await io.in(`lobby:${input.lobbyId}`).fetchSockets().catch(() => []);
  for (const memberSocket of lobbySockets) {
    await transitionFootballGridSocket(io, {
      socketId: memberSocket.id,
      matchId: createdState.matchId,
      clearLobby: true,
    });
  }
  await footballGridRealtimeService.emitMatchFound(io, createdState).catch((error) => {
    logger.warn({ error, lobbyId: input.lobbyId, matchId: createdState.matchId }, 'Football Grid match handoff delivery deferred to reconciler');
  });
  logger.info({ lobbyId: input.lobbyId, matchId: createdState.matchId }, 'Football Grid lobby match created');
}
