import { randomUUID } from 'crypto';
import type { QuizballServer, QuizballSocket } from '../socket-server.js';
import type { LobbyState, SessionStatePayload } from '../socket.types.js';
import type { User } from '../../db/types.js';
import { harnessDelayMs } from '../../core/harness-timing.js';
import { config } from '../../core/config.js';
import { countryPayload } from '../../core/country.js';
import { logger } from '../../core/logger.js';
import { getRedisClient } from '../redis.js';
import { lobbiesRepo } from '../../modules/lobbies/lobbies.repo.js';
import type { LobbyRow } from '../../modules/lobbies/lobbies.types.js';
import { DbOverloadedError } from '../../db/admission.js';
import { rankedService } from '../../modules/ranked/ranked.service.js';
import type { RankedProfileRow } from '../../modules/ranked/ranked.types.js';
import { statsService } from '../../modules/stats/stats.service.js';
import { storeService } from '../../modules/store/store.service.js';
import { parseStoredAvatarCustomization } from '../../modules/users/avatar-customization.js';
import { usersRepo } from '../../modules/users/users.repo.js';
import { startDraft, startRankedAiForUser } from './lobby-realtime.service.js';
import { fetchUserRoomSockets } from './match-presence.service.js';
import { scheduleRealtimeTimer } from '../realtime-timer-scheduler.js';
import { userSessionGuardService } from './user-session-guard.service.js';
import { withSpan } from '../../core/tracing.js';
import { appMetrics } from '../../core/metrics.js';
import {
  trackRankedQueueJoined,
  trackRankedQueueJoinIgnored,
  trackRankedQueueLeft,
} from '../../core/analytics/game-events.js';
import {
  RANKED_MM_CANCEL_SEARCH_SCRIPT,
  RANKED_MM_CLAIM_FALLBACK_SCRIPT,
  RANKED_MM_PAIR_TWO_RANDOM_SCRIPT,
  RANKED_MM_STALE_RESULT,
} from '../lua/ranked-matchmaking.scripts.js';
import { rankedDebug, rankedDebugUser } from '../ranked-debug.js';
import {
  RANKED_MM_QUEUE_KEY,
  RANKED_MM_PAIRING_IN_FLIGHT_KEY_PREFIX,
  RANKED_MM_SEARCH_KEY_PREFIX,
  RANKED_MM_TIMEOUTS_KEY,
  RANKED_MM_USER_MAP_KEY,
  rankedAssignedLobbyKey,
  rankedCancelKey,
  rankedJoinDebounceKey,
  rankedLeaveGuardKey,
  rankedPairingInFlightKey,
  rankedSearchKey,
} from '../ranked-matchmaking-keys.js';

const SEARCH_DURATION_MS = 10000;
const SEARCH_KEY_TTL_SEC = 60;
const TICK_INTERVAL_MS = 100;
const MAX_FALLBACKS_PER_TICK = 50;
const MAX_PAIRS_PER_TICK = 100;
// A real match start performs several database/network round trips. Keep four
// workflows moving as a streaming pool so one slow lobby does not stall the
// other slots. The independent DB admission gate still enforces its 12-query
// cap; this bound prevents the matcher itself from spawning unlimited work.
const MAX_CONCURRENT_PAIR_STARTS = 4;
const FOUND_MODAL_MS = 1200;

const CANCEL_KEY_TTL_SEC = 30;
const LEAVE_GUARD_TTL_SEC = 2;
const DISCONNECT_CLEANUP_LOCK_ATTEMPTS = 3;
const DISCONNECT_CLEANUP_LOCK_RETRY_DELAY_MS = 1_000;

function waitForMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function emitQueuedSessionState(
  io: QuizballServer,
  userId: string,
  snapshot: SessionStatePayload,
  searchId: string,
): SessionStatePayload {
  const queuedSnapshot: SessionStatePayload = {
    ...snapshot,
    state: 'IN_QUEUE',
    activeMatchId: null,
    waitingLobbyId: null,
    queueSearchId: searchId,
    openLobbyIds: [],
    resolvedAt: new Date().toISOString(),
  };
  io.to(`user:${userId}`).emit('session:state', queuedSnapshot);
  return queuedSnapshot;
}
const JOIN_DEBOUNCE_TTL_SEC = 2;
const PAIRING_IN_FLIGHT_TTL_SEC = 30;
const ASSIGNED_LOBBY_TTL_SEC = 5 * 60;
let loopTimer: NodeJS.Timeout | null = null;
let loopIo: QuizballServer | null = null;
let tickInFlight = false;

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

async function setPairingInFlight(userIds: string[]): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;
  await Promise.all(
    userIds.map((userId) =>
      redis.set(rankedPairingInFlightKey(userId), '1', { EX: PAIRING_IN_FLIGHT_TTL_SEC })
    )
  );
}

async function clearPairingInFlight(userIds: string[]): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;
  await redis.del(userIds.map((userId) => rankedPairingInFlightKey(userId)));
}

async function bestEffortCancelRankedQueueSearch(userId: string, source: string): Promise<string | null> {
  const redis = getRedisClient();
  if (!redis) return null;

  try {
    const resultRaw = await redis.eval(RANKED_MM_CANCEL_SEARCH_SCRIPT, {
      keys: [RANKED_MM_QUEUE_KEY, RANKED_MM_TIMEOUTS_KEY, RANKED_MM_USER_MAP_KEY],
      arguments: [RANKED_MM_SEARCH_KEY_PREFIX, userId, String(Date.now())],
    });
    return toStringArray(resultRaw)[0] ?? null;
  } catch (error) {
    logger.warn({ err: error, userId, source }, 'Ranked stale queue cleanup failed');
    return null;
  }
}

async function handleStaleRankedQueueUser(
  io: QuizballServer,
  userId: string,
  source: string
): Promise<void> {
  logger.warn({ userId, source }, 'Ranked queue user skipped because DB user was missing');
  const searchId = await bestEffortCancelRankedQueueSearch(userId, source);
  trackRankedQueueLeft({
    userId,
    source: 'server_abort',
    searchFound: Boolean(searchId),
    searchId,
  });
  io.to(`user:${userId}`).emit('ranked:queue_left');
}

type RankedMatchmakingSessionBlock = {
  activeMatchId: string | null;
  waitingLobbyId: string | null;
  queueSearchId: string | null;
  state: string;
};

async function getRankedMatchmakingSessionBlocks(
  userIds: string[],
  options: { ignorePairingInFlight?: boolean } = {}
): Promise<Map<string, RankedMatchmakingSessionBlock | null>> {
  const uniqueUserIds = [...new Set(userIds)];
  const snapshots = await userSessionGuardService.resolveStates(uniqueUserIds);
  const redis = getRedisClient();
  const pairingStates = !options.ignorePairingInFlight && redis
    ? await Promise.all(uniqueUserIds.map(async (userId) => (
      (await redis.exists(rankedPairingInFlightKey(userId))) === 1
    )))
    : uniqueUserIds.map(() => false);

  return new Map(uniqueUserIds.map((userId, index) => {
    const snapshot = snapshots.get(userId);
    if (!snapshot) return [userId, null];
    const pairingInFlight = pairingStates[index] ?? false;
    const blocked = Boolean(
      snapshot.activeMatchId ||
      snapshot.waitingLobbyId ||
      snapshot.queueSearchId ||
      snapshot.state === 'CORRUPT_MULTI_STATE' ||
      pairingInFlight
    );
    if (!blocked) return [userId, null];
    return [userId, {
      activeMatchId: snapshot.activeMatchId,
      waitingLobbyId: snapshot.waitingLobbyId,
      queueSearchId: snapshot.queueSearchId,
      state: pairingInFlight ? 'PAIRING_IN_FLIGHT' : snapshot.state,
    }];
  }));
}

async function getRankedMatchmakingSessionBlock(
  userId: string,
  options: { ignorePairingInFlight?: boolean } = {}
): Promise<RankedMatchmakingSessionBlock | null> {
  const blocks = await getRankedMatchmakingSessionBlocks([userId], options);
  return blocks.get(userId) ?? null;
}

