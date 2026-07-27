import type { QuizballServer } from '../socket-server.js';
import { getRandom } from '../../core/rng.js';
import { harnessDelayMs } from '../../core/harness-timing.js';
import { trackRankedMatchFound } from '../../core/analytics/game-events.js';
import { lobbiesRepo } from '../../modules/lobbies/lobbies.repo.js';
import { rankedService } from '../../modules/ranked/ranked.service.js';
import { usersRepo } from '../../modules/users/users.repo.js';
import { statsService } from '../../modules/stats/stats.service.js';
import { getRedisClient } from '../redis.js';
import { logger } from '../../core/logger.js';
import { withSpan } from '../../core/tracing.js';
import { registerAiUserId } from '../../core/analytics.js';
import {
  generateRankedAiAvatarUrl,
  generateRankedAiUsernameAvoiding,
  getAiNicknamePool,
  generateRankedAiGeo,
  generateRankedAiFavoriteClub,
  buildPersistentBotGeo,
  rankedAiLobbyKey,
} from '../ai-ranked.constants.js';
import { attachUserSocketsToLobby, emitLobbyState } from '../lobby-utils.js';
import { userSessionGuardService } from './user-session-guard.service.js';
import { startDraft } from './lobby-draft-start.service.js';
import { randomIntBetween, RANKED_AI_KEY_TTL_SEC } from './lobby-lifecycle.helpers.js';
import { syntheticBotSelectionService } from '../../modules/synthetic-bots/synthetic-bot-selection.service.js';
import { reservationService } from '../../modules/synthetic-bots/reservation.service.js';
import type { RankedProfileRow } from '../../modules/ranked/ranked.types.js';
import type { RankedLobbyContext } from '../../modules/lobbies/lobbies.types.js';

const RANKED_SIM_SEARCH_MIN_MS = 3000;
const RANKED_SIM_SEARCH_MAX_MS = 10000;
const RANKED_SIM_FOUND_MODAL_MS = 1200;
const RANKED_MM_CANCEL_KEY_PREFIX = 'ranked:mm:cancel:';
type RankedAiLobbiesRepo = typeof import('../../modules/lobbies/lobbies.repo.js').lobbiesRepo;

function rankedCancelKey(userId: string): string {
  return `${RANKED_MM_CANCEL_KEY_PREFIX}${userId}`;
}

async function hasRankedCancelRequest(userId: string): Promise<boolean> {
  const redis = getRedisClient();
  if (!redis) return false;
  return Boolean(await redis.get(rankedCancelKey(userId)));
}

function generateAiRecentForm(): Array<'W' | 'L' | 'D'> {
  const outcomes: Array<'W' | 'L' | 'D'> = ['W', 'W', 'W', 'L', 'L', 'D'];
  return Array.from({ length: 3 }, () => outcomes[Math.floor(getRandom() * outcomes.length)]);
}

async function getSupersedingSessionState(
  lobbiesRepoRef: RankedAiLobbiesRepo,
  userId: string,
  lobbyId: string
): Promise<{
  state: string;
  activeMatchId: string | null;
  waitingLobbyId: string | null;
  queueSearchId: string | null;
  otherOpenLobbyIds: string[];
} | null> {
  const [snapshot, openLobbies] = await Promise.all([
    userSessionGuardService.resolveState(userId),
    lobbiesRepoRef.listOpenLobbiesForUser(userId),
  ]);
  const otherOpenLobbyIds = openLobbies
    .filter((lobby) => lobby.id !== lobbyId)
    .map((lobby) => lobby.id);
  const superseded = Boolean(
    snapshot.activeMatchId ||
    otherOpenLobbyIds.length > 0 ||
    (snapshot.waitingLobbyId && snapshot.waitingLobbyId !== lobbyId) ||
    snapshot.state === 'CORRUPT_MULTI_STATE'
  );
  if (!superseded) return null;
  return {
    state: snapshot.state,
    activeMatchId: snapshot.activeMatchId,
    waitingLobbyId: snapshot.waitingLobbyId,
    queueSearchId: snapshot.queueSearchId,
    otherOpenLobbyIds,
  };
}

