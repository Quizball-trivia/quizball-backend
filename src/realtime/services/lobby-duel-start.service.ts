import { logger } from '../../core/logger.js';
import { duelService, DuelError } from '../../modules/duel/duel.service.js';
import type { DuelGameId } from '../../modules/duel/duel.types.js';
import { lobbiesRepo } from '../../modules/lobbies/lobbies.repo.js';
import { emitLobbyState, orderLobbyMembersByJoinTime } from '../lobby-utils.js';
import type { QuizballServer, QuizballSocket } from '../socket-server.js';
import { allowDuelOperation } from './duel-rate-limit.service.js';
import { socketIpBucket } from '../socket-auth.js';
import { duelRealtimeService } from './duel-realtime.service.js';
import { warmupRealtimeService } from './warmup-realtime.service.js';

/**
 * Host start of a friend duel room (game mode 'duel'). The lobby command layer dispatches here after its
 * generic host/ready/guest checks. Throws on failure; the caller resets readiness and reports MATCH_CREATE_FAILED.
 * Everything after the commit is delivery only: a lost emit is repaired by the duel screen's resync and the
 * reconnect pointer, never by recreating the match.
 */
export async function startDuelMatchFromLobby(
  io: QuizballServer,
  socket: QuizballSocket,
  input: { lobbyId: string; duelGame: DuelGameId },
): Promise<void> {
  const members = orderLobbyMembersByJoinTime(await lobbiesRepo.listMembersWithUser(input.lobbyId));
  if (members.length !== 2 || members.some((m) => m.is_ai)) throw new DuelError('duel_needs_two');
  if (!(await allowDuelOperation(socketIpBucket(socket), 'start_ip'))) throw new DuelError('rate_limited', 429);
  for (const member of members) {
    if (!(await allowDuelOperation(member.user_id, 'start'))) throw new DuelError('rate_limited', 429);
  }
  const effects = await duelService.createFromLobby({
    lobbyId: input.lobbyId,
    game: input.duelGame,
    players: members.map((m) => ({ userId: m.user_id, isGuest: m.is_guest === true })),
  });

  await emitLobbyState(io, input.lobbyId).catch((error) => logger.warn({ error, lobbyId: input.lobbyId }, 'Duel room state delivery failed'));
  await warmupRealtimeService.cleanupLobby(input.lobbyId).catch(() => {});
  await duelRealtimeService.announce(io, effects, input.duelGame);
  logger.info({ lobbyId: input.lobbyId, matchId: effects.matchId, game: input.duelGame, by: socket.data.user.id }, 'Duel match created');
}
