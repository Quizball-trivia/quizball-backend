import type { QuizballServer, QuizballSocket } from '../socket-server.js';
import { lobbiesRepo } from '../../modules/lobbies/lobbies.repo.js';
import { lobbiesService } from '../../modules/lobbies/lobbies.service.js';
import { matchesService } from '../../modules/matches/matches.service.js';
import { usersRepo } from '../../modules/users/users.repo.js';
import { beginMatchForLobby } from './match-realtime.service.js';
import { logger } from '../../core/logger.js';
import { startDraft } from './lobby-realtime.service.js';
import { rankedAiLobbyKey } from '../ai-ranked.constants.js';
import { getRedisClient } from '../redis.js';
import { cancelRealtimeTimer, scheduleRealtimeTimer } from '../realtime-timer-scheduler.js';

const AI_BAN_DELAY_MIN_MS = 700;
const AI_BAN_DELAY_MAX_MS = 1800;
const DRAFT_AUTO_BAN_MS = 16000;
const AI_LOBBY_KEY_TTL_SEC = 7200;

async function startMatchFromDraft(
  io: QuizballServer,
  lobbyId: string,
  halfOneCategoryId: string
): Promise<void> {
  const lobby = await lobbiesRepo.getById(lobbyId);
  if (!lobby) return;

  const members = await lobbiesRepo.listMembersWithUser(lobbyId);
  if (members.length !== 2) return;

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
    logger.warn(
      { lobbyId, error: error instanceof Error ? error.message : error },
      'Failed to create match from draft; restarting draft'
    );
    await startDraft(io, lobbyId);
    return;
  }

  const matchId = result.match.id;
  logger.info(
    { lobbyId, matchId, mode: lobby.mode, halfOneCategoryId },
    'Match created from draft'
  );
  await beginMatchForLobby(io, lobbyId, matchId);
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

function clearPendingAiBanTimer(lobbyId: string): void {
  void cancelRealtimeTimer('draft_ai_ban', lobbyId).catch((error) => {
    logger.warn({ error, lobbyId }, 'Failed to cancel draft AI ban timer');
  });
}

function clearPendingAutoBanTimer(lobbyId: string): void {
  void cancelRealtimeTimer('draft_auto_ban', lobbyId).catch((error) => {
    logger.warn({ error, lobbyId }, 'Failed to cancel draft auto-ban timer');
  });
}

function clearDraftTimers(lobbyId: string): void {
  clearPendingAiBanTimer(lobbyId);
  clearPendingAutoBanTimer(lobbyId);
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

  const users = await Promise.all(
    members.map(async (member) => ({
      userId: member.user_id,
      user: await usersRepo.getById(member.user_id),
    }))
  );
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

async function completeDraftIfReady(io: QuizballServer, lobbyId: string): Promise<void> {
  const lobby = await lobbiesRepo.getById(lobbyId);
  if (!lobby || lobby.status !== 'active') {
    clearDraftTimers(lobbyId);
    return;
  }

  const categories = await lobbiesService.getLobbyCategories(lobbyId);
  const bans = await lobbiesRepo.listLobbyCategoryBans(lobbyId);
  if (bans.length < 2) return;

  clearDraftTimers(lobbyId);
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
    return;
  }

  const halfOneCategoryId = remaining[0].id;
  io.to(`lobby:${lobbyId}`).emit('draft:complete', { halfOneCategoryId });
  logger.info({ lobbyId, halfOneCategoryId }, 'Draft complete');
  await startMatchFromDraft(io, lobbyId, halfOneCategoryId);
}

export function scheduleDraftAutoBan(_io: QuizballServer, lobbyId: string): void {
  clearPendingAutoBanTimer(lobbyId);

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
      scheduleDraftAutoBan(io, lobbyId);
    }
  } catch (error) {
    logger.error({ error, lobbyId, delayMs: DRAFT_AUTO_BAN_MS }, 'Scheduled automatic draft ban callback failed');
  }
}

function scheduleRankedAiBan(_io: QuizballServer, lobbyId: string, aiUserId: string): void {
  clearPendingAiBanTimer(lobbyId);
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

export async function resumeActiveDraftTimers(io: QuizballServer, lobbyId: string): Promise<void> {
  const lobby = await lobbiesRepo.getById(lobbyId);
  if (!lobby || lobby.status !== 'active') {
    clearDraftTimers(lobbyId);
    return;
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

  scheduleDraftAutoBan(io, lobbyId);

  if (lobby.mode !== 'ranked') return;
  const aiUserId = await resolveRankedAiUserId(lobbyId, members);
  if (!aiUserId) return;

  const firstActorUserId = getFirstDraftActorId(members, lobby.host_user_id, aiUserId);
  const expectedUserId = getNextActorId(members, bans, firstActorUserId);
  if (expectedUserId === aiUserId && !bans.some((ban) => ban.user_id === aiUserId)) {
    scheduleRankedAiBan(io, lobbyId, aiUserId);
  }
}

export const draftRealtimeService = {
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
