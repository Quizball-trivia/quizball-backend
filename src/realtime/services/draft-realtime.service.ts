import type { QuizballServer, QuizballSocket } from '../socket-server.js';
import { lobbiesRepo } from '../../modules/lobbies/lobbies.repo.js';
import { lobbiesService } from '../../modules/lobbies/lobbies.service.js';
import { matchesService } from '../../modules/matches/matches.service.js';
import { sendMatchQuestion } from '../match-flow.js';
import { logger } from '../../core/logger.js';
import { startDraft } from './lobby-realtime.service.js';

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

  const sockets = await io.in(`lobby:${lobbyId}`).fetchSockets();
  sockets.forEach((socket) => {
    socket.join(`match:${matchId}`);
    socket.data.matchId = matchId;
  });

  const memberA = members[0];
  const memberB = members[1];

  io.to(`user:${memberA.user_id}`).emit('match:start', {
    matchId,
    opponent: {
      id: memberB.user_id,
      username: memberB.nickname ?? 'Player',
      avatarUrl: memberB.avatar_url,
    },
  });

  io.to(`user:${memberB.user_id}`).emit('match:start', {
    matchId,
    opponent: {
      id: memberA.user_id,
      username: memberA.nickname ?? 'Player',
      avatarUrl: memberA.avatar_url,
    },
  });

  await sendMatchQuestion(io, matchId, 0);
}

function getNextActorId(
  members: Array<{ user_id: string }>,
  bans: Array<{ user_id: string }>,
  hostUserId: string
): string {
  if (bans.length === 0) return hostUserId;
  const lastActor = bans[0]?.user_id;
  const other = members.find((member) => member.user_id !== lastActor)?.user_id;
  return other ?? hostUserId;
}

export const draftRealtimeService = {
  async handleBan(
    io: QuizballServer,
    socket: QuizballSocket,
    categoryId: string
  ): Promise<void> {
    const lobbyId = socket.data.lobbyId;
    if (!lobbyId) return;

    const lobby = await lobbiesRepo.getById(lobbyId);
    if (!lobby || lobby.status !== 'active') return;

    const categories = await lobbiesService.getLobbyCategories(lobbyId);
    const categoryIds = new Set(categories.map((c) => c.id));
    if (!categoryIds.has(categoryId)) {
      logger.warn({ lobbyId, categoryId }, 'Category not in lobby pool');
      return;
    }

    const bans = await lobbiesRepo.listLobbyCategoryBans(lobbyId);
    const members = await lobbiesRepo.listMembersWithUser(lobbyId);

    const expectedUserId = getNextActorId(members, bans, lobby.host_user_id);
    if (socket.data.user.id !== expectedUserId) {
      logger.warn({ lobbyId, userId: socket.data.user.id }, 'Draft ban out of turn');
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
    if (updatedBans.length < 2) return;

    const bannedIds = new Set(updatedBans.map((ban) => ban.category_id));
    const remaining = categories.filter((category) => !bannedIds.has(category.id));
    if (remaining.length < 2) return;

    const allowed: [string, string] = [remaining[0].id, remaining[1].id];

    io.to(`lobby:${lobbyId}`).emit('draft:complete', { allowedCategoryIds: allowed });
    logger.info(
      { lobbyId, allowedCategoryIds: allowed },
      'Draft complete'
    );

    await startMatchFromDraft(io, lobbyId, allowed);
  },
};