function emitInsufficientTickets(
  io: QuizballServer,
  userId: string,
  source: string,
  tickets: number
): void {
  trackRankedQueueLeft({
    userId,
    source: 'server_abort',
    searchFound: false,
    searchId: null,
  });
  io.to(`user:${userId}`).emit('ranked:queue_left');
  io.to(`user:${userId}`).emit('error', {
    code: 'INSUFFICIENT_TICKETS',
    message: 'You need a ticket to start ranked.',
    meta: {
      source,
      tickets,
    },
  });
}

async function getRankedTicketWallets(userIds: string[]): Promise<Record<string, { coins: number; tickets: number }>> {
  const wallets = await storeService.getRankedTicketWallets(userIds);
  return Object.fromEntries(wallets);
}

function emitCreatedRankedLobbyState(
  io: QuizballServer,
  lobby: LobbyRow,
  userA: User,
  userB: User,
  profileA: RankedProfileRow,
  profileB: RankedProfileRow,
): void {
  const state: LobbyState = {
    lobbyId: lobby.id,
    mode: 'ranked',
    status: lobby.status,
    inviteCode: lobby.invite_code,
    displayName: lobby.display_name ?? 'Friendly Lobby',
    isPublic: lobby.is_public ?? false,
    hostUserId: lobby.host_user_id,
    settings: {
      gameMode: lobby.game_mode ?? 'ranked_sim',
      friendlyRandom: lobby.friendly_random ?? true,
      friendlyCategoryAId: lobby.friendly_category_a_id ?? null,
      friendlyCategoryBId: lobby.friendly_category_b_id ?? null,
    },
    members: [
      {
        userId: userA.id,
        username: userA.nickname ?? 'Player',
        avatarUrl: userA.avatar_url,
        avatarCustomization: parseStoredAvatarCustomization(userA.avatar_customization),
        isReady: true,
        isHost: userA.id === lobby.host_user_id,
        ...{ rankPoints: profileA.rp },
      },
      {
        userId: userB.id,
        username: userB.nickname ?? 'Player',
        avatarUrl: userB.avatar_url,
        avatarCustomization: parseStoredAvatarCustomization(userB.avatar_customization),
        isReady: true,
        isHost: userB.id === lobby.host_user_id,
        ...{ rankPoints: profileB.rp },
      },
    ],
  };
  io.to(`lobby:${lobby.id}`).emit('lobby:state', state);
}

function emitCreatedRankedSessionStates(
  io: QuizballServer,
  lobbyId: string,
  userIds: string[],
): void {
  const resolvedAt = new Date().toISOString();
  for (const userId of userIds) {
    const snapshot: SessionStatePayload = {
      state: 'IN_WAITING_LOBBY',
      activeMatchId: null,
      waitingLobbyId: lobbyId,
      queueSearchId: null,
      openLobbyIds: [lobbyId],
      resolvedAt,
    };
    io.to(`user:${userId}`).emit('session:state', snapshot);
  }
}

async function hasTicketForRankedQueue(io: QuizballServer, userId: string, source: string): Promise<boolean> {
  const wallets = await storeService.getRankedTicketWallets([userId]);
  const wallet = wallets.get(userId);
  if (!wallet) {
    await handleStaleRankedQueueUser(io, userId, source);
    return false;
  }

  if (wallet.tickets >= 1) {
    logger.debug({ userId, source, tickets: wallet.tickets }, 'Ranked ticket preflight passed');
    rankedDebug('ticket_preflight_passed', {
      user: rankedDebugUser(userId),
      source,
      tickets: wallet.tickets,
    });
    return true;
  }

  logger.warn({ userId, source, tickets: wallet.tickets }, 'Ranked ticket preflight blocked queue start');
  rankedDebug('ticket_preflight_blocked', {
    user: rankedDebugUser(userId),
    source,
    tickets: wallet.tickets,
  });
  emitInsufficientTickets(io, userId, source, wallet.tickets);
  await userSessionGuardService.emitState(io, userId);
  return false;
}

async function attachUserSocketsToLobby(
  io: QuizballServer,
  userId: string,
  lobbyId: string
): Promise<void> {
  await io.in(`user:${userId}`).socketsJoin(`lobby:${lobbyId}`);
  const sockets = await io.in(`user:${userId}`).fetchSockets();
  sockets.forEach((socket) => {
    socket.data.lobbyId = lobbyId;
  });
}

async function hasLiveAuthenticatedSocket(io: QuizballServer, userId: string): Promise<boolean> {
  const sockets = await fetchUserRoomSockets(io, userId);
  if (sockets === null) return true;
  return sockets.some((socket) => {
    const data = (socket as { data?: { user?: { id?: unknown } } } | null)?.data;
    return data?.user?.id === userId;
  });
}

/**
 * Put a still-present player back into the ranked queue with a fresh search
 * after their pairing was aborted (opponent turned out to be a ghost). Mirrors
 * the enqueue in handleQueueJoin so the player keeps searching instead of
 * silently falling out of matchmaking.
 */
async function requeueRankedSearch(io: QuizballServer, userId: string): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;
  const now = Date.now();
  const deadlineAt = now + SEARCH_DURATION_MS;
  const newSearchId = randomUUID();
  const socket = (await fetchUserRoomSockets(io, userId) ?? [])[0] as
    | { data?: { currentCountry?: string } }
    | undefined;
  const searchFields: Record<string, string> = {
    userId,
    status: 'queued',
    queuedAt: String(now),
    deadlineAt: String(deadlineAt),
  };
  if (socket?.data?.currentCountry) {
    searchFields.countryCode = socket.data.currentCountry;
  }
  const multiResult = await redis
    .multi()
    .hSet(rankedSearchKey(newSearchId), searchFields)
    .expire(rankedSearchKey(newSearchId), SEARCH_KEY_TTL_SEC)
    .zAdd(RANKED_MM_QUEUE_KEY, { score: now, value: newSearchId })
    .zAdd(RANKED_MM_TIMEOUTS_KEY, { score: deadlineAt, value: newSearchId })
    .hSet(RANKED_MM_USER_MAP_KEY, userId, newSearchId)
    .exec();

  if (!multiResult) {
    logger.error({ userId }, 'Ranked re-queue failed: Redis multi returned null');
    io.to(`user:${userId}`).emit('error', {
      code: 'RANKED_QUEUE_UNAVAILABLE',
      message: 'Ranked queue is unavailable, please retry',
    });
    return;
  }

  io.to(`user:${userId}`).emit('ranked:search_started', { durationMs: SEARCH_DURATION_MS });
  await userSessionGuardService.emitState(io, userId);
  logger.info({ userId, searchId: newSearchId }, 'Re-queued present player after ghost pairing');
}

