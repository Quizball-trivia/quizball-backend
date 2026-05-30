import type { QuizballServer, QuizballSocket } from '../socket-server.js';
import { lobbiesRepo } from '../../modules/lobbies/lobbies.repo.js';
import { lobbiesService } from '../../modules/lobbies/lobbies.service.js';
import { matchesService } from '../../modules/matches/matches.service.js';
import { storeService } from '../../modules/store/store.service.js';
import { usersRepo } from '../../modules/users/users.repo.js';
import { beginMatchForLobby, matchRealtimeService } from './match-realtime.service.js';
import { logger } from '../../core/logger.js';
import { startDraft } from './lobby-realtime.service.js';
import { abortRankedDraftStartForTickets } from './lobby-draft-start.service.js';
import { rankedAiLobbyKey } from '../ai-ranked.constants.js';
import { getRedisClient } from '../redis.js';
import { cancelRealtimeTimer, hasPendingRealtimeTimer, scheduleRealtimeTimer } from '../realtime-timer-scheduler.js';

const AI_BAN_DELAY_MIN_MS = 700;
const AI_BAN_DELAY_MAX_MS = 1800;
const DRAFT_AUTO_BAN_MS = 16000;
const AI_LOBBY_KEY_TTL_SEC = 7200;
const DRAFT_DISCONNECT_GRACE_MS = 60000;
const DRAFT_DISCONNECT_TTL_SEC = 75;
const DRAFT_GRACE_TTL_SEC = 65;

function draftDisconnectKey(lobbyId: string, userId: string): string {
  return `draft:disconnect:${lobbyId}:${userId}`;
}

function draftPauseKey(lobbyId: string): string {
  return `draft:pause:${lobbyId}`;
}

function draftGraceKey(lobbyId: string): string {
  return `draft:grace:${lobbyId}`;
}

function draftAbsentAfterGraceKey(lobbyId: string, userId: string): string {
  return `draft:absent_after_grace:${lobbyId}:${userId}`;
}

async function startMatchFromDraft(
  io: QuizballServer,
  lobbyId: string,
  halfOneCategoryId: string
): Promise<string | null> {
  const lobby = await lobbiesRepo.getById(lobbyId);
  if (!lobby) return null;

  const members = await lobbiesRepo.listMembersWithUser(lobbyId);
  if (members.length !== 2) return null;

  let consumedRankedTicketUserIds: string[] = [];

  if (lobby.mode === 'ranked') {
    const aiUserId = await resolveRankedAiUserId(lobbyId, members);
    const ticketUserIds = members
      .filter((member) => member.user_id !== aiUserId)
      .map((member) => member.user_id);

    if (ticketUserIds.length > 0) {
      const consumedTickets = await storeService.consumeRankedTickets(ticketUserIds);
      if (!consumedTickets) {
        logger.warn(
          { lobbyId, ticketUserIds },
          'Ranked match creation aborted: insufficient tickets'
        );
        await abortRankedDraftStartForTickets(io, lobby, ticketUserIds);
        return null;
      }
      logger.info(
        { lobbyId, ticketUserIds, wallets: consumedTickets.wallets },
        'Ranked match creation consumed tickets'
      );
      consumedRankedTicketUserIds = ticketUserIds;
    }
  }

  io.to(`lobby:${lobbyId}`).emit('draft:complete', { halfOneCategoryId });
  logger.info({ lobbyId, halfOneCategoryId }, 'Draft complete');

  let result;
  try {
    result = await matchesService.createMatchFromLobby({
      lobbyId,
      mode: lobby.mode,
      variant: 'ranked_sim',
      hostUserId: lobby.host_user_id,
      categoryAId: halfOneCategoryId,
      categoryBId: null,
    });
  } catch (error) {
    if (consumedRankedTicketUserIds.length > 0) {
      try {
        const refund = await storeService.refundRankedTickets(consumedRankedTicketUserIds);
        logger.info(
          { lobbyId, ticketUserIds: consumedRankedTicketUserIds, wallets: refund.wallets },
          'Refunded ranked tickets after match creation failure'
        );
      } catch (refundError) {
        logger.error(
          {
            lobbyId,
            ticketUserIds: consumedRankedTicketUserIds,
            error: refundError instanceof Error ? refundError.message : refundError,
          },
          'Failed to refund ranked tickets after match creation failure'
        );
      }
    }
    logger.warn(
      { lobbyId, error: error instanceof Error ? error.message : error },
      'Failed to create match from draft; restarting draft'
    );
    await startDraft(io, lobbyId);
    return null;
  }

  const matchId = result.match.id;
  logger.info(
    { lobbyId, matchId, mode: lobby.mode, halfOneCategoryId },
    'Match created from draft'
  );
  await beginMatchForLobby(io, lobbyId, matchId);

  const redis = getRedisClient();
  if (redis) {
    const absentFlags = await Promise.all(
      members.map((member) => redis.exists(draftAbsentAfterGraceKey(lobbyId, member.user_id)))
    );
    for (let index = 0; index < members.length; index++) {
      if (!absentFlags[index]) continue;
      const member = members[index];
      logger.info(
        { lobbyId, matchId, userId: member.user_id },
        'Pausing newly-created match for player absent after draft grace'
      );
      await matchRealtimeService.pauseMatchForDisconnectedPlayer(io, matchId, member.user_id);
      await redis.del(draftAbsentAfterGraceKey(lobbyId, member.user_id));
    }
  }

  return matchId;
}