async function cleanupSupersededRankedAiLobby(params: {
  lobbiesRepoRef: RankedAiLobbiesRepo;
  lobbyId: string;
  userId: string;
  aiUserId: string;
  reason: string;
}): Promise<void> {
  const { lobbiesRepoRef, lobbyId, userId, aiUserId, reason } = params;
  const latestLobby = await lobbiesRepoRef.getById(lobbyId);
  if (!latestLobby || latestLobby.status !== 'waiting' || latestLobby.mode !== 'ranked') return;

  await lobbiesRepoRef.removeMember(lobbyId, userId);
  await lobbiesRepoRef.removeMember(lobbyId, aiUserId);
  const remainingMembers = await lobbiesRepoRef.countMembers(lobbyId);
  if (remainingMembers === 0) {
    await lobbiesRepoRef.deleteLobby(lobbyId);
  }
  const redis = getRedisClient();
  if (redis) {
    await redis.del(rankedAiLobbyKey(lobbyId));
  }
  logger.info({ lobbyId, userId, aiUserId, reason }, 'Cleaned up superseded ranked AI lobby');
}

type RankedAiOpponentGeo = {
  city: string;
  country: string;
  countryCode: string;
  flag: string;
  lat: number;
  lon: number;
};

interface ResolvedRankedAiOpponent {
  aiUser: { id: string; nickname: string | null; avatar_url: string | null };
  resolvedGeo: RankedAiOpponentGeo;
  resolvedProfile: { username: string; avatarUrl: string };
  rankedContext: RankedLobbyContext;
  opponentRp: number;
  favoriteClub: string;
  persistent: boolean;
  reservation: { botUserId: string; fence: number } | null;
}

/**
 * Resolve the ranked AI opponent for a freshly-created lobby.
 *
 * Flag OFF (or an empty roster / lost acquire race / exhausted ladder): creates
 * the ephemeral AI user exactly as the legacy path did and returns the
 * human-anchored context untouched — byte-identical behavior.
 *
 * Flag ON with a reserved roster bot: uses the bot's REAL identity + profile,
 * builds the persistent (no-anchor) bridge ranked_context, overwrites the
 * lobby's ranked_context, and returns the held reservation so downstream teardown
 * hooks can release it. The reservation was acquired ON CONFLICT DO NOTHING, so a
 * concurrent selection can never double-book the same bot.
 */
async function resolveRankedAiOpponent(params: {
  io: QuizballServer;
  userId: string;
  lobbyId: string;
  playerProfile: RankedProfileRow;
  aiGeo: RankedAiOpponentGeo;
  aiProfile: { username: string; avatarUrl: string };
  ephemeralRankedContext: RankedLobbyContext;
}): Promise<ResolvedRankedAiOpponent> {
  const { userId, lobbyId, playerProfile, aiGeo, aiProfile, ephemeralRankedContext } = params;

  if (reservationService.isEnabled()) {
    const selected = await syntheticBotSelectionService.selectAndReserve({
      humanUserId: userId,
      humanProfile: playerProfile,
      lobbyId,
    });
    if (selected) {
      const { bot } = selected;
      // Persistent difficulty bridge (no aiAnchorRp — settlement reads the real
      // profile). Overwrite the lobby context so a mid-flow re-read is coherent;
      // createMatchFromLobby rebuilds it authoritatively at match creation.
      const persistentContext: RankedLobbyContext = rankedService.buildPersistentBotMatchContext(bot.rp);
      await lobbiesRepo.updateRankedContext(lobbyId, persistentContext);
      const geo = buildPersistentBotGeo({
        country: bot.country,
        home_city: bot.home_city,
        home_lat: bot.home_lat,
        home_lng: bot.home_lng,
      });
      return {
        aiUser: { id: bot.user_id, nickname: bot.nickname, avatar_url: bot.avatar_url },
        resolvedGeo: geo,
        resolvedProfile: { username: bot.nickname ?? aiProfile.username, avatarUrl: bot.avatar_url ?? aiProfile.avatarUrl },
        rankedContext: persistentContext,
        opponentRp: bot.rp,
        favoriteClub: bot.favorite_club ?? generateRankedAiFavoriteClub(),
        persistent: true,
        reservation: { botUserId: selected.reservation.botUserId, fence: selected.reservation.fence },
      };
    }
    // No eligible/available bot — fall through to the ephemeral path.
  }

  // Ephemeral path — unchanged.
  const aiUser = await usersRepo.create({
    nickname: aiProfile.username,
    avatarUrl: aiProfile.avatarUrl,
    country: aiGeo.countryCode,
    isAi: true,
    aiKind: 'ephemeral',
  });
  registerAiUserId(aiUser.id);
  return {
    aiUser,
    resolvedGeo: aiGeo,
    resolvedProfile: aiProfile,
    rankedContext: ephemeralRankedContext,
    opponentRp: ephemeralRankedContext.aiAnchorRp ?? rankedService.DEFAULT_AI_OPPONENT_RP,
    favoriteClub: generateRankedAiFavoriteClub(),
    persistent: false,
    reservation: null,
  };
}