export async function startHumanRankedMatch(
  io: QuizballServer,
  userAId: string,
  userBId: string,
  sessionCountries?: {
    userA?: string | null;
    userB?: string | null;
  }
): Promise<void> {
  await withSpan('ranked.match_found.human', {
    'quizball.user_a_id': userAId,
    'quizball.user_b_id': userBId,
  }, async (span) => {
    if (userAId === userBId) {
      rankedDebug('human_pair_skipped_same_user', {
        user: rankedDebugUser(userAId),
      });
      return;
    }
    try {
      await setPairingInFlight([userAId, userBId]);
      rankedDebug('human_pair_candidate', {
        userA: rankedDebugUser(userAId),
        userB: rankedDebugUser(userBId),
      });

      const getCancelFlags = async (): Promise<[boolean, boolean]> => {
        const latestRedis = getRedisClient();
        if (!latestRedis) return [false, false];
        const [userACancelled, userBCancelled] = await Promise.all([
          latestRedis.get(rankedCancelKey(userAId)),
          latestRedis.get(rankedCancelKey(userBId)),
        ]);
        return [Boolean(userACancelled), Boolean(userBCancelled)];
      };
      // The pair has already been claimed out of the Redis queue by
      // processPairs. If we bail because one side cancelled, the OTHER side
      // must be told the search ended (ranked:queue_left + fresh session
      // state) — otherwise their client keeps showing "searching" forever.
      const releaseUncancelledUsers = async (userACancelled: boolean, userBCancelled: boolean) => {
        const survivors = [
          userACancelled ? null : userAId,
          userBCancelled ? null : userBId,
        ].filter((id): id is string => Boolean(id));
        for (const survivorId of survivors) {
          trackRankedQueueLeft({
            userId: survivorId,
            source: 'server_abort',
            searchFound: false,
            searchId: null,
          });
          io.to(`user:${survivorId}`).emit('ranked:queue_left');
        }
        await Promise.all(survivors.map((id) => userSessionGuardService.emitState(io, id)));
      };

      {
        const [userACancelled, userBCancelled] = await getCancelFlags();
        if (userACancelled || userBCancelled) {
          logger.info(
            { userAId, userBId, userACancelled, userBCancelled },
            'Ranked human match creation skipped because a player cancelled search'
          );
          rankedDebug('human_pair_skipped_cancelled', {
            userA: rankedDebugUser(userAId),
            userB: rankedDebugUser(userBId),
            userACancelled,
            userBCancelled,
          });
          await releaseUncancelledUsers(userACancelled, userBCancelled);
          span.setAttribute('quizball.skipped_cancelled', true);
          return;
        }
      }

      const abortIfMissingLiveSocket = async (): Promise<boolean> => {
        const [userAPresent, userBPresent] = await Promise.all([
          hasLiveAuthenticatedSocket(io, userAId),
          hasLiveAuthenticatedSocket(io, userBId),
        ]);
        if (userAPresent && userBPresent) return false;

        logger.warn(
          { userAId, userBId, userAPresent, userBPresent },
          'Ranked human match creation skipped: a paired player has no live socket'
        );
        rankedDebug('human_pair_skipped_absent_socket', {
          userA: rankedDebugUser(userAId),
          userB: rankedDebugUser(userBId),
          userAPresent,
          userBPresent,
        });
        const absentUserIds = [
          userAPresent ? null : userAId,
          userBPresent ? null : userBId,
        ].filter((id): id is string => Boolean(id));
        const presentUserIds = [
          userAPresent ? userAId : null,
          userBPresent ? userBId : null,
        ].filter((id): id is string => Boolean(id));
        for (const absentId of absentUserIds) {
          const searchId = await bestEffortCancelRankedQueueSearch(
            absentId,
            'ranked_human_pair_absent_socket'
          );
          trackRankedQueueLeft({
            userId: absentId,
            source: 'server_abort',
            searchFound: Boolean(searchId),
            searchId,
          });
          io.to(`user:${absentId}`).emit('ranked:queue_left');
          await userSessionGuardService.emitState(io, absentId);
        }
        for (const presentId of presentUserIds) {
          await requeueRankedSearch(io, presentId);
        }
        span.setAttribute('quizball.skipped_absent_socket', true);
        return true;
      };

      if (await abortIfMissingLiveSocket()) return;

      const usersById = await usersRepo.getByIds([userAId, userBId]);
      const userA = usersById.get(userAId) ?? null;
      const userB = usersById.get(userBId) ?? null;
      if (!userA || !userB) {
        const missingUserIds = [userA ? null : userAId, userB ? null : userBId]
          .filter((userId): userId is string => Boolean(userId));
        logger.warn({ userAId, userBId, missingUserIds }, 'Ranked pairing skipped: user missing');
        rankedDebug('human_pair_skipped_missing_user', {
          userA: rankedDebugUser(userAId),
          userB: rankedDebugUser(userBId),
        });
        await Promise.all(
          missingUserIds.map((userId) => handleStaleRankedQueueUser(io, userId, 'ranked_human_pair_user_lookup'))
        );
        span.setAttribute('quizball.skipped_missing_user', true);
        return;
      }

      const profilesByUserId = await rankedService.ensureProfiles([userAId, userBId]);
      const profileA = profilesByUserId.get(userAId);
      const profileB = profilesByUserId.get(userBId);
      if (!profileA || !profileB) {
        throw new Error('Ranked profile batch did not return both paired users');
      }
      const wallets = await getRankedTicketWallets([userAId, userBId]);
      const insufficientUserIds = [userAId, userBId].filter((userId) => (wallets[userId]?.tickets ?? 0) < 1);
      if (insufficientUserIds.length > 0) {
        logger.warn(
          {
            userAId,
            userBId,
            insufficientUserIds,
            wallets,
          },
          'Ranked human match creation skipped: insufficient tickets after pairing'
        );
        rankedDebug('human_pair_skipped_insufficient_tickets', {
          userA: rankedDebugUser(userAId),
          userB: rankedDebugUser(userBId),
          insufficientCount: insufficientUserIds.length,
        });
        for (const userId of [userAId, userBId].filter((id) => !insufficientUserIds.includes(id))) {
          trackRankedQueueLeft({
            userId,
            source: 'server_abort',
            searchFound: false,
            searchId: null,
          });
          io.to(`user:${userId}`).emit('ranked:queue_left');
        }
        for (const userId of insufficientUserIds) {
          emitInsufficientTickets(io, userId, 'ranked_human_pair_preflight', wallets[userId]?.tickets ?? 0);
        }
        await Promise.all([userSessionGuardService.emitState(io, userAId), userSessionGuardService.emitState(io, userBId)]);
        span.setAttribute('quizball.skipped_insufficient_tickets', true);
        return;
      }
      {
        const [userACancelled, userBCancelled] = await getCancelFlags();
        if (userACancelled || userBCancelled) {
          logger.info({ userAId, userBId, userACancelled, userBCancelled }, 'Ranked human match creation skipped because a player cancelled before lobby creation');
          rankedDebug('human_pair_skipped_cancelled_before_lobby', {
            userA: rankedDebugUser(userAId),
            userB: rankedDebugUser(userBId),
          });
          await releaseUncancelledUsers(userACancelled, userBCancelled);
          span.setAttribute('quizball.skipped_cancelled_before_lobby', true);
          return;
        }
      }

      const sessionBlocks = await getRankedMatchmakingSessionBlocks(
        [userAId, userBId],
        { ignorePairingInFlight: true }
      );
      const sessionBlockA = sessionBlocks.get(userAId) ?? null;
      const sessionBlockB = sessionBlocks.get(userBId) ?? null;
      if (sessionBlockA || sessionBlockB) {
        logger.warn(
          {
            userAId,
            userBId,
            userASession: sessionBlockA,
            userBSession: sessionBlockB,
          },
          'Ranked human match creation skipped because a player already has session state'
        );
        rankedDebug('human_pair_skipped_session_state', {
          userA: rankedDebugUser(userAId),
          userB: rankedDebugUser(userBId),
          userAState: sessionBlockA?.state ?? 'clear',
          userBState: sessionBlockB?.state ?? 'clear',
        });
        span.setAttribute('quizball.skipped_session_state', true);
        return;
      }

      if (await abortIfMissingLiveSocket()) return;

      const lobby = await lobbiesRepo.createLobby({
        mode: 'ranked',
        hostUserId: userAId,
        inviteCode: null,
      });

      span.setAttribute('quizball.lobby_id', lobby.id);

      await Promise.all([
        lobbiesRepo.addMember(lobby.id, userAId, true),
        lobbiesRepo.addMember(lobby.id, userBId, true),
        attachUserSocketsToLobby(io, userAId, lobby.id),
        attachUserSocketsToLobby(io, userBId, lobby.id),
      ]);

      const redis = getRedisClient();
      if (redis) {
        try {
          await Promise.all([
            redis.set(rankedAssignedLobbyKey(userAId), lobby.id, { EX: ASSIGNED_LOBBY_TTL_SEC }),
            redis.set(rankedAssignedLobbyKey(userBId), lobby.id, { EX: ASSIGNED_LOBBY_TTL_SEC }),
          ]);
        } catch (error) {
          // The lobby and both members have committed; marker telemetry must
          // not turn that successful handoff into a failed pair.
          logger.warn({ error, lobbyId: lobby.id, userAId, userBId }, 'Failed to mark ranked lobby assignment');
        }
      }

      // The lobby row, both committed members, user display data and rank
      // profiles are already in memory. Re-reading them here used to add four
      // sequential database stages (roughly eight queries) per pair and let the
      // matcher starve queue joins.
      emitCreatedRankedLobbyState(io, lobby, userA, userB, profileA, profileB);
      emitCreatedRankedSessionStates(io, lobby.id, [userAId, userBId]);

      const [formA, formB] = await Promise.all([
        statsService.getRecentFormForUser(userAId, 3).catch(() => [] as Array<'W' | 'L' | 'D'>),
        statsService.getRecentFormForUser(userBId, 3).catch(() => [] as Array<'W' | 'L' | 'D'>),
      ]);

      io.to(`user:${userAId}`).emit('ranked:match_found', {
        lobbyId: lobby.id,
        myRecentForm: formA,
        opponent: {
          id: userB.id,
          username: userB.nickname ?? 'Player',
          avatarUrl: userB.avatar_url,
          avatarCustomization: parseStoredAvatarCustomization(userB.avatar_customization),
          favoriteClub: userB.favorite_club ?? null,
          recentForm: formB,
          rp: profileB.rp,
          ...countryPayload(sessionCountries?.userB ?? userB.country),
        },
      });
      io.to(`user:${userBId}`).emit('ranked:match_found', {
        lobbyId: lobby.id,
        myRecentForm: formB,
        opponent: {
          id: userA.id,
          username: userA.nickname ?? 'Player',
          avatarUrl: userA.avatar_url,
          avatarCustomization: parseStoredAvatarCustomization(userA.avatar_customization),
          favoriteClub: userA.favorite_club ?? null,
          recentForm: formA,
          rp: profileA.rp,
          ...countryPayload(sessionCountries?.userA ?? userA.country),
        },
      });

      logger.debug({ lobbyId: lobby.id, userAId, userBId }, 'Ranked human match found');
      rankedDebug('human_match_found', {
        userA: rankedDebugUser(userAId),
        userB: rankedDebugUser(userBId),
        lobby: lobby.id.slice(0, 8),
      });
      appMetrics.rankedHumanMatches.add(1);

      // Durable: the "match found" modal delay used to be an in-process
      // setTimeout — a restart in that 1.2s window left a ranked lobby stuck in
      // 'waiting' with no draft until a player reconnect happened to heal it.
      // The Redis-backed timer survives restarts; runRankedDraftStart re-checks
      // cancel flags and lobby state so a late/duplicate fire is a no-op.
      // If the Redis enqueue itself throws (scheduleRealtimeTimer only handles
      // a CLOSED client, not a failing write), fall back to the old in-process
      // timer — a non-durable draft start beats a stranded waiting lobby.
      try {
        await scheduleRealtimeTimer(
          'ranked_draft_start',
          lobby.id,
          new Date(Date.now() + FOUND_MODAL_MS),
          { kind: 'ranked_draft_start', lobbyId: lobby.id, userAId, userBId }
        );
      } catch (err) {
        logger.error(
          { err, lobbyId: lobby.id, userAId, userBId },
          'Failed to schedule durable ranked draft start; using local fallback'
        );
        const fallback = setTimeout(() => {
          void runRankedDraftStart(io, lobby.id, userAId, userBId).catch((error) => {
            logger.error({ error, lobbyId: lobby.id }, 'Local ranked draft-start fallback failed');
          });
        }, FOUND_MODAL_MS);
        fallback.unref?.();
      }
    } finally {
      await clearPairingInFlight([userAId, userBId]);
    }
  });
}