/**
 * Determine who should act next in the draft.
 * Expects bans from listLobbyCategoryBans, ordered by banned_at ASC (oldest first).
 * The most recent ban is at bans[bans.length - 1].
 */
function getNextActorId(
  members: Array<{ user_id: string }>,
  bans: Array<{ user_id: string }>,
  firstActorUserId: string
): string {
  if (bans.length === 0) return firstActorUserId;

  // Most recent ban is last in the array (ordered by banned_at ASC)
  const lastActor = bans[bans.length - 1]?.user_id;
  const other = members.find((member) => member.user_id !== lastActor)?.user_id;
  return other ?? firstActorUserId;
}

function getAiBanDelayMs(): number {
  return Math.floor(Math.random() * (AI_BAN_DELAY_MAX_MS - AI_BAN_DELAY_MIN_MS + 1)) + AI_BAN_DELAY_MIN_MS;
}

async function clearPendingAiBanTimer(lobbyId: string): Promise<void> {
  try {
    await cancelRealtimeTimer('draft_ai_ban', lobbyId);
  } catch (error) {
    logger.warn({ error, lobbyId }, 'Failed to cancel draft AI ban timer');
  }
}

async function clearPendingAutoBanTimer(lobbyId: string): Promise<void> {
  try {
    await cancelRealtimeTimer('draft_auto_ban', lobbyId);
  } catch (error) {
    logger.warn({ error, lobbyId }, 'Failed to cancel draft auto-ban timer');
  }
}

async function clearDraftTimers(lobbyId: string): Promise<void> {
  await Promise.all([
    clearPendingAiBanTimer(lobbyId),
    clearPendingAutoBanTimer(lobbyId),
  ]);
}

async function resolveRankedAiUserId(
  lobbyId: string,
  members: Array<{ user_id: string }>
): Promise<string | null> {
  const redis = getRedisClient();
  if (redis) {
    const aiUserId = await redis.get(rankedAiLobbyKey(lobbyId));
    if (aiUserId && members.some((member) => member.user_id === aiUserId)) {
      return aiUserId;
    }
  }

  const usersById = await usersRepo.getByIds(members.map((member) => member.user_id));
  const users = members.map((member) => ({
    userId: member.user_id,
    user: usersById.get(member.user_id) ?? null,
  }));
  const aiMember = users.find((entry) => entry.user?.is_ai);
  if (!aiMember) return null;

  if (redis) {
    await redis.set(rankedAiLobbyKey(lobbyId), aiMember.userId, { EX: AI_LOBBY_KEY_TTL_SEC });
  }
  return aiMember.userId;
}

function getFirstDraftActorId(
  members: Array<{ user_id: string }>,
  hostUserId: string,
  aiUserId: string | null
): string {
  if (!aiUserId) return hostUserId;
  return members.find((member) => member.user_id !== aiUserId)?.user_id ?? hostUserId;
}

async function completeDraftIfReady(io: QuizballServer, lobbyId: string): Promise<string | null> {
  const lobby = await lobbiesRepo.getById(lobbyId);
  if (!lobby || lobby.status !== 'active') {
    await clearDraftTimers(lobbyId);
    return null;
  }

  const categories = await lobbiesService.getLobbyCategories(lobbyId);
  const bans = await lobbiesRepo.listLobbyCategoryBans(lobbyId);
  if (bans.length < 2) return null;

  await clearDraftTimers(lobbyId);
  const bannedIds = new Set(bans.map((ban) => ban.category_id));
  const remaining = categories.filter((category) => !bannedIds.has(category.id));
  if (remaining.length !== 1) {
    logger.warn(
      {
        lobbyId,
        totalCategories: categories.length,
        bannedCount: bans.length,
        remainingCount: remaining.length,
        bannedCategoryIds: Array.from(bannedIds),
      },
      'Insufficient categories remaining after bans in draft'
    );
    return null;
  }

  const halfOneCategoryId = remaining[0].id;
  return startMatchFromDraft(io, lobbyId, halfOneCategoryId);
}

