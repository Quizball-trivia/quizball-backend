import { logger } from '../../core/logger.js';
import { lobbiesRepo } from '../../modules/lobbies/lobbies.repo.js';
import { roomService, ROOM_MAX_SEATS } from '../../modules/room/room.service.js';
import { roomGameMinSeats, roomGameSeats } from '../../modules/room/room.types.js';
import { RoomError, type RoomGameId } from '../../modules/room/room.types.js';
import { emitLobbyState, orderLobbyMembersByJoinTime } from '../lobby-utils.js';
import type { QuizballServer, QuizballSocket } from '../socket-server.js';
import { socketIpBucket } from '../socket-auth.js';
import { allowDuelOperation } from './duel-rate-limit.service.js';
import { roomRealtimeService } from './room-realtime.service.js';
import { warmupRealtimeService } from './warmup-realtime.service.js';
import { config } from '../../core/config.js';
import { sql } from '../../db/index.js';
import { createZoneBotUser, deleteZoneBotUser, startZoneMatchBot } from '../../modules/room/games/zone-match/zone-match.bot.js';

/** A host alone may start zone match against the server bot (flag-gated). */
export function soloZoneBotStart(roomGame: unknown, memberCount: number): boolean {
  return memberCount === 1 && roomGame === 'zone_match' && config.ZONE_MATCH_BOT_ENABLED;
}

/**
 * Host start of a room game (game mode 'room_game'). The lobby command layer dispatches here after its generic
 * host/ready/guest checks. Throws on failure; the caller resets readiness and reports MATCH_CREATE_FAILED.
 * Everything after the commit is delivery only: a lost emit is repaired by the room screen's resync and the
 * reconnect pointer.
 */
export async function startRoomMatchFromLobby(
  io: QuizballServer,
  socket: QuizballSocket,
  input: { lobbyId: string; roomGame: RoomGameId; options?: Record<string, unknown> | null },
): Promise<void> {
  const members = orderLobbyMembersByJoinTime(await lobbiesRepo.listMembersWithUser(input.lobbyId));
  // A host alone in a zone-match room plays the server bot (flag-gated); every other shape needs the game's minimum
  // (two by default, three for Mentalista's chooser-plus-two-predictors).
  const soloVsBot = soloZoneBotStart(input.roomGame, members.length);
  if ((members.length < roomGameMinSeats(input.roomGame) && !soloVsBot) || members.length > roomGameSeats(input.roomGame, ROOM_MAX_SEATS) || members.some((m) => m.is_ai)) throw new RoomError('room_needs_players');
  if (!(await allowDuelOperation(socketIpBucket(socket), 'start_ip', 'room'))) throw new RoomError('rate_limited', 429);
  for (const member of members) {
    if (!(await allowDuelOperation(member.user_id, 'start', 'room'))) throw new RoomError('rate_limited', 429);
  }
  const players: Array<{ userId: string; isGuest: boolean; isBot?: boolean }> = members.map((m) => ({ userId: m.user_id, isGuest: m.is_guest === true }));
  const botUserId = soloVsBot ? await createZoneBotUser() : null;
  if (botUserId) players.push({ userId: botUserId, isGuest: false, isBot: true });
  let effects;
  try {
    effects = await roomService.createFromLobby({
      lobbyId: input.lobbyId,
      game: input.roomGame,
      options: input.options ?? null,
      players,
    });
  } catch (error) {
    // A bot minted for a start that failed must not linger until the weekly ephemeral sweep — but createFromLobby
    // can reject AFTER its commit (its post-commit clock read), and a live match's bot must never be deleted.
    if (botUserId) {
      try {
        const [live] = await sql<Array<{ id: string }>>`
          SELECT m.id FROM room_matches m JOIN room_seats s ON s.match_id = m.id
          WHERE s.user_id = ${botUserId} AND m.status IN ('ready', 'active') LIMIT 1
        `;
        if (!live) await deleteZoneBotUser(botUserId).catch(() => {});
      } catch {
        // Can't verify: keep the bot (the weekly ephemeral sweep is the lesser harm).
      }
    }
    throw error;
  }
  if (botUserId) startZoneMatchBot(io, effects.matchId, botUserId);
  // Committed: any pointer read in flight is now stale, before the room's active state goes out.
  roomRealtimeService.markChanged(effects.userIds);

  await emitLobbyState(io, input.lobbyId).catch((error) => logger.warn({ error, lobbyId: input.lobbyId }, 'Room state delivery failed'));
  await warmupRealtimeService.cleanupLobby(input.lobbyId).catch(() => {});
  await roomRealtimeService.announce(io, effects, input.roomGame, effects.engineVersion);
  logger.info({ lobbyId: input.lobbyId, matchId: effects.matchId, game: input.roomGame, players: members.length, by: socket.data.user.id }, 'Room match created');
}
