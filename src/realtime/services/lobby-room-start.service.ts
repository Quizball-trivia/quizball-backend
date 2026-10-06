import { logger } from '../../core/logger.js';
import { lobbiesRepo } from '../../modules/lobbies/lobbies.repo.js';
import { roomService, ROOM_MAX_SEATS } from '../../modules/room/room.service.js';
import { RoomError, type RoomGameId } from '../../modules/room/room.types.js';
import { emitLobbyState, orderLobbyMembersByJoinTime } from '../lobby-utils.js';
import type { QuizballServer, QuizballSocket } from '../socket-server.js';
import { socketIpBucket } from '../socket-auth.js';
import { allowDuelOperation } from './duel-rate-limit.service.js';
import { roomRealtimeService } from './room-realtime.service.js';
import { warmupRealtimeService } from './warmup-realtime.service.js';

/**
 * Host start of a room game (game mode 'room_game'). The lobby command layer dispatches here after its generic
 * host/ready/guest checks. Throws on failure; the caller resets readiness and reports MATCH_CREATE_FAILED.
 * Everything after the commit is delivery only: a lost emit is repaired by the room screen's resync and the
 * reconnect pointer.
 */
export async function startRoomMatchFromLobby(
  io: QuizballServer,
  socket: QuizballSocket,
  input: { lobbyId: string; roomGame: RoomGameId },
): Promise<void> {
  const members = orderLobbyMembersByJoinTime(await lobbiesRepo.listMembersWithUser(input.lobbyId));
  if (members.length < 2 || members.length > ROOM_MAX_SEATS || members.some((m) => m.is_ai)) throw new RoomError('room_needs_players');
  if (!(await allowDuelOperation(socketIpBucket(socket), 'start_ip', 'room'))) throw new RoomError('rate_limited', 429);
  for (const member of members) {
    if (!(await allowDuelOperation(member.user_id, 'start', 'room'))) throw new RoomError('rate_limited', 429);
  }
  const effects = await roomService.createFromLobby({
    lobbyId: input.lobbyId,
    game: input.roomGame,
    players: members.map((m) => ({ userId: m.user_id, isGuest: m.is_guest === true })),
  });
  // Committed: any pointer read in flight is now stale, before the room's active state goes out.
  roomRealtimeService.markChanged(effects.userIds);

  await emitLobbyState(io, input.lobbyId).catch((error) => logger.warn({ error, lobbyId: input.lobbyId }, 'Room state delivery failed'));
  await warmupRealtimeService.cleanupLobby(input.lobbyId).catch(() => {});
  await roomRealtimeService.announce(io, effects, input.roomGame);
  logger.info({ lobbyId: input.lobbyId, matchId: effects.matchId, game: input.roomGame, players: members.length, by: socket.data.user.id }, 'Room match created');
}
