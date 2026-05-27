import type { QuizballServer } from '../socket-server.js';
import { lobbiesRepo } from '../../modules/lobbies/lobbies.repo.js';
import { rankedService } from '../../modules/ranked/ranked.service.js';
import { usersRepo } from '../../modules/users/users.repo.js';
import { statsService } from '../../modules/stats/stats.service.js';
import { getRedisClient } from '../redis.js';
import { logger } from '../../core/logger.js';
import { withSpan } from '../../core/tracing.js';
import {
  generateRankedAiAvatarUrl,
  generateRankedAiUsernameAvoiding,
  getAiNicknamePool,
  generateRankedAiGeo,
  generateRankedAiFavoriteClub,
  rankedAiLobbyKey,
} from '../ai-ranked.constants.js';
import { attachUserSocketsToLobby, emitLobbyState } from '../lobby-utils.js';
import { userSessionGuardService } from './user-session-guard.service.js';
import { startDraft } from './lobby-draft-start.service.js';
import { randomIntBetween, RANKED_AI_KEY_TTL_SEC } from './lobby-lifecycle.helpers.js';

const RANKED_SIM_SEARCH_MIN_MS = 3000;
const RANKED_SIM_SEARCH_MAX_MS = 10000;
const RANKED_SIM_FOUND_MODAL_MS = 1200;

function generateAiRecentForm(): Array<'W' | 'L' | 'D'> {
  const outcomes: Array<'W' | 'L' | 'D'> = ['W', 'W', 'W', 'L', 'L', 'D'];
  return Array.from({ length: 3 }, () => outcomes[Math.floor(Math.random() * outcomes.length)]);
}

export async function startRankedAiForUser(
  io: QuizballServer,
  userId: string,
  options?: {
    skipSearchEmit?: boolean;
    searchDurationMs?: number;
  }
): Promise<void> {
  await withSpan('ranked.match_found.ai.prepare', {
    'quizball.user_id': userId,
  }, async (span) => {
    const takenLower = await usersRepo.findTakenLowerNicknames([...getAiNicknamePool()]);
    const aiProfile = {
      username: generateRankedAiUsernameAvoiding(takenLower),
      avatarUrl: generateRankedAiAvatarUrl(96),
    };
    const aiUser = await usersRepo.create({
      nickname: aiProfile.username,
      avatarUrl: aiProfile.avatarUrl,
      isAi: true,
    });
    const playerProfile = await rankedService.ensureProfile(userId);
    const rankedContext = rankedService.buildAiMatchContext(playerProfile);

    const lobby = await lobbiesRepo.createLobby({
      mode: 'ranked',
      hostUserId: userId,
      inviteCode: null,
      rankedContext,
    });

    span.setAttribute('quizball.lobby_id', lobby.id);
    span.setAttribute('quizball.ai_user_id', aiUser.id);

    await lobbiesRepo.addMember(lobby.id, userId, true);
    await lobbiesRepo.addMember(lobby.id, aiUser.id, true);

    const redis = getRedisClient();
    if (redis) {
      await redis.set(rankedAiLobbyKey(lobby.id), aiUser.id, { EX: RANKED_AI_KEY_TTL_SEC });
    }

    await attachUserSocketsToLobby(io, userId, lobby.id);
    await emitLobbyState(io, lobby.id);
    await userSessionGuardService.emitState(io, userId);

    const searchDurationMs =
      options?.searchDurationMs ??
      randomIntBetween(RANKED_SIM_SEARCH_MIN_MS, RANKED_SIM_SEARCH_MAX_MS);
    span.setAttribute('quizball.search_duration_ms', searchDurationMs);
    if (!options?.skipSearchEmit) {
      io.to(`user:${userId}`).emit('ranked:search_started', { durationMs: searchDurationMs });
    }
    logger.info(
      { lobbyId: lobby.id, userId, searchDurationMs, skipSearchEmit: options?.skipSearchEmit ?? false },
      'Ranked AI search started'
    );

    setTimeout(
      () =>
        void handleRankedAiMatchFound({
          io,
          lobbyId: lobby.id,
          userId,
          aiUser,
          aiProfile,
          rankedContext,
          lobbiesRepo,
          logger,
          foundModalMs: RANKED_SIM_FOUND_MODAL_MS,
          startDraft,
        }),
      searchDurationMs
    );
  });
}