/**
 * Start the draft for a freshly paired ranked lobby (fired by the durable
 * `ranked_draft_start` timer ~1.2s after `ranked:match_found`). Re-checks the
 * cancel flags and the lobby state so a late or duplicate fire is a no-op —
 * identical guards to the previous in-process setTimeout, but restart-proof.
 */
export async function runRankedDraftStart(
  io: QuizballServer,
  lobbyId: string,
  userAId: string,
  userBId: string
): Promise<void> {
  const redis = getRedisClient();
  if (redis) {
    const [userACancelled, userBCancelled] = await Promise.all([
      redis.get(rankedCancelKey(userAId)),
      redis.get(rankedCancelKey(userBId)),
    ]);
    if (userACancelled || userBCancelled) {
      logger.info(
        { lobbyId, userAId, userBId },
        'Ranked human draft start skipped because a player cancelled search'
      );
      return;
    }
  }
  const latest = await lobbiesRepo.getById(lobbyId);
  if (!latest || latest.status !== 'waiting' || latest.mode !== 'ranked') return;
  try {
    await startDraft(io, lobbyId);
  } catch (error) {
    // The durable timer scheduler will requeue transient admission pressure.
    // Treating this as a terminal match-preparation failure strands a valid,
    // committed lobby and forces both players to restart matchmaking.
    if (error instanceof DbOverloadedError) throw error;
    // Keep the crash guard from the previous in-process timer path: a draft
    // start failure must notify both players and never become an unhandled
    // rejection from the durable scheduler.
    logger.error({ error, lobbyId, userAId, userBId }, 'Failed to start ranked human draft');
    for (const userId of [userAId, userBId]) {
      io.to(`user:${userId}`).emit('error', {
        code: 'MATCH_PREPARATION_FAILED',
        message: 'Match preparation got stuck. Please restart ranked matchmaking.',
        meta: { lobbyId, source: 'ranked_human_draft_start' },
      });
    }
    await Promise.allSettled([
      userSessionGuardService.emitState(io, userAId),
      userSessionGuardService.emitState(io, userBId),
    ]);
  }
}

async function startAiFallbackWithCountry(
  io: QuizballServer,
  userId: string,
  playerCountryCode: string | null | undefined,
  claimedSearchId?: string,
): Promise<void> {
  await withSpan('ranked.fallback_to_ai', {
    'quizball.user_id': userId,
  }, async () => {
    const redis = getRedisClient();
    if (redis && await redis.get(rankedCancelKey(userId))) {
      logger.info({ userId }, 'Ranked matchmaking fallback skipped because user cancelled search');
      rankedDebug('fallback_skipped_cancelled', {
        user: rankedDebugUser(userId),
      });
      return;
    }
    const sessionBlock = await getRankedMatchmakingSessionBlock(userId);
    if (sessionBlock) {
      logger.warn(
        { userId, session: sessionBlock },
        'Ranked matchmaking fallback skipped because user already has session state'
      );
      rankedDebug('fallback_skipped_session_state', {
        user: rankedDebugUser(userId),
        state: sessionBlock.state,
      });
      return;
    }
    if (!await hasLiveAuthenticatedSocket(io, userId)) {
      // The claim script already removed this search from the queue, timeouts
      // and user map, so there is nothing left to cancel — and a userId-based
      // cancel (or the ranked:mm:cancel marker) would hit a NEW search if the
      // user re-queues in this window.
      trackRankedQueueLeft({
        userId,
        source: 'server_abort',
        searchFound: Boolean(claimedSearchId),
        searchId: claimedSearchId ?? null,
      });
      io.to(`user:${userId}`).emit('ranked:queue_left');
      await userSessionGuardService.emitState(io, userId);
      logger.warn({ userId }, 'Ranked matchmaking fallback skipped: queued user has no live socket');
      rankedDebug('fallback_skipped_absent_socket', {
        user: rankedDebugUser(userId),
      });
      return;
    }
    if (!await hasTicketForRankedQueue(io, userId, 'ranked_ai_fallback_preflight')) {
      return;
    }
    await startRankedAiForUser(io, userId, {
      skipSearchEmit: true,
      ...(playerCountryCode ? { playerCountryCode } : {}),
    });
    logger.info({ userId }, 'Ranked matchmaking fallback to AI');
    rankedDebug('fallback_to_ai', {
      user: rankedDebugUser(userId),
    });
    appMetrics.rankedAiFallbacks.add(1);
  });
}