export function scheduleDraftAutoBan(_io: QuizballServer, lobbyId: string): void {
  void scheduleRealtimeTimer('draft_auto_ban', lobbyId, new Date(Date.now() + DRAFT_AUTO_BAN_MS), {
    kind: 'draft_auto_ban',
    lobbyId,
  }).catch((error) => {
    logger.error({ error, lobbyId, delayMs: DRAFT_AUTO_BAN_MS }, 'Failed to schedule draft auto-ban timer');
  });
  logger.debug({ lobbyId, delayMs: DRAFT_AUTO_BAN_MS }, 'Scheduled automatic draft ban fallback');
}

export async function runDraftAutoBan(io: QuizballServer, lobbyId: string): Promise<void> {
  try {
    const redis = getRedisClient();
    if (redis && await redis.exists(draftPauseKey(lobbyId))) {
      logger.info({ lobbyId }, 'Skipping draft auto-ban while draft is paused');
      return;
    }

    const lobby = await lobbiesRepo.getById(lobbyId);
    if (!lobby || lobby.status !== 'active') return;

    const [categories, bans, members] = await Promise.all([
      lobbiesService.getLobbyCategories(lobbyId),
      lobbiesRepo.listLobbyCategoryBans(lobbyId),
      lobbiesRepo.listMembersWithUser(lobbyId),
    ]);
    if (members.length !== 2 || bans.length >= 2 || categories.length === 0) return;

    const aiUserId = lobby.mode === 'ranked'
      ? await resolveRankedAiUserId(lobbyId, members)
      : null;
    const firstActorUserId = getFirstDraftActorId(members, lobby.host_user_id, aiUserId);
    const expectedUserId = getNextActorId(members, bans, firstActorUserId);
    if (bans.some((ban) => ban.user_id === expectedUserId)) return;

    const bannedIds = new Set(bans.map((ban) => ban.category_id));
    const candidates = categories.filter((category) => !bannedIds.has(category.id));
    const autoChoice = candidates[Math.floor(Math.random() * candidates.length)];
    if (!autoChoice) return;

    let inserted = false;
    try {
      await lobbiesRepo.insertLobbyCategoryBan(lobbyId, expectedUserId, autoChoice.id);
      inserted = true;
    } catch (error) {
      logger.warn({ error, lobbyId, userId: expectedUserId }, 'Failed to insert automatic draft ban');
    }

    if (inserted) {
      io.to(`lobby:${lobbyId}`).emit('draft:banned', {
        actorId: expectedUserId,
        categoryId: autoChoice.id,
      });
      logger.info(
        { lobbyId, userId: expectedUserId, categoryId: autoChoice.id, delayMs: DRAFT_AUTO_BAN_MS },
        'Draft ban applied automatically after timeout'
      );
    }

    await completeDraftIfReady(io, lobbyId);

    const updatedBans = await lobbiesRepo.listLobbyCategoryBans(lobbyId);
    if (updatedBans.length < 2) {
      const nextActorUserId = getNextActorId(members, updatedBans, firstActorUserId);
      if (lobby.mode === 'ranked' && aiUserId && nextActorUserId === aiUserId) {
        scheduleRankedAiBan(io, lobbyId, aiUserId);
        return;
      }
      scheduleDraftAutoBan(io, lobbyId);
    }
  } catch (error) {
    logger.error({ error, lobbyId, delayMs: DRAFT_AUTO_BAN_MS }, 'Scheduled automatic draft ban callback failed');
  }
}

async function getCurrentDraftActorId(lobbyId: string): Promise<string | null> {
  const lobby = await lobbiesRepo.getById(lobbyId);
  if (!lobby || lobby.status !== 'active') return null;

  const [bans, members] = await Promise.all([
    lobbiesRepo.listLobbyCategoryBans(lobbyId),
    lobbiesRepo.listMembersWithUser(lobbyId),
  ]);
  if (members.length !== 2 || bans.length >= 2) return null;

  const aiUserId = lobby.mode === 'ranked'
    ? await resolveRankedAiUserId(lobbyId, members)
    : null;
  const firstActorUserId = getFirstDraftActorId(members, lobby.host_user_id, aiUserId);
  return getNextActorId(members, bans, firstActorUserId);
}