async function handleRankedAiMatchFound(params: {
  io: QuizballServer;
  lobbyId: string;
  userId: string;
  aiUser: { id: string; nickname: string | null; avatar_url: string | null };
  aiProfile: { username: string; avatarUrl: string };
  rankedContext: {
    aiAnchorRp: number;
  };
  lobbiesRepo: typeof import('../../modules/lobbies/lobbies.repo.js').lobbiesRepo;
  logger: typeof import('../../core/logger.js').logger;
  foundModalMs: number;
  startDraft: typeof startDraft;
}): Promise<void> {
  const { io, lobbyId, userId, aiUser, aiProfile, rankedContext, lobbiesRepo, logger, foundModalMs, startDraft } =
    params;

  try {
    const latestLobby = await lobbiesRepo.getById(lobbyId);
    if (!latestLobby || latestLobby.status !== 'waiting' || latestLobby.mode !== 'ranked') {
      return;
    }

    const members = await lobbiesRepo.listMembersWithUser(lobbyId);
    const hasHost = members.some((member) => member.user_id === userId);
    const hasAi = members.some((member) => member.user_id === aiUser.id);
    if (!hasHost || !hasAi) return;

    const playerUser = await usersRepo.getById(userId);
    const aiGeo = generateRankedAiGeo(playerUser?.country);
    const myRecentForm = await statsService
      .getRecentFormForUser(userId, 3)
      .catch(() => [] as Array<'W' | 'L' | 'D'>);
    io.to(`user:${userId}`).emit('ranked:match_found', {
      lobbyId,
      myRecentForm,
      opponent: {
        id: aiUser.id,
        username: aiUser.nickname ?? aiProfile.username,
        avatarUrl: aiUser.avatar_url ?? aiProfile.avatarUrl,
        rp: rankedContext.aiAnchorRp,
        country: aiGeo.country,
        countryCode: aiGeo.countryCode,
        city: aiGeo.city,
        flag: aiGeo.flag,
        favoriteClub: generateRankedAiFavoriteClub(),
        recentForm: generateAiRecentForm(),
        lat: aiGeo.lat,
        lon: aiGeo.lon,
      },
    });
    logger.info({ lobbyId, userId, aiUserId: aiUser.id }, 'Ranked AI match found');

    setTimeout(
      () =>
        void startRankedAiDraft({
          io,
          lobbyId,
          lobbiesRepo,
          logger,
          startDraft,
        }),
      foundModalMs
    );
  } catch (error) {
    logger.warn({ error, lobbyId }, 'Failed during ranked AI search completion');
  }
}

async function startRankedAiDraft(params: {
  io: QuizballServer;
  lobbyId: string;
  lobbiesRepo: typeof import('../../modules/lobbies/lobbies.repo.js').lobbiesRepo;
  logger: typeof import('../../core/logger.js').logger;
  startDraft: typeof startDraft;
}): Promise<void> {
  const { io, lobbyId, lobbiesRepo, logger, startDraft } = params;
  try {
    const readyLobby = await lobbiesRepo.getById(lobbyId);
    if (!readyLobby || readyLobby.status !== 'waiting' || readyLobby.mode !== 'ranked') {
      return;
    }
    await startDraft(io, lobbyId);
  } catch (error) {
    logger.warn({ error, lobbyId }, 'Failed to start ranked AI draft');
    io.to(`lobby:${lobbyId}`).emit('error', {
      code: 'MATCH_PREPARATION_FAILED',
      message: 'Match preparation got stuck. Please restart ranked matchmaking.',
      meta: {
        lobbyId,
        source: 'ranked_ai_draft_start',
      },
    });
  }
}
