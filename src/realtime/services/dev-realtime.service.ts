import { logger } from '../../core/logger.js';
import { usersRepo } from '../../modules/users/users.repo.js';
import { lobbiesRepo } from '../../modules/lobbies/lobbies.repo.js';
import { lobbiesService } from '../../modules/lobbies/lobbies.service.js';
import { matchesService } from '../../modules/matches/matches.service.js';
import { generateRankedAiProfile, rankedAiMatchKey } from '../ai-ranked.constants.js';
import { getRedisClient } from '../redis.js';
import { beginMatchForLobby } from './match-realtime.service.js';
import { devSkipToPossessionPhase } from '../possession-match-flow.js';
import type { QuizballServer, QuizballSocket } from '../socket-server.js';

const AI_REDIS_TTL_SEC = 7200;
const DEV_MATCH_START_COUNTDOWN_SEC = 2;

/**
 * Dev-only realtime service for fast iteration tooling.
 * Intentionally shortcuts the normal layered flow (directly calls repos + services)
 * to quickly bootstrap matches for testing. Guarded by NODE_ENV check in the handler.
 */
export const devRealtimeService = {
  async handleQuickMatch(io: QuizballServer, socket: QuizballSocket): Promise<void> {
    const userId = socket.data.user.id;

    // 1. Create AI opponent
    const aiProfile = generateRankedAiProfile();
    const aiUser = await usersRepo.create({
      nickname: aiProfile.username,
      avatarUrl: aiProfile.avatarUrl,
      isAi: true,
    });

    // 2. Create lobby (mode: 'ranked' allows null invite code per DB constraint)
    const lobby = await lobbiesRepo.createLobby({
      mode: 'ranked',
      hostUserId: userId,
      inviteCode: null,
    });

    // 3. Add both players
    await lobbiesRepo.addMember(lobby.id, userId, true);
    await lobbiesRepo.addMember(lobby.id, aiUser.id, true);

    // 4. Join socket to lobby room (beginMatchForLobby reads from this)
    socket.join(`lobby:${lobby.id}`);

    // 5. Pick 2 random categories
    const categories = await lobbiesService.selectRandomCategories(2);
    if (categories.length < 2) {
      socket.emit('error', { code: 'DEV_ERROR', message: 'Not enough categories with questions' });
      return;
    }

    // 6. Create match via production service
    const result = await matchesService.createMatchFromLobby({
      lobbyId: lobby.id,
      mode: 'friendly',
      hostUserId: userId,
      categoryAId: categories[0].id,
      categoryBId: categories[1].id,
    });

    // 7. Set AI Redis key so AI answer scheduling works
    const redis = getRedisClient();
    if (redis?.isOpen) {
      await redis.set(rankedAiMatchKey(result.match.id), aiUser.id, { EX: AI_REDIS_TTL_SEC });
    } else {
      logger.warn({ matchId: result.match.id }, 'Redis unavailable during dev quick match; continuing without AI Redis marker');
    }

    // 8. Start match (emits match:start, moves socket, sends first question)
    await beginMatchForLobby(io, lobby.id, result.match.id, {
      countdownSec: DEV_MATCH_START_COUNTDOWN_SEC,
    });

    logger.info(
      { matchId: result.match.id, userId, aiUserId: aiUser.id },
      'Dev quick match started'
    );
  },

  async handleSkipTo(
    _io: QuizballServer,
    payload: { matchId: string; target: 'halftime' | 'last_attack' | 'shot' | 'penalties' | 'second_half' }
  ): Promise<void> {
    await devSkipToPossessionPhase(_io, payload.matchId, payload.target);

    logger.info({ matchId: payload.matchId, target: payload.target }, 'Dev skip executed');
  },
};