async function anyDraftDisconnectExists(lobbyId: string, userIds: string[]): Promise<boolean> {
  const redis = getRedisClient();
  if (!redis) return false;

  const existsResults = await Promise.all(
    userIds.map((userId) => redis.exists(draftDisconnectKey(lobbyId, userId)))
  );
  return existsResults.some((exists) => exists === 1);
}

function scheduleRankedAiBan(_io: QuizballServer, lobbyId: string, aiUserId: string): void {
  const delayMs = getAiBanDelayMs();

  void scheduleRealtimeTimer('draft_ai_ban', lobbyId, new Date(Date.now() + delayMs), {
    kind: 'draft_ai_ban',
    lobbyId,
    aiUserId,
  }).catch((error) => {
    logger.error({ error, lobbyId, aiUserId, delayMs }, 'Failed to schedule draft AI ban timer');
  });
  logger.debug({ lobbyId, aiUserId, delayMs }, 'Scheduled delayed AI draft ban');
}

export async function runRankedAiDraftBan(io: QuizballServer, lobbyId: string, aiUserId: string): Promise<void> {
  const delayMs = 0;
  try {
    const redis = getRedisClient();
    if (redis && await redis.exists(draftPauseKey(lobbyId))) {
      logger.info({ lobbyId, aiUserId }, 'Skipping AI draft ban while draft is paused');
      return;
    }

    const lobby = await lobbiesRepo.getById(lobbyId);
    if (!lobby || lobby.status !== 'active' || lobby.mode !== 'ranked') return;

    const members = await lobbiesRepo.listMembersWithUser(lobbyId);
    const hasAiMember = members.some((member) => member.user_id === aiUserId);
    if (!hasAiMember) return;

    const bans = await lobbiesRepo.listLobbyCategoryBans(lobbyId);
    if (bans.length !== 1 || bans.some((ban) => ban.user_id === aiUserId)) return;

    const categories = await lobbiesService.getLobbyCategories(lobbyId);
    const bannedIds = new Set(bans.map((ban) => ban.category_id));
    const candidates = categories.filter((category) => !bannedIds.has(category.id));
    const aiChoice = candidates[Math.floor(Math.random() * candidates.length)];
    if (!aiChoice) return;

    try {
      await lobbiesRepo.insertLobbyCategoryBan(lobbyId, aiUserId, aiChoice.id);
    } catch (error) {
      logger.warn({ error, lobbyId, aiUserId }, 'Failed to insert delayed AI draft ban');
      return;
    }

    io.to(`lobby:${lobbyId}`).emit('draft:banned', {
      actorId: aiUserId,
      categoryId: aiChoice.id,
    });
    logger.info(
      { lobbyId, userId: aiUserId, categoryId: aiChoice.id, delayMs },
      'Draft ban applied (AI)'
    );

    await completeDraftIfReady(io, lobbyId);
  } catch (error) {
    logger.error({ error, lobbyId, aiUserId, delayMs }, 'Scheduled AI draft ban callback failed');
  }
}

export async function resumeActiveDraftTimers(
  io: QuizballServer,
  lobbyId: string,
  options: { restartTimers?: boolean } = {}
): Promise<void> {
  const lobby = await lobbiesRepo.getById(lobbyId);
  if (!lobby || lobby.status !== 'active') {
    await clearDraftTimers(lobbyId);
    return;
  }

  const redis = getRedisClient();
  if (redis && await redis.exists(draftPauseKey(lobbyId))) {
    await clearDraftTimers(lobbyId);
    logger.info({ lobbyId }, 'Draft timers remain paused because a player is disconnected');
    return;
  }

  if (options.restartTimers) {
    await clearDraftTimers(lobbyId);
  }

  const [categories, bans, members] = await Promise.all([
    lobbiesService.getLobbyCategories(lobbyId),
    lobbiesRepo.listLobbyCategoryBans(lobbyId),
    lobbiesRepo.listMembersWithUser(lobbyId),
  ]);
  if (members.length !== 2 || categories.length === 0) return;

  if (bans.length >= 2) {
    await completeDraftIfReady(io, lobbyId);
    return;
  }

  // Normal reconnect hydration preserves existing deadlines. A draft resume
  // after pause restarts timers because the old deadlines were canceled.
  if (options.restartTimers || !(await hasPendingRealtimeTimer('draft_auto_ban', lobbyId))) {
    scheduleDraftAutoBan(io, lobbyId);
  }

  if (lobby.mode !== 'ranked') return;
  const aiUserId = await resolveRankedAiUserId(lobbyId, members);
  if (!aiUserId) return;

  const firstActorUserId = getFirstDraftActorId(members, lobby.host_user_id, aiUserId);
  const expectedUserId = getNextActorId(members, bans, firstActorUserId);
  if (
    expectedUserId === aiUserId
    && !bans.some((ban) => ban.user_id === aiUserId)
    && (options.restartTimers || !(await hasPendingRealtimeTimer('draft_ai_ban', lobbyId)))
  ) {
    scheduleRankedAiBan(io, lobbyId, aiUserId);
  }
}

