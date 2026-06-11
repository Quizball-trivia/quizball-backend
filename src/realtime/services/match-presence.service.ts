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
  | 'user_room_socket'
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
  /**
   * Also count live sockets in the per-user `user:<id>` room as presence
   * evidence. Token-refresh reconnects re-authenticate a fresh socket (which
   * joins the user room) without re-entering the match room — without this
   * fallback such players look absent and can be forfeited while online.
   * An explicit disconnect marker still outweighs this signal (same rule as
   * `presence_key`), so reconnect-limit forfeits keep their semantics.
   */
  includeUserRoomSockets?: boolean;
};

function socketUserId(socket: unknown): string | null {
  const data = (socket as { data?: { user?: { id?: unknown } } } | null)?.data;
  const userId = data?.user?.id;
  return typeof userId === 'string' ? userId : null;
}

export async function fetchUserRoomSockets(
  io: QuizballServer,
  userId: string
): Promise<unknown[]> {
  try {
    return await io.in(`user:${userId}`).fetchSockets();
  } catch (error) {
    logger.warn({ error, userId }, 'Failed to inspect user room sockets for presence resolution');
    return [];
  }
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

  // Optional fallback: a freshly re-authenticated socket joins `user:<id>`
  // before (or without ever) re-entering `match:<id>`. Only inspected for
  // users with no other presence evidence and no explicit disconnect marker,
  // to keep the extra adapter lookups bounded.
  const userRoomSocketUserIds = new Set<string>();
  if (options.includeUserRoomSockets) {
    const candidates = userIds.filter(
      (userId) =>
        !roomPresence.userIds.has(userId) &&
        !presenceKeyUserIds.has(userId) &&
        !disconnectKeyUserIds.has(userId) &&
        options.connectingUserId !== userId
    );
    const results = await Promise.all(
      candidates.map(async (userId) => ({
        userId,
        sockets: await fetchUserRoomSockets(io, userId),
      }))
    );
    for (const result of results) {
      if (result.sockets.length > 0) userRoomSocketUserIds.add(result.userId);
    }
  }

  const playerStates = roster.map((player): MatchPresencePlayerState<Player> => {
    const reasons: MatchPresenceReason[] = [];
    const user = usersById.get(player.user_id);
    const explicitlyDisconnected = disconnectKeyUserIds.has(player.user_id);

    if (user?.is_ai) reasons.push('ai');
    if (roomPresence.userIds.has(player.user_id)) reasons.push('room_socket');
    if (options.connectingUserId === player.user_id) reasons.push('connecting_user');
    // A leftover presence heartbeat must not override an explicit disconnect
    // marker — otherwise the disconnect-grace flow classifies the disconnected
    // side as "present" and resolves toward abandon/no-op instead of forfeit.
    // A live room socket / connecting user still wins over a stale disconnect key.
    if (presenceKeyUserIds.has(player.user_id) && !explicitlyDisconnected) reasons.push('presence_key');
    // Same precedence rule: a live user-room socket proves the player is
    // online (e.g. token-refresh reconnect that never rejoined the match),
    // but never overrides their own explicit disconnect marker.
    if (userRoomSocketUserIds.has(player.user_id) && !explicitlyDisconnected) reasons.push('user_room_socket');

    const present = reasons.length > 0;
    if (explicitlyDisconnected) reasons.push('disconnect_key');
    if (!present && options.staleCleanup) reasons.push('stale_missing_signal');
    const absent = !present && (explicitlyDisconnected || Boolean(options.staleCleanup));

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