async function processFallbacks(io: QuizballServer): Promise<void> {
  await withSpan('ranked.process_fallbacks', {}, async (span) => {
    const redis = getRedisClient();
    if (!redis) {
      span.setAttribute('quizball.redis_available', false);
      return;
    }

    const now = Date.now();
    const due = await redis.zRangeByScore(RANKED_MM_TIMEOUTS_KEY, 0, now, {
      LIMIT: { offset: 0, count: MAX_FALLBACKS_PER_TICK },
    });
    span.setAttribute('quizball.due_search_count', due.length);

    let fallbackCount = 0;
    let fallbackFailureCount = 0;
    for (const searchId of due) {
      const resultRaw = await redis.eval(RANKED_MM_CLAIM_FALLBACK_SCRIPT, {
        keys: [RANKED_MM_QUEUE_KEY, RANKED_MM_TIMEOUTS_KEY, RANKED_MM_USER_MAP_KEY, rankedSearchKey(searchId)],
        arguments: [searchId, String(now), String(now)],
      });
      const result = toStringArray(resultRaw);
      const userId = result[0];
      if (!userId) continue;
      const countryCode = result[1] || null;
      fallbackCount += 1;
      try {
        await startAiFallbackWithCountry(io, userId, countryCode, searchId);
      } catch (error) {
        fallbackFailureCount += 1;
        logger.error(
          { err: error, searchId, userId },
          'Ranked matchmaking fallback failed for queued user'
        );
      }
    }
    span.setAttribute('quizball.fallback_count', fallbackCount);
    span.setAttribute('quizball.fallback_failure_count', fallbackFailureCount);
  });
}

async function processPairs(io: QuizballServer): Promise<void> {
  await withSpan('ranked.process_pairs', {}, async (span) => {
    const redis = getRedisClient();
    if (!redis) {
      span.setAttribute('quizball.redis_available', false);
      return;
    }

    type ClaimedPair = {
      searchIdA: string;
      searchIdB: string;
      userAId: string;
      userBId: string;
      userACountryCode: string | null;
      userBCountryCode: string | null;
    };

    let pairCount = 0;
    let pairFailureCount = 0;
    const activeStarts = new Set<Promise<void>>();
    const startClaimedPair = (pair: ClaimedPair): void => {
      const start = (async () => {
        try {
          await startHumanRankedMatch(io, pair.userAId, pair.userBId, {
            userA: pair.userACountryCode,
            userB: pair.userBCountryCode,
          });
        } catch (error) {
          pairFailureCount += 1;
          logger.error(
            {
              err: error,
              searchIdA: pair.searchIdA,
              searchIdB: pair.searchIdB,
              userAId: pair.userAId,
              userBId: pair.userBId,
            },
            'Ranked matchmaking pair failed for queued users'
          );
        }
      })();
      activeStarts.add(start);
      void start.finally(() => activeStarts.delete(start));
    };

    try {
      for (let i = 0; i < MAX_PAIRS_PER_TICK; i += 1) {
        if (activeStarts.size >= MAX_CONCURRENT_PAIR_STARTS) {
          await Promise.race(activeStarts);
        }
        const resultRaw = await redis.eval(RANKED_MM_PAIR_TWO_RANDOM_SCRIPT, {
          keys: [RANKED_MM_QUEUE_KEY, RANKED_MM_TIMEOUTS_KEY, RANKED_MM_USER_MAP_KEY],
          arguments: [
            RANKED_MM_SEARCH_KEY_PREFIX,
            String(Date.now()),
            RANKED_MM_PAIRING_IN_FLIGHT_KEY_PREFIX,
            String(PAIRING_IN_FLIGHT_TTL_SEC),
          ],
        });
        const result = toStringArray(resultRaw);
        // The Lua script removed an expired/mismapped queue member. Keep scanning
        // in this same tick instead of letting one orphan throttle matchmaking to
        // one cleanup per 100ms.
        if (result[0] === RANKED_MM_STALE_RESULT) continue;
        if (result.length < 4) break;

        const searchIdA = result[0];
        const userAId = result[1];
        const hasCountryCodes = result.length >= 6;
        const userACountryCode = hasCountryCodes ? result[2] || null : null;
        const searchIdB = hasCountryCodes ? result[3] : result[2];
        const userBId = hasCountryCodes ? result[4] : result[3];
        const userBCountryCode = hasCountryCodes ? result[5] || null : null;
        if (!userAId || !userBId) break;
        pairCount += 1;
        const pair: ClaimedPair = {
          searchIdA,
          searchIdB,
          userAId,
          userBId,
          userACountryCode,
          userBCountryCode,
        };
        rankedDebug('pair_claimed_two_users', {
          userA: rankedDebugUser(userAId),
          userB: rankedDebugUser(userBId),
          searchA: searchIdA.slice(0, 8),
          searchB: searchIdB.slice(0, 8),
        });
        startClaimedPair(pair);
      }
    } finally {
      // A later Redis claim may fail after earlier users were already removed
      // from the queue. Always drain every successful claim before surfacing
      // that failure so claimed players are never silently stranded.
      await Promise.all(activeStarts);
    }
    span.setAttribute('quizball.pair_count', pairCount);
    span.setAttribute('quizball.pair_failure_count', pairFailureCount);
  });
}

async function rankedTick(): Promise<void> {
  try {
    await withSpan('ranked.tick', {}, async (span) => {
      const io = loopIo;
      if (!io) {
        span.setAttribute('quizball.loop_active', false);
        return;
      }

      const redis = getRedisClient();
      if (!redis) {
        span.setAttribute('quizball.redis_available', false);
        return;
      }

      // Each replica runs one local tick. Cross-replica exclusion is
      // intentionally delegated to the atomic Redis claim scripts: a global
      // tick lock made one Railway replica build every lobby while the other
      // sat idle, halving throughput and concentrating DB admission pressure.

      let phaseFailureCount = 0;
      try {
        await processFallbacks(io);
      } catch (error) {
        phaseFailureCount += 1;
        span.setAttribute('quizball.fallback_phase_failed', true);
        logger.error({ err: error }, 'Ranked matchmaking fallback phase failed');
      }

      try {
        await processPairs(io);
      } catch (error) {
        phaseFailureCount += 1;
        span.setAttribute('quizball.pair_phase_failed', true);
        logger.error({ err: error }, 'Ranked matchmaking pair phase failed');
      }

      span.setAttribute('quizball.phase_failure_count', phaseFailureCount);
    });
  } catch (error) {
    logger.error({ err: error }, 'Ranked matchmaking tick failed outside guarded section');
  }
}

