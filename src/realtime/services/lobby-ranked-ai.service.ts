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
import { randomIntBetween, RANKED_AI_KEY_TTL_SEC, detachAllSocketsFromLobby } from './lobby-lifecycle.helpers.js';
import { syntheticBotSelectionService } from '../../modules/synthetic-bots/synthetic-bot-selection.service.js';
import { reservationService } from '../../modules/synthetic-bots/reservation.service.js';
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

/**
 * Abort a ranked-AI lobby we created but failed to fully wire (compensation),
 * AND free its persistent-bot reservation — as ONE atomic, advisory-lock-guarded
 * operation (reservationService.abortLobby). The lock is the same one the draft
 * activation (startDraft → activateLobbyForDraftLocked) takes, so this whole
 * abort serializes with activation. Whether the bot is reclaimed is decided by
 * the reservation's committed_at, not lobby status: a committed reservation (a
 * draft has started) is left alone unless `draftTeardown` is set (this flow owns
 * the draft it is tearing down → clears the commit flag first). Redis/socket
 * cleanup is idempotent and safe outside the tx.
 */
async function compensateAbortLobby(
  io: QuizballServer,
  lobbyId: string,
  path: 'match_found_cancel' | 'cleanup_superseded_lobby' | 'draft_start_cancel' | 'draft_start_error' = 'match_found_cancel',
  opts?: { draftTeardown?: boolean },
): Promise<void> {
  try {
    const result = await reservationService.abortLobby(lobbyId, path, opts);
    if (!result.aborted) {
      logger.info({ lobbyId }, 'compensateAbortLobby: draft committed elsewhere — not tearing down');
      // Do NOT touch Redis/sockets of a live lobby.
      return;
    }
    const redis = getRedisClient();
    if (redis?.isOpen) await redis.del(rankedAiLobbyKey(lobbyId)).catch(() => undefined);
    await detachAllSocketsFromLobby(io, lobbyId).catch(() => undefined);
  } catch (err) {
    logger.warn({ err, lobbyId }, 'Failed to compensate-abort ranked AI lobby');
  }
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
    const ephemeralRankedContext = rankedService.buildAiMatchContext(playerProfile);

    // Attempt persistent selection FIRST (flag-gated inside the selection
    // service). Selection is lobby-keyed, so create the lobby up front ONLY when
    // we intend to select persistently; if selection yields nothing we tear that
    // probe lobby down and fall through to the ephemeral path, which creates the
    // ephemeral user BEFORE the lobby exactly as main does (flag-off inertness:
    // the ephemeral failure footprint is unchanged — an ephemeral-user insert
    // failure never leaves an orphan lobby).
    let lobby: { id: string } | null = null;
    let aiUser: { id: string; nickname: string | null; avatar_url: string | null };
    let resolvedGeo: RankedAiOpponentGeo;
    let resolvedProfile: { username: string; avatarUrl: string };
    let rankedContext: RankedLobbyContext;
    let opponentRp: number;
    let favoriteClub: string;
    let persistent = false;
    let persistentBotReservation: { botUserId: string; fence: number } | null = null;

    if (reservationService.isEnabled()) {
      const probeLobby = await lobbiesRepo.createLobby({
        mode: 'ranked',
        hostUserId: userId,
        inviteCode: null,
        rankedContext: ephemeralRankedContext,
      });
      let selected: Awaited<ReturnType<typeof syntheticBotSelectionService.selectAndReserve>> = null;
      try {
        selected = await syntheticBotSelectionService.selectAndReserve({
          humanUserId: userId,
          humanProfile: playerProfile,
          lobbyId: probeLobby.id,
        });
      } catch (err) {
        logger.warn({ err, userId, lobbyId: probeLobby.id }, 'persistent-bot selection threw; falling back to ephemeral');
      }
      if (selected) {
        lobby = probeLobby;
        persistent = true;
        persistentBotReservation = { botUserId: selected.reservation.botUserId, fence: selected.reservation.fence };
        const { bot } = selected;
        // ANY throw after acquire compensates: release the reservation AND tear
        // down the lobby so no bot is stranded and no empty lobby is orphaned.
        try {
          rankedContext = rankedService.buildPersistentBotMatchContext(bot.rp);
          await lobbiesRepo.updateRankedContext(probeLobby.id, rankedContext);
          resolvedGeo = buildPersistentBotGeo({
            country: bot.country,
            home_city: bot.home_city,
            home_lat: bot.home_lat,
            home_lng: bot.home_lng,
          });
          resolvedProfile = { username: bot.nickname ?? aiProfile.username, avatarUrl: bot.avatar_url ?? aiProfile.avatarUrl };
          aiUser = { id: bot.user_id, nickname: bot.nickname, avatar_url: bot.avatar_url };
          opponentRp = bot.rp;
          favoriteClub = bot.favorite_club ?? generateRankedAiFavoriteClub();

          await lobbiesRepo.addMember(probeLobby.id, userId, true);
          await lobbiesRepo.addMember(probeLobby.id, aiUser.id, true);
          const redis = getRedisClient();
          if (redis) {
            await redis.set(rankedAiLobbyKey(probeLobby.id), aiUser.id, { EX: RANKED_AI_KEY_TTL_SEC });
          }
          await attachUserSocketsToLobby(io, userId, probeLobby.id);
          await emitLobbyState(io, probeLobby.id);
          await userSessionGuardService.emitState(io, userId);
        } catch (err) {
          logger.warn({ err, userId, lobbyId: probeLobby.id, botUserId: aiUser!.id }, 'persistent-bot lobby build failed; compensating (locked release + teardown)');
          await compensateAbortLobby(io, probeLobby.id);
          return;
        }
      } else {
        // No bot reserved — discard the probe lobby and use the ephemeral path.
        await compensateAbortLobby(io, probeLobby.id);
      }
    }

    if (!lobby) {
      // Ephemeral path — byte-identical to main: ephemeral user BEFORE the lobby.
      const created = await usersRepo.create({
        nickname: aiProfile.username,
        avatarUrl: aiProfile.avatarUrl,
        country: aiGeo.countryCode,
        isAi: true,
        aiKind: 'ephemeral',
      });
      registerAiUserId(created.id);
      aiUser = created;
      resolvedGeo = aiGeo;
      resolvedProfile = aiProfile;
      rankedContext = ephemeralRankedContext;
      opponentRp = ephemeralRankedContext.aiAnchorRp ?? rankedService.DEFAULT_AI_OPPONENT_RP;
      favoriteClub = generateRankedAiFavoriteClub();

      lobby = await lobbiesRepo.createLobby({
        mode: 'ranked',
        hostUserId: userId,
        inviteCode: null,
        rankedContext,
      });
      await lobbiesRepo.addMember(lobby.id, userId, true);
      await lobbiesRepo.addMember(lobby.id, aiUser.id, true);

      const redis = getRedisClient();
      if (redis) {
        await redis.set(rankedAiLobbyKey(lobby.id), aiUser.id, { EX: RANKED_AI_KEY_TTL_SEC });
      }
      await attachUserSocketsToLobby(io, userId, lobby.id);
      await emitLobbyState(io, lobby.id);
      await userSessionGuardService.emitState(io, userId);
    }

    // Compensation extends through the timer calc + search-started emit +
    // scheduling: a throw ANYWHERE here (before the search-timer is installed)
    // must also release the reservation and tear down the lobby, else the bot is
    // stranded with no live flow to free it (Sol P2).
    try {
      span.setAttribute('quizball.lobby_id', lobby.id);
      span.setAttribute('quizball.ai_user_id', aiUser!.id);
      span.setAttribute('quizball.persistent_bot', persistent);

      const searchDurationMs =
        options?.searchDurationMs ??
        harnessDelayMs(randomIntBetween(RANKED_SIM_SEARCH_MIN_MS, RANKED_SIM_SEARCH_MAX_MS));
      span.setAttribute('quizball.search_duration_ms', searchDurationMs);
      if (!options?.skipSearchEmit) {
        io.to(`user:${userId}`).emit('ranked:search_started', { durationMs: searchDurationMs });
      }
      logger.info(
        { lobbyId: lobby.id, userId, searchDurationMs, persistent, skipSearchEmit: options?.skipSearchEmit ?? false },
        'Ranked AI search started'
      );

      const startedLobbyId = lobby.id;
      setTimeout(
        () =>
          void handleRankedAiMatchFound({
            io,
            lobbyId: startedLobbyId,
            userId,
            aiUser: aiUser!,
            aiProfile: resolvedProfile!,
            aiGeo: resolvedGeo!,
            rankedContext: rankedContext!,
            opponentRp: opponentRp!,
            favoriteClub: favoriteClub!,
            persistentBotReservation,
            lobbiesRepo,
            logger,
            foundModalMs: harnessDelayMs(RANKED_SIM_FOUND_MODAL_MS),
            startDraft,
          }),
        searchDurationMs
      );
    } catch (err) {
      if (persistentBotReservation) {
        logger.warn({ err, userId, lobbyId: lobby.id, botUserId: aiUser!.id }, 'persistent-bot search scheduling failed; compensating (locked release + teardown)');
        await compensateAbortLobby(io, lobby.id);
        return;
      }
      throw err;
    }
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

  // Abort owned by THIS flow → compensateAbortLobby does the atomic,
  // advisory-lock-guarded release + teardown in one transaction (serialized with
  // draft activation). If a concurrent reconnect advanced the lobby, the whole
  // abort no-ops — the live draft keeps the bot.
  const releasePreMatch = async (_path: 'match_found_cancel'): Promise<void> => {
    await compensateAbortLobby(io, lobbyId);
  };

  try {
    if (await hasRankedCancelRequest(userId)) {
      // THIS flow's user cancelled — we own the abort.
      logger.info({ lobbyId, userId, aiUserId: aiUser.id }, 'Ranked AI match_found skipped because user cancelled search');
      await releasePreMatch('match_found_cancel');
      return;
    }

    const latestLobby = await lobbiesRepo.getById(lobbyId);
    if (!latestLobby || latestLobby.mode !== 'ranked') {
      // Lobby genuinely gone → free the (lobby-keyed) reservation. Nothing to tear
      // down; compensate is a no-op on a missing lobby.
      await releasePreMatch('match_found_cancel');
      return;
    }
    if (latestLobby.status !== 'waiting') {
      // Someone ELSE advanced this lobby (e.g. a reconnect started the draft) —
      // it is LIVE and NOT ours to cancel. Do NOT release or tear down; the
      // draft/match lifecycle now owns the reservation's fate.
      logger.info({ lobbyId, userId, status: latestLobby.status }, 'Ranked AI match_found: lobby advanced elsewhere — leaving it live');
      return;
    }

    const members = await lobbiesRepo.listMembersWithUser(lobbyId);
    const hasHost = members.some((member) => member.user_id === userId);
    const hasAi = members.some((member) => member.user_id === aiUser.id);
    if (!hasHost || !hasAi) {
      // Membership was torn down out from under us → the lobby is being abandoned;
      // free the reservation (still lobby-keyed) and clean up.
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
        // Locked release + teardown (serialized with draft activation).
        await compensateAbortLobby(io, lobbyId, 'cleanup_superseded_lobby');
      } else {
        await cleanupSupersededRankedAiLobby({
          lobbiesRepoRef: lobbiesRepo,
          lobbyId,
          userId,
          aiUserId: aiUser.id,
          reason: 'match_found_superseded',
        });
      }
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
    // A throw here left the lobby wired but no draft scheduled by THIS flow.
    // compensateAbortLobby does the atomic, lock-guarded release + teardown: if a
    // reconnect independently activated the draft, it observes 'active' under the
    // shared lock and no-ops entirely (no release, no teardown) — the live draft
    // keeps the bot. No separate status pre-check needed (that would be a TOCTOU).
    logger.warn({ error, lobbyId }, 'Failed during ranked AI search completion');
    await compensateAbortLobby(io, lobbyId);
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

  // Draft-start cancel/error ENDS this flow. For a PERSISTENT bot, tear the lobby
  // down entirely under the shared advisory lock (compensateAbortLobby →
  // abortLobby): there is no "release the bot but keep the lobby" path — a waiting
  // lobby with a freed bot could be activated by a reconnect and re-reserve the
  // bot elsewhere. If a concurrent reconnect already advanced the draft, the
  // locked abort observes 'active' and no-ops. Ephemeral keeps its legacy
  // Redis-key-only cleanup (no reservation exists; other paths reap the lobby).
  const releasePreMatch = async (
    path: 'draft_start_cancel' | 'draft_start_error',
  ): Promise<void> => {
    if (persistentBotReservation) {
      // draft_start_error may fire post-activation (committed_at set) → pass
      // teardown-intent. The AUTHORITATIVE decision is the in-lock live-match
      // check inside the locked abort: if a reconnect activated + created a match,
      // it no-ops and the fresh commit survives; only a genuinely-stuck draft (no
      // live match) is reclaimed. draft_start_cancel is pre-activation (no commit
      // by us) so it does not pass teardown-intent.
      await compensateAbortLobby(io, lobbyId, path, { draftTeardown: path === 'draft_start_error' });
      return;
    }
    const redis = getRedisClient();
    if (redis?.isOpen) {
      await redis.del(rankedAiLobbyKey(lobbyId)).catch(() => undefined);
    }
  };

  try {
    if (await hasRankedCancelRequest(userId)) {
      // THIS flow's user cancelled BEFORE activation — pre-activation, no commit.
      logger.info({ lobbyId, userId }, 'Ranked AI draft start skipped because user cancelled search');
      await releasePreMatch('draft_start_cancel');
      return;
    }
    const readyLobby = await lobbiesRepo.getById(lobbyId);
    if (!readyLobby || readyLobby.mode !== 'ranked') {
      // Lobby gone → free the still-lobby-keyed reservation (pre-activation).
      await releasePreMatch('draft_start_cancel');
      return;
    }
    if (readyLobby.status !== 'waiting') {
      // A reconnect (or another actor) already advanced this lobby's draft — it
      // is LIVE and NOT ours to cancel. The draft/match lifecycle owns the
      // reservation now; do not release or tear down.
      logger.info({ lobbyId, userId, status: readyLobby.status }, 'Ranked AI draft start: lobby advanced elsewhere — leaving it live');
      return;
    }
    const supersedingSession = await getSupersedingSessionState(lobbiesRepo, userId, lobbyId);
    if (supersedingSession) {
      logger.info(
        { lobbyId, userId, aiUserId, session: supersedingSession },
        'Ranked AI draft start skipped because user session moved elsewhere'
      );
      if (persistentBotReservation) {
        // Pre-activation superseded cleanup — we have not committed (no teardown).
        await compensateAbortLobby(io, lobbyId, 'cleanup_superseded_lobby');
      } else {
        await cleanupSupersededRankedAiLobby({
          lobbiesRepoRef: lobbiesRepo,
          lobbyId,
          userId,
          aiUserId,
          reason: 'draft_start_superseded',
        });
      }
      return;
    }
    await startDraft(io, lobbyId);
  } catch (error) {
    logger.warn({ error, lobbyId }, 'Failed to start ranked AI draft');
    // startDraft may have ACTIVATED (committed_at set) before throwing. The locked
    // abort's in-lock live-match check is the authoritative gate: if a reconnect
    // created a match, it no-ops (the live draft keeps the bot); only a stuck
    // no-match draft is reclaimed.
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