export const draftRealtimeService = {
  async pauseDraftForDisconnectedPlayer(
    io: QuizballServer,
    lobbyId: string,
    userId: string
  ): Promise<void> {
    const lobby = await lobbiesRepo.getById(lobbyId);
    if (!lobby || lobby.status !== 'active') return;

    const sockets = await io.in(`lobby:${lobbyId}`).fetchSockets();
    const stillPresent = sockets.some((socket) => socket.data.user.id === userId);
    if (stillPresent) return;

    const members = await lobbiesRepo.listMembersWithUser(lobbyId);
    if (!members.some((member) => member.user_id === userId)) return;

    const redis = getRedisClient();
    if (!redis) return;

    await redis.set(draftDisconnectKey(lobbyId, userId), String(Date.now()), { EX: DRAFT_DISCONNECT_TTL_SEC });
    await redis.set(draftPauseKey(lobbyId), String(Date.now()), { EX: DRAFT_DISCONNECT_TTL_SEC });
    await clearDraftTimers(lobbyId);

    const remainingPlayers = members.filter((member) => member.user_id !== userId);
    remainingPlayers.forEach((member) => {
      io.to(`user:${member.user_id}`).emit('draft:opponent_disconnected', {
        lobbyId,
        opponentId: userId,
        graceMs: DRAFT_DISCONNECT_GRACE_MS,
      });
    });
    logger.info(
      { lobbyId, userId, graceMs: DRAFT_DISCONNECT_GRACE_MS },
      'Draft paused for disconnected player'
    );

    const acquired = await redis.set(draftGraceKey(lobbyId), String(Date.now()), { NX: true, EX: DRAFT_GRACE_TTL_SEC });
    if (acquired !== 'OK') return;

    setTimeout(async () => {
      try {
        const graceStillActive = (await redis.exists(draftGraceKey(lobbyId))) === 1;
        if (!graceStillActive) return;

        const activeLobby = await lobbiesRepo.getById(lobbyId);
        if (!activeLobby || activeLobby.status !== 'active') return;

        const activeMembers = await lobbiesRepo.listMembersWithUser(lobbyId);
        const disconnectedExists = await Promise.all(
          activeMembers.map((member) => redis.exists(draftDisconnectKey(lobbyId, member.user_id)))
        );
        const disconnectedUserIds = activeMembers
          .filter((_, index) => disconnectedExists[index] === 1)
          .map((member) => member.user_id);
        if (disconnectedUserIds.length === 0) return;

        await Promise.all(
          disconnectedUserIds.map((disconnectedUserId) =>
            redis.set(draftAbsentAfterGraceKey(lobbyId, disconnectedUserId), '1', { EX: DRAFT_DISCONNECT_TTL_SEC })
          )
        );

        const currentActorId = await getCurrentDraftActorId(lobbyId);
        logger.info(
          { lobbyId, disconnectedUserIds, currentActorId },
          'Draft disconnect grace expired'
        );

        await redis.del([draftPauseKey(lobbyId), draftGraceKey(lobbyId)]);
        await Promise.all(disconnectedUserIds.map((disconnectedUserId) => redis.del(draftDisconnectKey(lobbyId, disconnectedUserId))));

        if (currentActorId && disconnectedUserIds.includes(currentActorId)) {
          await runDraftAutoBan(io, lobbyId);
        } else {
          await resumeActiveDraftTimers(io, lobbyId);
        }
      } catch (error) {
        logger.warn({ error, lobbyId, userId }, 'Draft disconnect grace expiry failed');
      }
    }, DRAFT_DISCONNECT_GRACE_MS);
  },

  async resumeDraftForReconnectedPlayer(
    io: QuizballServer,
    lobbyId: string,
    userId: string
  ): Promise<void> {
    const redis = getRedisClient();
    if (!redis) return;

    const wasDisconnected = (await redis.exists(draftDisconnectKey(lobbyId, userId))) === 1
      || (await redis.exists(draftAbsentAfterGraceKey(lobbyId, userId))) === 1;
    if (!wasDisconnected) return;

    await redis.del([draftDisconnectKey(lobbyId, userId), draftAbsentAfterGraceKey(lobbyId, userId)]);
    const members = await lobbiesRepo.listMembersWithUser(lobbyId);
    const memberIds = members.map((member) => member.user_id);
    if (!(await anyDraftDisconnectExists(lobbyId, memberIds))) {
      await redis.del([draftPauseKey(lobbyId), draftGraceKey(lobbyId)]);
      io.to(`lobby:${lobbyId}`).emit('draft:resume', { lobbyId });
      await resumeActiveDraftTimers(io, lobbyId, { restartTimers: true });
      logger.info({ lobbyId, userId }, 'Draft resumed after player reconnected');
    }
  },

  async handleBan(
    io: QuizballServer,
    socket: QuizballSocket,
    categoryId: string
  ): Promise<void> {
    const lobbyId = socket.data.lobbyId;
    if (!lobbyId) {
      logger.warn({ userId: socket.data.user.id }, 'Draft ban failed: no lobbyId on socket');
      socket.emit('error', { code: 'NOT_IN_LOBBY', message: 'You are not in a lobby' });
      return;
    }

    const lobby = await lobbiesRepo.getById(lobbyId);
    if (!lobby) {
      logger.warn({ lobbyId }, 'Draft ban failed: lobby not found');
      socket.emit('error', { code: 'LOBBY_NOT_FOUND', message: 'Lobby not found' });
      return;
    }
    if (lobby.status !== 'active') {
      logger.warn({ lobbyId, status: lobby.status }, 'Draft ban failed: lobby not active');
      socket.emit('error', { code: 'LOBBY_NOT_ACTIVE', message: 'Draft has not started yet' });
      return;
    }

    const redis = getRedisClient();
    if (redis && await redis.exists(draftPauseKey(lobbyId))) {
      socket.emit('error', {
        code: 'DRAFT_PAUSED',
        message: 'Draft is paused while a player reconnects',
      });
      return;
    }

    const categories = await lobbiesService.getLobbyCategories(lobbyId);
    const categoryIds = new Set(categories.map((c) => c.id));
    if (!categoryIds.has(categoryId)) {
      logger.warn({ lobbyId, categoryId }, 'Category not in lobby pool');
      socket.emit('error', { code: 'INVALID_CATEGORY', message: 'Category not available for banning' });
      return;
    }

    const bans = await lobbiesRepo.listLobbyCategoryBans(lobbyId);
    const members = await lobbiesRepo.listMembersWithUser(lobbyId);
    const aiUserId = lobby.mode === 'ranked'
      ? await resolveRankedAiUserId(lobbyId, members)
      : null;
    const firstActorUserId = getFirstDraftActorId(members, lobby.host_user_id, aiUserId);

    const expectedUserId = getNextActorId(members, bans, firstActorUserId);
    if (socket.data.user.id !== expectedUserId) {
      logger.warn(
        { lobbyId, userId: socket.data.user.id, expectedUserId },
        'Draft ban out of turn'
      );
      socket.emit('error', { code: 'NOT_YOUR_TURN', message: 'It is not your turn to ban' });
      return;
    }

    try {
      await lobbiesRepo.insertLobbyCategoryBan(lobbyId, socket.data.user.id, categoryId);
    } catch (error) {
      logger.warn({ error, lobbyId }, 'Failed to insert lobby ban');
      return;
    }
    logger.info(
      { lobbyId, userId: socket.data.user.id, categoryId },
      'Draft ban applied'
    );

    io.to(`lobby:${lobbyId}`).emit('draft:banned', {
      actorId: socket.data.user.id,
      categoryId,
    });

    const updatedBans = await lobbiesRepo.listLobbyCategoryBans(lobbyId);
    if (updatedBans.length < 2) {
      scheduleDraftAutoBan(io, lobbyId);
    }

    const isRankedVsAi = lobby.mode === 'ranked' && aiUserId !== null;
    if (isRankedVsAi && updatedBans.length === 1 && socket.data.user.id !== aiUserId) {
      scheduleRankedAiBan(io, lobbyId, aiUserId);
      return;
    }

    await completeDraftIfReady(io, lobbyId);
  },
};