export async function startRankedAiForUser(
  io: QuizballServer,
  userId: string,
  options?: {
    skipSearchEmit?: boolean;
    searchDurationMs?: number;
    playerCountryCode?: string | null;
  }
): Promise<void> {
  await withSpan('ranked.match_found.ai.prepare', {
    'quizball.user_id': userId,
  }, async (span) => {
    const [takenLower, playerUser] = await Promise.all([
      usersRepo.findTakenLowerNicknames([...getAiNicknamePool()]),
      usersRepo.getById(userId),
    ]);
    const aiGeo = generateRankedAiGeo(options?.playerCountryCode ?? playerUser?.country);
    const aiProfile = {
      username: generateRankedAiUsernameAvoiding(takenLower),
      avatarUrl: generateRankedAiAvatarUrl(96),
    };
    if (await hasRankedCancelRequest(userId)) {
      logger.info({ userId }, 'Ranked AI search preparation skipped because user cancelled search');
      span.setAttribute('quizball.skipped_cancelled', true);
      return;
    }
    const playerProfile = await rankedService.ensureProfile(userId);

    // The lobby must exist before a persistent reservation can be acquired
    // (the reservation is lobby-keyed), so create the lobby first with the
    // human-anchored ephemeral context, then — when the flag is on and an
    // eligible roster bot is reserved — swap in the persistent opponent and
    // overwrite the lobby's ranked_context with the persistent (no-anchor)
    // bridge context. Flag OFF: none of this runs and the flow is byte-identical
    // to before (aiUser created up front below).
    const ephemeralRankedContext = rankedService.buildAiMatchContext(playerProfile);

    const lobby = await lobbiesRepo.createLobby({
      mode: 'ranked',
      hostUserId: userId,
      inviteCode: null,
      rankedContext: ephemeralRankedContext,
    });

    const opponent = await resolveRankedAiOpponent({
      io,
      userId,
      lobbyId: lobby.id,
      playerProfile,
      aiGeo,
      aiProfile,
      ephemeralRankedContext,
    });
    const { aiUser, resolvedGeo, resolvedProfile, rankedContext, opponentRp, favoriteClub, persistent } = opponent;

    span.setAttribute('quizball.lobby_id', lobby.id);
    span.setAttribute('quizball.ai_user_id', aiUser.id);
    span.setAttribute('quizball.persistent_bot', persistent);

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
      harnessDelayMs(randomIntBetween(RANKED_SIM_SEARCH_MIN_MS, RANKED_SIM_SEARCH_MAX_MS));
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
          aiGeo: resolvedGeo,
          rankedContext,
          opponentRp,
          favoriteClub,
          persistentBotReservation: opponent.reservation,
          lobbiesRepo,
          logger,
          foundModalMs: harnessDelayMs(RANKED_SIM_FOUND_MODAL_MS),
          startDraft,
        }),
      searchDurationMs
    );
    void resolvedProfile;
  });
}

