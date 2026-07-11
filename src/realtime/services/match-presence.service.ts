import { logger } from '../../core/logger.js';
import { usersRepo } from '../../modules/users/users.repo.js';
import { getRedisClient } from '../redis.js';
import type { QuizballServer } from '../socket-server.js';
import {
  matchDisconnectKey,
  matchExitPendingKey,
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
  | 'exit_pending'
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
  exitPendingUserIds: string[];
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
): Promise<unknown[] | null> {
  try {
    return await io.in(`user:${userId}`).fetchSockets();
  } catch (error) {
    logger.warn({ error, userId }, 'Failed to inspect user room sockets for presence resolution');
    return null;
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
  const exitPendingUserIds = new Set<string>();
  if (redis?.isOpen) {
    const presenceResults = await Promise.all(
      userIds.map((userId) => redis.exists(matchPresenceKey(matchId, userId)))
    );
    const disconnectResults = await Promise.all(
      userIds.map((userId) => redis.exists(matchDisconnectKey(matchId, userId)))
    );
    const exitPendingResults = await Promise.all(
      userIds.map((userId) => redis.exists(matchExitPendingKey(matchId, userId)))
    );
    userIds.forEach((userId, index) => {
      if (presenceResults[index] === 1) presenceKeyUserIds.add(userId);
      if (disconnectResults[index] === 1) disconnectKeyUserIds.add(userId);
      if (exitPendingResults[index] === 1) exitPendingUserIds.add(userId);
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
      if (result.sockets === null || result.sockets.length > 0) {
        userRoomSocketUserIds.add(result.userId);
      }
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
    // A player who safely left while their opponent was already in disconnect
    // grace counts as present-by-proxy until that grace resolves. If the
    // opponent comes back, the resume path clears this marker and gives the
    // leaver their own grace instead.
    if (exitPendingUserIds.has(player.user_id) && !explicitlyDisconnected) reasons.push('exit_pending');

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
    exitPendingUserIds: [...exitPendingUserIds],
    matchSocketCount: roomPresence.socketCount,
  };
}

/**
 * Whether the forfeit-first branch may award the win to the present player(s).
 *
 * An AI opponent is synthetically "present" (reason `'ai'`) because it has no
 * socket to lose — see line ~167. So a human who drops would be the lone absent
 * player and forfeit the match TO THE BOT, even while leading on points (prod
 * case Thenotorious vs qartlosii, 2026-06-19). Forfeit-first exists to protect a
 * HUMAN who stayed, never to gift a bot a win it didn't earn. When EVERY present
 * player is an AI, the caller must skip forfeit-first and fall through to
 * progress-based completion (the human's lead wins) or a no-contest abandon
 * (ticket refunded) when progress is undecidable.
 *
 * Shared by every terminal resolver (live disconnect grace + orphan/stale
 * resolver) so the rule can't drift between them.
 */
export function canForfeitToPresentPlayers<Player extends MatchPresencePlayer>(
  resolution: MatchPresenceResolution<Player>
): boolean {
  if (resolution.presentPlayers.length === 0) return false;
  const presentStates = resolution.playerStates.filter((state) => state.present);
  return !presentStates.every((state) => state.reasons.includes('ai'));
}
