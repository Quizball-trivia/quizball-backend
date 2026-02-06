import type { QuizballServer, QuizballSocket } from '../socket-server.js';
import { lobbiesRepo } from '../../modules/lobbies/lobbies.repo.js';
import { lobbiesService } from '../../modules/lobbies/lobbies.service.js';
import { matchesService } from '../../modules/matches/matches.service.js';
import { beginMatchForLobby } from './match-realtime.service.js';
import { logger } from '../../core/logger.js';
import { startDraft } from './lobby-realtime.service.js';
import { rankedAiLobbyKey } from '../ai-ranked.constants.js';
import { getRedisClient } from '../redis.js';

const AI_BAN_DELAY_MIN_MS = 700;
const AI_BAN_DELAY_MAX_MS = 1800;

// Process-local timer guard for delayed AI bans (safe for single-instance deployment).
const pendingAiBanTimers = new Map<string, NodeJS.Timeout>();

async function startMatchFromDraft(
  io: QuizballServer,
  lobbyId: string,
  allowedCategoryIds: [string, string]
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
      hostUserId: lobby.host_user_id,
      categoryIds: allowedCategoryIds,
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
    { lobbyId, matchId, mode: lobby.mode, categoryIds: allowedCategoryIds },
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
  hostUserId: string
): string {
  if (bans.length === 0) return hostUserId;

  // Most recent ban is last in the array (ordered by banned_at ASC)
  const lastActor = bans[bans.length - 1]?.user_id;
  const other = members.find((member) => member.user_id !== lastActor)?.user_id;
  return other ?? hostUserId;
}

function getAiBanDelayMs(): number {
  return Math.floor(Math.random() * (AI_BAN_DELAY_MAX_MS - AI_BAN_DELAY_MIN_MS + 1)) + AI_BAN_DELAY_MIN_MS;
}

function clearPendingAiBanTimer(lobbyId: string): void {
  const timer = pendingAiBanTimers.get(lobbyId);
  if (!timer) return;
  clearTimeout(timer);
  pendingAiBanTimers.delete(lobbyId);
}

async function completeDraftIfReady(io: QuizballServer, lobbyId: string): Promise<void> {
  const lobby = await lobbiesRepo.getById(lobbyId);
  if (!lobby || lobby.status !== 'active') {
    clearPendingAiBanTimer(lobbyId);
    return;
  }

  const categories = await lobbiesService.getLobbyCategories(lobbyId);
  const bans = await lobbiesRepo.listLobbyCategoryBans(lobbyId);
  if (bans.length < 2) return;

  clearPendingAiBanTimer(lobbyId);
  const bannedIds = new Set(bans.map((ban) => ban.category_id));
  const remaining = categories.filter((category) => !bannedIds.has(category.id));
  if (remaining.length < 2) {
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

  const allowed: [string, string] = [remaining[0].id, remaining[1].id];
  io.to(`lobby:${lobbyId}`).emit('draft:complete', { allowedCategoryIds: allowed });
  logger.info({ lobbyId, allowedCategoryIds: allowed }, 'Draft complete');
  await startMatchFromDraft(io, lobbyId, allowed);
}

function scheduleRankedAiBan(io: QuizballServer, lobbyId: string, aiUserId: string): void {
  clearPendingAiBanTimer(lobbyId);
  const delayMs = getAiBanDelayMs();

  const timer = setTimeout(() => {
    void (async () => {
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
      } finally {
        pendingAiBanTimers.delete(lobbyId);
      }
    })();
  }, delayMs);

  pendingAiBanTimers.set(lobbyId, timer);
  logger.debug({ lobbyId, aiUserId, delayMs }, 'Scheduled delayed AI draft ban');
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

    const expectedUserId = getNextActorId(members, bans, lobby.host_user_id);
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

    const redis = getRedisClient();
    const aiUserId = lobby.mode === 'ranked' && redis ? await redis.get(rankedAiLobbyKey(lobbyId)) : null;
    const aiMember = aiUserId
      ? members.find((member) => member.user_id === aiUserId)
      : undefined;
    const updatedBans = await lobbiesRepo.listLobbyCategoryBans(lobbyId);
    const isRankedVsAi = lobby.mode === 'ranked' && aiMember !== undefined;
    if (isRankedVsAi && aiUserId && updatedBans.length === 1 && socket.data.user.id !== aiUserId) {
      scheduleRankedAiBan(io, lobbyId, aiUserId);
      return;
    }

    await completeDraftIfReady(io, lobbyId);
  },
};
