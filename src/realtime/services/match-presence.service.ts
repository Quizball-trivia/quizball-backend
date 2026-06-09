import { logger } from '../../core/logger.js';
import { usersRepo } from '../../modules/users/users.repo.js';
import { getRedisClient } from '../redis.js';
import type { QuizballServer } from '../socket-server.js';
import {
  matchDisconnectKey,
  matchPresenceKey,
} from '../match-keys.js';

type MatchPresencePlayer = {
  user_id: string;
};

export type MatchPresenceReason =
  | 'ai'
  | 'room_socket'
  | 'connecting_user'
  | 'presence_key'
  | 'disconnect_key'
  | 'stale_missing_signal';

export interface MatchPresencePlayerState<Player extends MatchPresencePlayer> {
  player: Player;
  userId: string;
  present: boolean;
  absent: boolean;
  reasons: MatchPresenceReason[];
}

export interface MatchPresenceResolution<Player extends MatchPresencePlayer> {
  playerStates: Array<MatchPresencePlayerState<Player>>;
  presentPlayers: Player[];
  absentPlayers: Player[];
  roomSocketUserIds: string[];
  presenceKeyUserIds: string[];
  disconnectKeyUserIds: string[];
  matchSocketCount: number | null;
}

type MatchPresenceOptions = {
  connectingUserId?: string | null;
  staleCleanup?: boolean;
  disconnectedUserIds?: Iterable<string>;
};

function socketUserId(socket: unknown): string | null {
  const data = (socket as { data?: { user?: { id?: unknown } } } | null)?.data;
  const userId = data?.user?.id;
  return typeof userId === 'string' ? userId : null;
}

async function fetchMatchRoomUserIds(
  io: QuizballServer,
  matchId: string
): Promise<{ userIds: Set<string>; socketCount: number | null }> {
  try {
    const sockets = await io.in(`match:${matchId}`).fetchSockets();
    return {
      userIds: new Set(sockets.map(socketUserId).filter((value): value is string => Boolean(value))),
      socketCount: sockets.length,
    };
  } catch (error) {
    logger.warn({ error, matchId }, 'Failed to inspect match room sockets for presence resolution');
    return {
      userIds: new Set(),
      socketCount: null,
    };
  }
}

/**
 * Shared 1v1 match presence resolution.
 *
 * Presence wins over absence: a live match-room socket is authoritative even if
 * the short Redis presence heartbeat has expired, and the user currently
 * connecting is unconditionally present because prepareForConnect runs before
 * that socket has rejoined match:<id>.
 */
export async function resolveMatchPresence<Player extends MatchPresencePlayer>(
  io: QuizballServer,
  matchId: string,
  roster: Player[],
  options: MatchPresenceOptions = {}
): Promise<MatchPresenceResolution<Player>> {
  const redis = getRedisClient();
  const userIds = roster.map((player) => player.user_id);
  const disconnectedOptionUserIds = new Set(options.disconnectedUserIds ?? []);
  const [usersById, roomPresence] = await Promise.all([
    usersRepo.getByIds(userIds),
    fetchMatchRoomUserIds(io, matchId),
  ]);

  const presenceKeyUserIds = new Set<string>();
  const disconnectKeyUserIds = new Set(disconnectedOptionUserIds);
  if (redis?.isOpen) {
    const presenceResults = await Promise.all(
      userIds.map((userId) => redis.exists(matchPresenceKey(matchId, userId)))
    );
    const disconnectResults = await Promise.all(
      userIds.map((userId) => redis.exists(matchDisconnectKey(matchId, userId)))
    );
    userIds.forEach((userId, index) => {
      if (presenceResults[index] === 1) presenceKeyUserIds.add(userId);
      if (disconnectResults[index] === 1) disconnectKeyUserIds.add(userId);
    });
  }

  const playerStates = roster.map((player): MatchPresencePlayerState<Player> => {
    const reasons: MatchPresenceReason[] = [];
    const user = usersById.get(player.user_id);
    if (user?.is_ai) reasons.push('ai');
    if (roomPresence.userIds.has(player.user_id)) reasons.push('room_socket');
    if (options.connectingUserId === player.user_id) reasons.push('connecting_user');
    if (presenceKeyUserIds.has(player.user_id)) reasons.push('presence_key');

    const present = reasons.length > 0;
    if (disconnectKeyUserIds.has(player.user_id)) reasons.push('disconnect_key');
    if (!present && options.staleCleanup) reasons.push('stale_missing_signal');
    const absent = !present && (disconnectKeyUserIds.has(player.user_id) || Boolean(options.staleCleanup));

    return {
      player,
      userId: player.user_id,
      present,
      absent,
      reasons,
    };
  });

  return {
    playerStates,
    presentPlayers: playerStates.filter((state) => state.present).map((state) => state.player),
    absentPlayers: playerStates.filter((state) => state.absent).map((state) => state.player),
    roomSocketUserIds: [...roomPresence.userIds],
    presenceKeyUserIds: [...presenceKeyUserIds],
    disconnectKeyUserIds: [...disconnectKeyUserIds],
    matchSocketCount: roomPresence.socketCount,
  };
}