export const rankedMatchmakingService = {
  start(io: QuizballServer): void {
    if (loopTimer || !config.RANKED_HUMAN_QUEUE_ENABLED) return;
    loopIo = io;
    loopTimer = setInterval(() => {
      if (tickInFlight) return;
      tickInFlight = true;
      void rankedTick()
        .catch((error) => {
          logger.error({ err: error }, 'Ranked matchmaking tick rejected unexpectedly');
        })
        .finally(() => {
          tickInFlight = false;
        });
    }, TICK_INTERVAL_MS);
    logger.info('Ranked matchmaking loop started');
  },

  stop(): void {
    if (!loopTimer) return;
    clearInterval(loopTimer);
    loopTimer = null;
    loopIo = null;
    logger.info('Ranked matchmaking loop stopped');
  },

  async handleQueueJoin(
    io: QuizballServer,
    socket: QuizballSocket,
    payload?: {
      searchMode?: 'human_first';
      source?: 'mode_select' | 'play_again' | 'retry' | 'recovery' | 'unknown';
      reason?: 'initial' | 'retry' | 'recovery_retry';
      clientRequestId?: string;
    }
  ): Promise<void> {
    const userId = socket.data.user.id;
    const queueClientContext = {
      source: payload?.source ?? 'unknown',
      clientReason: payload?.reason ?? 'initial',
      clientRequestId: payload?.clientRequestId ?? null,
      socketId: socket.id,
    };
    await withSpan('ranked.queue_join', {
      'quizball.user_id': userId,
      'quizball.client_source': queueClientContext.source,
      'quizball.client_reason': queueClientContext.clientReason,
      'quizball.client_request_id': queueClientContext.clientRequestId ?? '',
    }, async (span) => {
      logger.debug(
        { userId, ...queueClientContext, searchMode: payload?.searchMode ?? 'human_first' },
        'Ranked queue join requested'
      );
      rankedDebug('queue_join_start', {
        user: rankedDebugUser(userId),
        socket: socket.id,
        connected: socket.connected,
        source: queueClientContext.source,
        reason: queueClientContext.clientReason,
      });
      appMetrics.rankedQueueJoins.add(1);

      // ORDER MATTERS: check whether the user already has session state
      // (active match / lobby / draft / in-flight pairing) BEFORE the ticket
      // preflight. A reload mid-draft restores the client into "searching"
      // and re-emits queue_join, but the ticket was already consumed when the
      // draft completed — preflighting first emitted a spurious
      // INSUFFICIENT_TICKETS error (+ ranked:queue_left) on top of a match
      // that was starting fine (staging 2026-06-10). With a session block we
      // re-emit authoritative state and let the rejoin flow own the UX.
      // (A bare queueSearchId is NOT handled here: the debounce/resume logic
      // below re-emits the search with the correct REMAINING duration.)
      const earlySessionBlock = await getRankedMatchmakingSessionBlock(userId);
      if (
        earlySessionBlock &&
        (earlySessionBlock.activeMatchId ||
          earlySessionBlock.waitingLobbyId ||
          earlySessionBlock.state === 'PAIRING_IN_FLIGHT' ||
          earlySessionBlock.state === 'CORRUPT_MULTI_STATE')
      ) {
        logger.info(
          { userId, ...earlySessionBlock },
          'Ranked queue join ignored: user already has session state'
        );
        rankedDebug('queue_join_ignored_existing_session', {
          user: rankedDebugUser(userId),
          state: earlySessionBlock.state,
          activeMatch: earlySessionBlock.activeMatchId ? earlySessionBlock.activeMatchId.slice(0, 8) : 'none',
          waitingLobby: earlySessionBlock.waitingLobbyId ? earlySessionBlock.waitingLobbyId.slice(0, 8) : 'none',
          queueSearch: earlySessionBlock.queueSearchId ? earlySessionBlock.queueSearchId.slice(0, 8) : 'none',
        });
        span.setAttribute('quizball.queue_block_reason', `EXISTING_${earlySessionBlock.state}`);
        trackRankedQueueJoinIgnored({
          userId,
          reason: 'existing_session',
          ...queueClientContext,
          sessionState: earlySessionBlock.state,
          activeMatchId: earlySessionBlock.activeMatchId,
          waitingLobbyId: earlySessionBlock.waitingLobbyId,
          queueSearchId: earlySessionBlock.queueSearchId,
        });
        await userSessionGuardService.emitState(io, userId);
        return;
      }

      if (!await hasTicketForRankedQueue(io, userId, 'ranked_queue_join_preflight')) {
        span.setAttribute('quizball.queue_block_reason', 'INSUFFICIENT_TICKETS');
        trackRankedQueueJoinIgnored({
          userId,
          reason: 'insufficient_tickets',
          ...queueClientContext,
        });
        return;
      }

      const redis = getRedisClient();
      if (redis) {
        // Reaching a fresh queue join proves any previous assignment is no
        // longer the user's authoritative session. Clear the disconnect guard
        // so a later disconnect from this new search is cleaned normally.
        await redis.del(rankedAssignedLobbyKey(userId));
      }
      const ignoreRecentLeave = async (): Promise<void> => {
        logger.info(
          { userId, ...queueClientContext, leaveGuardTtlSec: LEAVE_GUARD_TTL_SEC },
          'Ranked queue join ignored: recent queue leave guard is active'
        );
        rankedDebug('queue_join_ignored_recent_leave', {
          user: rankedDebugUser(userId),
          source: queueClientContext.source,
          reason: queueClientContext.clientReason,
        });
        span.setAttribute('quizball.queue_block_reason', 'RECENT_QUEUE_LEAVE');
        trackRankedQueueJoinIgnored({
          userId,
          reason: 'recent_queue_leave',
          ...queueClientContext,
        });
        socket.emit('ranked:queue_left');
        await userSessionGuardService.emitState(io, userId);
        return;
      };

      if (redis && await redis.exists(rankedLeaveGuardKey(userId))) {
        await ignoreRecentLeave();
        return;
      }

      if (!config.RANKED_HUMAN_QUEUE_ENABLED) {
        logger.info({ userId }, 'Ranked human queue disabled, routing to AI');
        rankedDebug('queue_join_ai_only', {
          user: rankedDebugUser(userId),
        });
        span.setAttribute('quizball.queue_mode', 'ai_only');
        if (redis) {
          await redis.del(rankedCancelKey(userId));
        }
        await startRankedAiForUser(io, userId, {
          ...(socket.data.currentCountry ? { playerCountryCode: socket.data.currentCountry } : {}),
        });
        return;
      }

      if (!redis) {
        logger.warn({ userId }, 'Redis unavailable for ranked queue join, falling back to AI');
        rankedDebug('queue_join_redis_unavailable', {
          user: rankedDebugUser(userId),
        });
        span.setAttribute('quizball.queue_fallback', 'redis_unavailable');
        await startRankedAiForUser(io, userId, {
          ...(socket.data.currentCountry ? { playerCountryCode: socket.data.currentCountry } : {}),
        });
        return;
      }

      const debounceResult = await redis.set(
        rankedJoinDebounceKey(userId),
        '1',
        { NX: true, EX: JOIN_DEBOUNCE_TTL_SEC }
      );
      if (debounceResult !== 'OK') {
        span.setAttribute('quizball.queue_join_debounced', true);
        const existingSearchId = await redis.hGet(RANKED_MM_USER_MAP_KEY, userId);
        if (existingSearchId) {
          const existing = await redis.hGetAll(rankedSearchKey(existingSearchId));
          if (existing.status === 'queued') {
            const now = Date.now();
            const parsedDeadline = Number(existing.deadlineAt);
            const remainingMs = existing.deadlineAt && Number.isFinite(parsedDeadline) && parsedDeadline > 0
              ? Math.max(0, parsedDeadline - now)
              : SEARCH_DURATION_MS;
            io.to(`user:${userId}`).emit('ranked:search_started', { durationMs: remainingMs || SEARCH_DURATION_MS });
            await userSessionGuardService.emitState(io, userId);
            logger.info(
              { userId, searchId: existingSearchId, remainingMs },
              'Ranked queue join debounced and resumed existing queue'
            );
            rankedDebug('queue_join_debounced_resumed_existing', {
              user: rankedDebugUser(userId),
              search: existingSearchId.slice(0, 8),
              remainingMs,
            });
            return;
          }
        }
        logger.info({ userId }, 'Ranked queue join debounced while transition is in progress');
        rankedDebug('queue_join_debounced', {
          user: rankedDebugUser(userId),
        });
        return;
      }

      const completed = await userSessionGuardService.runWithUserTransitionLock(
        io,
        socket,
        async () => {
          if (await redis.exists(rankedLeaveGuardKey(userId))) {
            await redis.del(rankedJoinDebounceKey(userId));
            await ignoreRecentLeave();
            return;
          }

          const prepared = await userSessionGuardService.prepareForQueueJoin(io, userId);
          logger.info(
            {
              userId,
              state: prepared.snapshot.state,
              activeMatchId: prepared.snapshot.activeMatchId,
              waitingLobbyId: prepared.snapshot.waitingLobbyId,
              queueSearchId: prepared.snapshot.queueSearchId,
            },
            'Ranked queue join session prepared'
          );
          span.setAttributes({
            'quizball.session_state': prepared.snapshot.state,
            'quizball.active_match_id': prepared.snapshot.activeMatchId ?? '',
            'quizball.waiting_lobby_id': prepared.snapshot.waitingLobbyId ?? '',
          });
          if (!prepared.ok) {
            logger.warn(
              {
                userId,
                reason: prepared.reason ?? 'ACTIVE_MATCH',
                state: prepared.snapshot.state,
                activeMatchId: prepared.snapshot.activeMatchId,
                waitingLobbyId: prepared.snapshot.waitingLobbyId,
                queueSearchId: prepared.snapshot.queueSearchId,
              },
              'Ranked queue join blocked by session state'
            );
            rankedDebug('queue_join_blocked_session_state', {
              user: rankedDebugUser(userId),
              reason: prepared.reason ?? 'ACTIVE_MATCH',
              state: prepared.snapshot.state,
              queueSearch: prepared.snapshot.queueSearchId ? prepared.snapshot.queueSearchId.slice(0, 8) : 'none',
              waitingLobby: prepared.snapshot.waitingLobbyId ? prepared.snapshot.waitingLobbyId.slice(0, 8) : 'none',
              activeMatch: prepared.snapshot.activeMatchId ? prepared.snapshot.activeMatchId.slice(0, 8) : 'none',
            });
            span.setAttribute('quizball.queue_block_reason', prepared.reason ?? 'ACTIVE_MATCH');
            userSessionGuardService.emitBlocked(socket, {
              reason: prepared.reason ?? 'ACTIVE_MATCH',
              message: prepared.message ?? 'You are already in an active match',
              stateSnapshot: prepared.snapshot,
            });
            socket.emit('error', {
              code: 'RANKED_QUEUE_BLOCKED',
              message: prepared.message ?? 'You are already in an active match',
              meta: { stateSnapshot: prepared.snapshot },
            });
            return;
          }

          await redis.del(rankedCancelKey(userId));

          const now = Date.now();
          // Larger fast value (1s) than the per-round default: a too-tight queue
          // deadline can expire before the search hash is consistent, so the
          // fallback claim no-ops and the match never starts.
          const deadlineAt = now + harnessDelayMs(SEARCH_DURATION_MS, 1000);
          const existingSearchId = await redis.hGet(RANKED_MM_USER_MAP_KEY, userId);
          if (existingSearchId) {
            const existing = await redis.hGetAll(rankedSearchKey(existingSearchId));
            if (existing.status === 'queued') {
              // Validate and parse deadlineAt defensively
              const parsedDeadline = Number(existing.deadlineAt);
              let remainingMs: number;

              if (!existing.deadlineAt || !Number.isFinite(parsedDeadline) || parsedDeadline <= 0) {
                // Invalid or missing deadlineAt - fallback to full duration
                logger.warn(
                  {
                    userId,
                    searchId: existingSearchId,
                    invalidDeadlineAt: existing.deadlineAt ?? null,
                    queuedAt: existing.queuedAt ?? null,
                  },
                  'Ranked queue resume found invalid deadlineAt, using fallback duration'
                );
                remainingMs = SEARCH_DURATION_MS;
              } else {
                remainingMs = Math.max(0, parsedDeadline - now);
              }

              logger.info(
                {
                  userId,
                  searchId: existingSearchId,
                  remainingMs,
                  queuedAt: existing.queuedAt ?? null,
                  deadlineAt: existing.deadlineAt ?? null,
                },
                'Ranked queue join resumed existing queue'
              );
              rankedDebug('queue_join_resumed_existing', {
                user: rankedDebugUser(userId),
                search: existingSearchId.slice(0, 8),
                remainingMs,
              });
              io.to(`user:${userId}`).emit('ranked:search_started', { durationMs: remainingMs || SEARCH_DURATION_MS });
              const snapshot = emitQueuedSessionState(io, userId, prepared.snapshot, existingSearchId);
              logger.info(
                {
                  userId,
                  state: snapshot.state,
                  queueSearchId: snapshot.queueSearchId,
                  activeMatchId: snapshot.activeMatchId,
                  waitingLobbyId: snapshot.waitingLobbyId,
                },
                'Ranked queue state emitted after resume'
              );
              return;
            }
            logger.warn(
              {
                userId,
                searchId: existingSearchId,
                status: existing.status ?? null,
              },
              'Ranked queue join found stale user-map search id'
            );
            rankedDebug('queue_join_stale_user_map', {
              user: rankedDebugUser(userId),
              search: existingSearchId.slice(0, 8),
              status: existing.status ?? 'none',
            });
            await redis.hDel(RANKED_MM_USER_MAP_KEY, userId);
          }

          const newSearchId = randomUUID();
          const searchFields: Record<string, string> = {
            userId,
            status: 'queued',
            queuedAt: String(now),
            deadlineAt: String(deadlineAt),
          };
          if (socket.data.currentCountry) {
            searchFields.countryCode = socket.data.currentCountry;
          }

          const multiResult = await redis
            .multi()
            .hSet(rankedSearchKey(newSearchId), searchFields)
            .expire(rankedSearchKey(newSearchId), SEARCH_KEY_TTL_SEC)
            .zAdd(RANKED_MM_QUEUE_KEY, { score: now, value: newSearchId })
            .zAdd(RANKED_MM_TIMEOUTS_KEY, { score: deadlineAt, value: newSearchId })
            .hSet(RANKED_MM_USER_MAP_KEY, userId, newSearchId)
            .exec();

          if (!multiResult) {
            logger.error({ userId }, 'Ranked queue join failed: Redis multi returned null');
            socket.emit('error', {
              code: 'RANKED_QUEUE_UNAVAILABLE',
              message: 'Ranked queue is unavailable, please retry',
            });
            return;
          }

          io.to(`user:${userId}`).emit('ranked:search_started', { durationMs: SEARCH_DURATION_MS });
          let queueSize: number | null = null;
          try {
            queueSize = await redis.zCard(RANKED_MM_QUEUE_KEY);
            span.setAttribute('quizball.queue_size', queueSize);
          } catch (error) {
            // The search is already committed and acknowledged. Telemetry must
            // never turn a successful queue join into a client-visible error.
            logger.warn({ err: error, userId, searchId: newSearchId }, 'Failed to read ranked queue size after join');
          }
          logger.debug(
            { userId, searchId: newSearchId, queueSize, ...queueClientContext },
            'User joined ranked queue'
          );
          trackRankedQueueJoined(userId, 0, {
            ...queueClientContext,
            searchId: newSearchId,
            queueSize,
          });
          rankedDebug('queue_enqueued', {
            user: rankedDebugUser(userId),
            search: newSearchId.slice(0, 8),
            queueSize,
            durationMs: SEARCH_DURATION_MS,
          });
          const snapshot = emitQueuedSessionState(io, userId, prepared.snapshot, newSearchId);
          logger.debug(
            {
              userId,
              state: snapshot.state,
              queueSearchId: snapshot.queueSearchId,
              activeMatchId: snapshot.activeMatchId,
              waitingLobbyId: snapshot.waitingLobbyId,
            },
            'Ranked queue state emitted after join'
          );
        },
        {
          code: 'RANKED_QUEUE_BUSY',
          message: 'Session transition is in progress. Please retry.',
          operation: 'ranked:queue_join',
        }
      );
      if (!completed) {
        logger.warn({ userId, ...queueClientContext }, 'Ranked queue join transition lock not acquired');
        rankedDebug('queue_join_lock_not_acquired', {
          user: rankedDebugUser(userId),
        });
        span.setAttribute('quizball.transition_lock_acquired', false);
        trackRankedQueueJoinIgnored({
          userId,
          reason: 'transition_lock_busy',
          ...queueClientContext,
        });
        return;
      }
      span.setAttribute('quizball.transition_lock_acquired', true);
    });
  },

  async handleQueueLeave(io: QuizballServer, socket: QuizballSocket): Promise<void> {
    const userId = socket.data.user.id;
    await withSpan('ranked.queue_leave', {
      'quizball.user_id': userId,
    }, async (span) => {
      appMetrics.rankedQueueLeaves.add(1);
      const redis = getRedisClient();
      if (!redis) {
        span.setAttribute('quizball.redis_available', false);
        return;
      }

      // A late explicit queue-leave after match_found must not cancel a lobby
      // that has already been committed on another replica.
      const assignedLobbyId = await redis.get(rankedAssignedLobbyKey(userId));
      if (assignedLobbyId) {
        span.setAttribute('quizball.skipped_due_to_assigned_lobby', true);
        return;
      }

      const completed = await userSessionGuardService.runWithUserTransitionLock(
        io,
        socket,
        async () => {
          await redis.set(rankedCancelKey(userId), '1', { EX: CANCEL_KEY_TTL_SEC });
          // Set the leave guard even if the cancel script finds no search: the
          // search may already be claimed by pairing, and this guard suppresses
          // the stale client queue_join that can arrive right after Cancel.
          await redis.set(rankedLeaveGuardKey(userId), String(Date.now()), { EX: LEAVE_GUARD_TTL_SEC });
          logger.info(
            { userId, cancelKeyTtlSec: CANCEL_KEY_TTL_SEC, leaveGuardTtlSec: LEAVE_GUARD_TTL_SEC },
            'Ranked queue leave guard set'
          );
          const resultRaw = await redis.eval(RANKED_MM_CANCEL_SEARCH_SCRIPT, {
            keys: [RANKED_MM_QUEUE_KEY, RANKED_MM_TIMEOUTS_KEY, RANKED_MM_USER_MAP_KEY],
            arguments: [RANKED_MM_SEARCH_KEY_PREFIX, userId, String(Date.now())],
          });
          const result = toStringArray(resultRaw);
          span.setAttribute('quizball.queue_search_found', result.length > 0);
          trackRankedQueueLeft({
            userId,
            source: 'explicit_leave',
            searchFound: result.length > 0,
            searchId: result[0] ?? null,
          });
          if (result.length > 0) {
            logger.info({ userId, searchId: result[0] }, 'User left ranked queue');
            rankedDebug('queue_leave_removed_search', {
              user: rankedDebugUser(userId),
              search: result[0].slice(0, 8),
            });
          } else {
            logger.info({ userId }, 'Ranked queue leave requested but no active search found');
            rankedDebug('queue_leave_no_active_search', {
              user: rankedDebugUser(userId),
            });
          }

          socket.emit('ranked:queue_left');
          const snapshot = await userSessionGuardService.cleanupRankedQueueArtifacts(io, userId);
          io.to(`user:${userId}`).emit('session:state', snapshot);
          logger.info(
            {
              userId,
              state: snapshot.state,
              queueSearchId: snapshot.queueSearchId,
              activeMatchId: snapshot.activeMatchId,
              waitingLobbyId: snapshot.waitingLobbyId,
            },
            'Ranked queue state emitted after leave'
          );
        },
        {
          code: 'RANKED_QUEUE_BUSY',
          message: 'Session transition is in progress. Please retry.',
          operation: 'ranked:queue_leave',
        }
      );
      span.setAttribute('quizball.transition_lock_acquired', completed);
    });
  },

	  async handleSocketDisconnect(io: QuizballServer, socket: QuizballSocket): Promise<void> {
	    const userId = socket.data.user.id;
	    await withSpan('ranked.disconnect_cleanup', {
	      'quizball.user_id': userId,
	    }, async (span) => {
	      if (socket.data.matchId || socket.data.lobbyId) {
	        span.setAttribute('quizball.skipped_due_to_active_session', true);
	        logger.debug(
	          {
	            userId,
	            matchId: socket.data.matchId ?? null,
	            lobbyId: socket.data.lobbyId ?? null,
	          },
	          'Ranked disconnect cleanup skipped for active match/lobby socket'
	        );
	        return;
	      }

      const redis = getRedisClient();
      if (!redis) {
        span.setAttribute('quizball.redis_available', false);
        return;
      }

      // Cross-replica Socket.IO room joins do not persistently mutate the
      // owning replica's socket.data. The committed Redis marker prevents the
      // remote socket's later disconnect from being mistaken for an active
      // queue search and triggering two session queries during mass cleanup.
      const assignedLobbyId = await redis.get(rankedAssignedLobbyKey(userId));
      if (assignedLobbyId) {
        span.setAttribute('quizball.skipped_due_to_assigned_lobby', true);
        return;
      }

      // Set the cancel marker BEFORE attempting the transition lock (it is
      // idempotent and re-set under the lock below). Previously the marker
      // was only written inside the lock callback — if the lock was busy at
      // the exact disconnect moment, NOTHING was written and the 10s AI
      // fallback could start a ranked match for an offline user. With the
      // marker down first, processPairs / startHumanRankedMatch / the AI
      // fallback all see the cancellation even if the scripted queue cleanup
      // below has to retry.
      await redis.set(rankedCancelKey(userId), '1', { EX: CANCEL_KEY_TTL_SEC });

      const runCleanup = () => userSessionGuardService.runWithUserTransitionLock(
        io,
        socket,
        async () => {
          // Mirror handleQueueLeave: refresh the cancel marker, then run the
          // removal script. If processPairs already claimed this user's
          // search, the script finds nothing to remove — the marker is then
          // the only way startHumanRankedMatch can learn the user is gone and
          // avoid creating a lobby for a socketless player.
          await redis.set(rankedCancelKey(userId), '1', { EX: CANCEL_KEY_TTL_SEC });
          const resultRaw = await redis.eval(RANKED_MM_CANCEL_SEARCH_SCRIPT, {
            keys: [RANKED_MM_QUEUE_KEY, RANKED_MM_TIMEOUTS_KEY, RANKED_MM_USER_MAP_KEY],
            arguments: [RANKED_MM_SEARCH_KEY_PREFIX, userId, String(Date.now())],
          });
          const result = toStringArray(resultRaw);
          span.setAttribute('quizball.queue_search_found', result.length > 0);
          trackRankedQueueLeft({
            userId,
            source: 'disconnect_cleanup',
            searchFound: result.length > 0,
            searchId: result[0] ?? null,
          });
          if (result.length > 0) {
            logger.info({ userId, searchId: result[0] }, 'Socket disconnect removed ranked queue search');
            rankedDebug('disconnect_removed_queue_search', {
              user: rankedDebugUser(userId),
              socket: socket.id,
              search: result[0].slice(0, 8),
            });
          } else {
            rankedDebug('disconnect_no_active_queue_search', {
              user: rankedDebugUser(userId),
              socket: socket.id,
            });
          }
        },
        {
          operation: 'ranked:disconnect_cleanup',
        }
      );

      // Bounded retry: a busy transition lock previously dropped the queue
      // cleanup entirely (no retry), stranding the search entry until its
      // 60s TTL. The cancel marker above already guards the dangerous race;
      // the retries make the queue state itself converge.
      let completed = await runCleanup();
      for (let attempt = 1; !completed && attempt < DISCONNECT_CLEANUP_LOCK_ATTEMPTS; attempt += 1) {
        await waitForMs(DISCONNECT_CLEANUP_LOCK_RETRY_DELAY_MS * attempt);
        completed = await runCleanup();
      }
      span.setAttribute('quizball.transition_lock_acquired', completed);
      if (!completed) {
        logger.warn(
          { userId, socketId: socket.id, attempts: DISCONNECT_CLEANUP_LOCK_ATTEMPTS },
          'Ranked disconnect cleanup abandoned after transition-lock retries (cancel marker already set)'
        );
        return;
      }
      const snapshot = await userSessionGuardService.emitState(io, userId);
      logger.debug(
        {
          userId,
          state: snapshot.state,
          queueSearchId: snapshot.queueSearchId,
          activeMatchId: snapshot.activeMatchId,
          waitingLobbyId: snapshot.waitingLobbyId,
        },
        'Ranked queue state emitted after disconnect cleanup'
      );
    });
  },
};