async function handleRankedAiMatchFound(params: {
  io: QuizballServer;
  lobbyId: string;
  userId: string;
  aiUser: { id: string; nickname: string | null; avatar_url: string | null };
  aiProfile: { username: string; avatarUrl: string };
  aiGeo: { city: string; country: string; countryCode: string; flag: string; lat: number; lon: number };
  rankedContext: RankedLobbyContext;
  opponentRp: number;
  favoriteClub: string;
  persistentBotReservation: { botUserId: string; fence: number } | null;
  lobbiesRepo: RankedAiLobbiesRepo;
  logger: typeof import('../../core/logger.js').logger;
  foundModalMs: number;
  startDraft: typeof startDraft;
}): Promise<void> {
  const { io, lobbyId, userId, aiUser, aiProfile, aiGeo, opponentRp, favoriteClub, persistentBotReservation, lobbiesRepo, logger, foundModalMs, startDraft } =
    params;

  // NEW hook (Appendix A leak path): the plain-cancel returns below left the
  // lobby-keyed reservation to expire on TTL. Release it (and clear the legacy
  // rankedAiLobbyKey) when we bail before the draft starts.
  const releasePreMatch = async (path: 'match_found_cancel'): Promise<void> => {
    if (persistentBotReservation) {
      await reservationService.releaseOwned(persistentBotReservation, path);
    }
    const redis = getRedisClient();
    if (redis?.isOpen) {
      await redis.del(rankedAiLobbyKey(lobbyId)).catch(() => undefined);
    }
  };

  try {
    if (await hasRankedCancelRequest(userId)) {
      logger.info({ lobbyId, userId, aiUserId: aiUser.id }, 'Ranked AI match_found skipped because user cancelled search');
      await releasePreMatch('match_found_cancel');
      return;
    }

    const latestLobby = await lobbiesRepo.getById(lobbyId);
    if (!latestLobby || latestLobby.status !== 'waiting' || latestLobby.mode !== 'ranked') {
      await releasePreMatch('match_found_cancel');
      return;
    }

    const members = await lobbiesRepo.listMembersWithUser(lobbyId);
    const hasHost = members.some((member) => member.user_id === userId);
    const hasAi = members.some((member) => member.user_id === aiUser.id);
    if (!hasHost || !hasAi) {
      await releasePreMatch('match_found_cancel');
      return;
    }

    const supersedingSession = await getSupersedingSessionState(lobbiesRepo, userId, lobbyId);
    if (supersedingSession) {
      logger.info(
        { lobbyId, userId, aiUserId: aiUser.id, session: supersedingSession },
        'Ranked AI match_found skipped because user session moved elsewhere'
      );
      if (persistentBotReservation) {
        await reservationService.releaseOwned(persistentBotReservation, 'cleanup_superseded_lobby');
      }
      await cleanupSupersededRankedAiLobby({
        lobbiesRepoRef: lobbiesRepo,
        lobbyId,
        userId,
        aiUserId: aiUser.id,
        reason: 'match_found_superseded',
      });
      return;
    }

    // Analytics: the ranked search resolved (AI fallback). Fired for the human
    // player only (the opponent is the AI). timeSec=0 — the precise queue wait is
    // not threaded here; the queue-join event carries the start.
    trackRankedMatchFound(userId, aiUser.id, 0);

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
        rp: opponentRp,
        country: aiGeo.country,
        countryCode: aiGeo.countryCode,
        city: aiGeo.city,
        flag: aiGeo.flag,
        favoriteClub,
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
          userId,
          aiUserId: aiUser.id,
          persistentBotReservation,
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
  userId: string;
  aiUserId: string;
  persistentBotReservation: { botUserId: string; fence: number } | null;
  lobbiesRepo: RankedAiLobbiesRepo;
  logger: typeof import('../../core/logger.js').logger;
  startDraft: typeof startDraft;
}): Promise<void> {
  const { io, lobbyId, userId, aiUserId, persistentBotReservation, lobbiesRepo, logger, startDraft } = params;

  // NEW hooks (Appendix A leak paths): the plain-cancel return and the catch
  // below previously wedged the lobby / left the reservation to TTL-expire.
  const releasePreMatch = async (path: 'draft_start_cancel' | 'draft_start_error'): Promise<void> => {
    if (persistentBotReservation) {
      await reservationService.releaseOwned(persistentBotReservation, path);
    }
    const redis = getRedisClient();
    if (redis?.isOpen) {
      await redis.del(rankedAiLobbyKey(lobbyId)).catch(() => undefined);
    }
  };

  try {
    if (await hasRankedCancelRequest(userId)) {
      logger.info({ lobbyId, userId }, 'Ranked AI draft start skipped because user cancelled search');
      await releasePreMatch('draft_start_cancel');
      return;
    }
    const readyLobby = await lobbiesRepo.getById(lobbyId);
    if (!readyLobby || readyLobby.status !== 'waiting' || readyLobby.mode !== 'ranked') {
      await releasePreMatch('draft_start_cancel');
      return;
    }
    const supersedingSession = await getSupersedingSessionState(lobbiesRepo, userId, lobbyId);
    if (supersedingSession) {
      logger.info(
        { lobbyId, userId, aiUserId, session: supersedingSession },
        'Ranked AI draft start skipped because user session moved elsewhere'
      );
      if (persistentBotReservation) {
        await reservationService.releaseOwned(persistentBotReservation, 'cleanup_superseded_lobby');
      }
      await cleanupSupersededRankedAiLobby({
        lobbiesRepoRef: lobbiesRepo,
        lobbyId,
        userId,
        aiUserId,
        reason: 'draft_start_superseded',
      });
      return;
    }
    await startDraft(io, lobbyId);
  } catch (error) {
    logger.warn({ error, lobbyId }, 'Failed to start ranked AI draft');
    // NEW hook: the catch previously left the lobby wedged with the bot member.
    // Release the reservation so the bot isn't stranded until TTL.
    await releasePreMatch('draft_start_error');
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
