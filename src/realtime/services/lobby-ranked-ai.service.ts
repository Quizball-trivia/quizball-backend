import type { QuizballServer } from '../socket-server.js';
import { getRandom } from '../../core/rng.js';
import { harnessDelayMs } from '../../core/harness-timing.js';
import { trackRankedMatchFound, trackRankedQueueLeft } from '../../core/analytics/game-events.js';
import { lobbiesRepo } from '../../modules/lobbies/lobbies.repo.js';
import { rankedService } from '../../modules/ranked/ranked.service.js';
import { statsService } from '../../modules/stats/stats.service.js';
import { getRedisClient } from '../redis.js';
import { logger } from '../../core/logger.js';
import { withSpan } from '../../core/tracing.js';
import {
  generateRankedAiAvatarUrl,
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
): Promise<'aborted' | 'live' | 'failed'> {
  try {
    const result = await reservationService.abortLobby(lobbyId, path, opts);
    if (result.failed) {
      // The abort ERRORED: the lobby may survive as OUR stale waiting lobby —
      // not because a live draft won. Callers must not read the surviving
      // lobby as "committed elsewhere".
      return 'failed';
    }
    if (!result.aborted) {
      logger.info({ lobbyId }, 'compensateAbortLobby: draft committed elsewhere — not tearing down');
      // Do NOT touch Redis/sockets of a live lobby.
      return 'live';
    }
    const redis = getRedisClient();
    if (redis?.isOpen) await redis.del(rankedAiLobbyKey(lobbyId)).catch(() => undefined);
    await detachAllSocketsFromLobby(io, lobbyId).catch(() => undefined);
    return 'aborted';
  } catch (err) {
    // The abort itself succeeded or failed inside abortLobby (which never
    // throws); reaching here means post-abort idempotent cleanup failed.
    logger.warn({ err, lobbyId }, 'Failed to compensate-abort ranked AI lobby');
    return 'aborted';
  }
}

async function emitRankedPreparationFailure(params: {
  io: QuizballServer;
  userId: string;
  lobbyId: string;
  source: string;
  message: string;
}): Promise<void> {
  const { io, userId, lobbyId, source, message } = params;
  trackRankedQueueLeft({
    userId,
    source: 'server_abort',
    searchFound: false,
    searchId: null,
  });
  try {
    io.to(`user:${userId}`).emit('ranked:queue_left');
  } catch (err) {
    logger.warn({ err, userId, lobbyId, source }, 'Failed to emit ranked queue-left after AI preparation failure');
  }
  try {
    io.to(`user:${userId}`).emit('error', {
      code: 'MATCH_PREPARATION_FAILED',
      message,
      meta: { lobbyId, source },
    });
  } catch (err) {
    logger.warn({ err, userId, lobbyId, source }, 'Failed to emit ranked AI preparation error');
  }
  await userSessionGuardService.emitState(io, userId).catch((err) => {
    logger.warn({ err, userId, lobbyId, source }, 'Failed to emit session state after ranked AI preparation failure');
  });
}

/**
 * Terminal notification for failures inside the DELAYED ranked-AI callbacks
 * (match-found timer, draft-start timer), where the user may have moved on
 * since the search began. The authoritative session state is the gate:
 *   - a live match, a different lobby, or a NEW queue search → only re-emit
 *     session state (a queue_left/error here would clear a valid new search or
 *     contradict a match another actor committed);
 *   - no newer session → full preparation-failure sequence, otherwise the
 *     search/found UI spins until manual reload.
 * If the state read itself fails, fail open to the terminal events — a
 * spurious abort beats an infinite spinner.
 */
async function notifyRankedCallbackFailure(params: {
  io: QuizballServer;
  userId: string;
  lobbyId: string;
  source: string;
  message: string;
  /**
   * Outcome of the compensation that preceded this notify. When it FAILED, the
   * aborted lobby may survive in the session snapshot as OUR stale waiting
   * lobby — not as evidence of a committed draft — so it must not suppress the
   * terminal events (the pre-found spinner has no client watchdog).
   */
  compensation?: 'aborted' | 'live' | 'failed';
}): Promise<void> {
  const { io, userId, lobbyId, source, message, compensation } = params;
  let snapshot: Awaited<ReturnType<typeof userSessionGuardService.resolveState>> | null = null;
  try {
    snapshot = await userSessionGuardService.resolveState(userId);
  } catch (err) {
    logger.warn({ err, userId, lobbyId, source }, 'Failed to resolve session state before ranked callback-failure notify');
  }
  // ANY waitingLobbyId blocks the terminal notify — including this very lobby:
  // the session snapshot reports a committed (active-draft) lobby in
  // waitingLobbyId too, and compensation no-ops exactly when another actor
  // committed this lobby's draft. A genuinely deleted lobby cannot reappear
  // here (the snapshot is an authoritative DB read). CORRUPT_MULTI_STATE can
  // hide a different live lobby behind the primary — treat it as live.
  // EXCEPTION: when compensation FAILED, this very lobby surviving proves
  // nothing about commitment — only a DIFFERENT lobby/match/search suppresses.
  const ownLobbySuppresses = compensation !== 'failed';
  const hasNewerSession = Boolean(
    snapshot &&
    (snapshot.activeMatchId ||
      (snapshot.waitingLobbyId &&
        (ownLobbySuppresses || snapshot.waitingLobbyId !== lobbyId)) ||
      snapshot.queueSearchId ||
      snapshot.state === 'CORRUPT_MULTI_STATE')
  );
  if (hasNewerSession) {
    await userSessionGuardService.emitState(io, userId).catch((err) => {
      logger.warn({ err, userId, lobbyId, source }, 'Failed to re-emit session state after superseded ranked callback failure');
    });
    return;
  }
  await emitRankedPreparationFailure({ io, userId, lobbyId, source, message });
}

export async function startRankedAiForUser(
  io: QuizballServer,
  userId: string,
  options?: {
    skipSearchEmit?: boolean;
    searchDurationMs?: number;
  }
): Promise<boolean> {
  return withSpan('ranked.match_found.ai.prepare', {
    'quizball.user_id': userId,
  }, async (span) => {
    if (await hasRankedCancelRequest(userId)) {
      logger.info({ userId }, 'Ranked AI search preparation skipped because user cancelled search');
      span.setAttribute('quizball.skipped_cancelled', true);
      return false;
    }
    const playerProfile = await rankedService.ensureProfile(userId);
    // The lobby exists only as a reservation anchor until a persistent identity
    // is acquired. Ranked no longer creates ephemeral users under any condition.
    const lobby = await lobbiesRepo.createLobby({
      mode: 'ranked',
      hostUserId: userId,
      inviteCode: null,
      rankedContext: rankedService.buildAiMatchContext(playerProfile),
    });
    let selected: Awaited<ReturnType<typeof syntheticBotSelectionService.selectAndReserve>> = null;
    try {
      selected = await syntheticBotSelectionService.selectAndReserve({
        humanUserId: userId,
        humanProfile: playerProfile,
        lobbyId: lobby.id,
        allowOutOfBandFallback: true,
      });
    } catch (err) {
      logger.warn({ err, userId, lobbyId: lobby.id }, 'persistent-bot selection threw');
    }
    if (!selected) {
      await compensateAbortLobby(io, lobby.id);
      // A claimed queue search has already been removed from Redis by this
      // point. Send the same terminal signals as other preparation failures so
      // the client cannot retain its previous searching animation.
      await emitRankedPreparationFailure({
        io,
        userId,
        lobbyId: lobby.id,
        source: 'ranked_persistent_bot_unavailable',
        message: 'No ranked opponent is available right now. Please retry.',
      });
      return false;
    }

    const { bot } = selected;
    const persistentBotReservation = {
      botUserId: selected.reservation.botUserId,
      fence: selected.reservation.fence,
    };
    let prepared: {
      resolvedGeo: RankedAiOpponentGeo;
      aiUser: { id: string; nickname: string; avatar_url: string | null };
      opponentRp: number;
      favoriteClub: string;
    };

    // ANY throw after acquire compensates: release the reservation AND tear
    // down the lobby so no bot is stranded and no empty lobby is orphaned.
    try {
      const rankedContext = rankedService.buildPersistentBotMatchContext(bot.rp);
      const resolvedGeo = buildPersistentBotGeo({
        country: bot.country,
        home_city: bot.home_city,
        home_lat: bot.home_lat,
        home_lng: bot.home_lng,
      });
      const aiUser = {
        id: bot.user_id,
        nickname: bot.nickname ?? 'Player',
        avatar_url: bot.avatar_url ?? generateRankedAiAvatarUrl(96, bot.user_id),
      };
      prepared = {
        resolvedGeo,
        aiUser,
        opponentRp: bot.rp,
        favoriteClub: bot.favorite_club ?? generateRankedAiFavoriteClub(),
      };
      await lobbiesRepo.updateRankedContext(lobby.id, rankedContext);
      await lobbiesRepo.addMember(lobby.id, userId, true);
      await lobbiesRepo.addMember(lobby.id, aiUser.id, true);
      const redis = getRedisClient();
      if (redis?.isOpen) {
        await redis
          .set(rankedAiLobbyKey(lobby.id), aiUser.id, { EX: RANKED_AI_KEY_TTL_SEC })
          .catch((err) => {
            // The marker is an optimization. Draft resolution can recover the
            // persistent AI identity from the lobby members in Postgres.
            logger.warn({ err, lobbyId: lobby.id, botUserId: aiUser.id }, 'Failed to cache ranked AI lobby marker');
          });
      }
      await attachUserSocketsToLobby(io, userId, lobby.id);
      await emitLobbyState(io, lobby.id);
      await userSessionGuardService.emitState(io, userId);
    } catch (err) {
      logger.warn({ err, userId, lobbyId: lobby.id, botUserId: bot.user_id }, 'persistent-bot lobby build failed; compensating (locked release + teardown)');
      await compensateAbortLobby(io, lobby.id);
      await emitRankedPreparationFailure({
        io,
        userId,
        lobbyId: lobby.id,
        source: 'ranked_persistent_bot_setup',
        message: 'Match preparation failed. Please restart ranked matchmaking.',
      });
      return false;
    }
    const { resolvedGeo, aiUser, opponentRp, favoriteClub } = prepared;

    // Compensation extends through the timer calc + search-started emit +
    // scheduling: a throw ANYWHERE here (before the search-timer is installed)
    // must also release the reservation and tear down the lobby, else the bot is
    // stranded with no live flow to free it (Sol P2).
    try {
      span.setAttribute('quizball.lobby_id', lobby.id);
      span.setAttribute('quizball.ai_user_id', aiUser.id);
      span.setAttribute('quizball.persistent_bot', true);

      const searchDurationMs =
        options?.searchDurationMs ??
        harnessDelayMs(randomIntBetween(RANKED_SIM_SEARCH_MIN_MS, RANKED_SIM_SEARCH_MAX_MS));
      span.setAttribute('quizball.search_duration_ms', searchDurationMs);
      if (!options?.skipSearchEmit) {
        io.to(`user:${userId}`).emit('ranked:search_started', { durationMs: searchDurationMs });
      }
      logger.info(
        { lobbyId: lobby.id, userId, searchDurationMs, persistent: true, skipSearchEmit: options?.skipSearchEmit ?? false },
        'Ranked AI search started'
      );

      const startedLobbyId = lobby.id;
      setTimeout(
        () =>
          void handleRankedAiMatchFound({
            io,
            lobbyId: startedLobbyId,
            userId,
            aiUser,
            aiGeo: resolvedGeo,
            opponentRp,
            favoriteClub,
            lobbiesRepo,
            logger,
            foundModalMs: harnessDelayMs(RANKED_SIM_FOUND_MODAL_MS),
            startDraft,
          }),
        searchDurationMs
      );
      return true;
    } catch (err) {
      logger.warn({ err, userId, lobbyId: lobby.id, botUserId: persistentBotReservation.botUserId }, 'persistent-bot search scheduling failed; compensating (locked release + teardown)');
      await compensateAbortLobby(io, lobby.id);
      await emitRankedPreparationFailure({
        io,
        userId,
        lobbyId: lobby.id,
        source: 'ranked_persistent_bot_scheduling',
        message: 'Match preparation failed. Please restart ranked matchmaking.',
      });
      return false;
    }
  });
}

async function handleRankedAiMatchFound(params: {
  io: QuizballServer;
  lobbyId: string;
  userId: string;
  aiUser: { id: string; nickname: string | null; avatar_url: string | null };
  aiGeo: { city: string; country: string; countryCode: string; flag: string; lat: number; lon: number };
  opponentRp: number;
  favoriteClub: string;
  lobbiesRepo: RankedAiLobbiesRepo;
  logger: typeof import('../../core/logger.js').logger;
  foundModalMs: number;
  startDraft: typeof startDraft;
}): Promise<void> {
  const { io, lobbyId, userId, aiUser, aiGeo, opponentRp, favoriteClub, lobbiesRepo, logger, foundModalMs, startDraft } =
    params;

  // Every ranked AI flow now owns a persistent reservation, so all pre-match
  // exits use the same advisory-lock-serialized compensation path.
  const releasePreMatch = async (_path: 'match_found_cancel'): Promise<'aborted' | 'live' | 'failed'> => {
    return compensateAbortLobby(io, lobbyId);
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
      // down; compensate is a no-op on a missing lobby. Nobody else is proven to
      // notify the searcher (a server-side teardown emits nothing to this user),
      // so close the search UI unless a newer session owns them.
      const compensation = await releasePreMatch('match_found_cancel');
      await notifyRankedCallbackFailure({
        io,
        userId,
        lobbyId,
        source: 'ranked_ai_match_found_lobby_missing',
        message: 'Match preparation failed. Please restart ranked matchmaking.',
        compensation,
      });
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
      // free the reservation (still lobby-keyed) and clean up. The searcher may
      // still be staring at the spinner (an internal teardown emits nothing to
      // them) — the session-state guard skips the abort if they left themselves.
      const compensation = await releasePreMatch('match_found_cancel');
      await notifyRankedCallbackFailure({
        io,
        userId,
        lobbyId,
        source: 'ranked_ai_match_found_membership_missing',
        message: 'Match preparation failed. Please restart ranked matchmaking.',
        compensation,
      });
      return;
    }

    const supersedingSession = await getSupersedingSessionState(lobbiesRepo, userId, lobbyId);
    if (supersedingSession) {
      logger.info(
        { lobbyId, userId, aiUserId: aiUser.id, session: supersedingSession },
        'Ranked AI match_found skipped because user session moved elsewhere'
      );
      await compensateAbortLobby(io, lobbyId, 'cleanup_superseded_lobby');
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
        username: aiUser.nickname ?? 'Player',
        avatarUrl: aiUser.avatar_url,
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
          lobbiesRepo,
          logger,
          startDraft,
        }),
      foundModalMs
    );
  } catch (error) {
    // A throw here left the lobby wired but no draft scheduled by THIS flow.
    // Ranked is persistent-only, so compensateAbortLobby releases + tears down
    // under the lock (or no-ops if a reconnect already activated the draft).
    // Before this notify existed, an ordinary Redis/DB rejection here left the
    // searcher spinning forever — the last known silent-strand path (be#426).
    logger.warn({ error, lobbyId }, 'Failed during ranked AI search completion');
    const compensation = await compensateAbortLobby(io, lobbyId);
    await notifyRankedCallbackFailure({
      io,
      userId,
      lobbyId,
      source: 'ranked_ai_match_found_error',
      message: 'Match preparation failed. Please restart ranked matchmaking.',
      compensation,
    });
  }
}

// Longer than the 3s lobby-lock TTL: if the holder died, its lock has expired
// by the time we retry, so persistent contention means a LIVE actor owns the
// lobby transition — never a reason for destructive compensation.
const DRAFT_LOCK_BUSY_RETRY_MS = 3_500;

async function startRankedAiDraft(params: {
  io: QuizballServer;
  lobbyId: string;
  userId: string;
  aiUserId: string;
  lobbiesRepo: RankedAiLobbiesRepo;
  logger: typeof import('../../core/logger.js').logger;
  startDraft: typeof startDraft;
  lockBusyRetriesLeft?: number;
}): Promise<void> {
  const { io, lobbyId, userId, aiUserId, lobbiesRepo, logger, startDraft } = params;
  const lockBusyRetriesLeft = params.lockBusyRetriesLeft ?? 2;

  // Draft-start cancel/error ENDS this flow. For a PERSISTENT bot, tear the lobby
  // down entirely under the shared advisory lock (compensateAbortLobby →
  // abortLobby): there is no "release the bot but keep the lobby" path — a waiting
  // lobby with a freed bot could be activated by a reconnect and re-reserve the
  // bot elsewhere. If a concurrent reconnect already advanced the draft, the
  // locked abort observes 'active' and no-ops.
  const releasePreMatch = async (
    path: 'draft_start_cancel' | 'draft_start_error',
  ): Promise<'aborted' | 'live' | 'failed'> => {
    // draft_start_error may fire post-activation (committed_at set) → pass
    // teardown-intent. The in-lock live-match check keeps a concurrently-created
    // match alive and reclaims only a genuinely stuck draft.
    return compensateAbortLobby(io, lobbyId, path, { draftTeardown: path === 'draft_start_error' });
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
      // The user is on the match-found modal with no draft coming; close it out
      // unless a newer session owns them.
      const compensation = await releasePreMatch('draft_start_cancel');
      await notifyRankedCallbackFailure({
        io,
        userId,
        lobbyId,
        source: 'ranked_ai_draft_start_lobby_missing',
        message: 'Match preparation failed. Please restart ranked matchmaking.',
        compensation,
      });
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
      // Pre-activation superseded cleanup — we have not committed (no teardown).
      await compensateAbortLobby(io, lobbyId, 'cleanup_superseded_lobby');
      return;
    }
    const draftResult = await startDraft(io, lobbyId, { expectWaiting: true });
    if (draftResult === 'lock_busy') {
      // Another actor holds the lobby lock RIGHT NOW — it may be committing this
      // very draft. Retry after longer than the lock TTL; the re-entry re-runs
      // every guard (cancel, lobby state, superseding session) before trying
      // again, and the under-lock expectWaiting check makes a double-start
      // impossible even if the competitor wins between guard and start.
      if (lockBusyRetriesLeft > 0) {
        logger.info({ lobbyId, userId, lockBusyRetriesLeft }, 'Ranked AI draft start lock-busy; retrying');
        setTimeout(
          () =>
            void startRankedAiDraft({
              ...params,
              lockBusyRetriesLeft: lockBusyRetriesLeft - 1,
            }),
          harnessDelayMs(DRAFT_LOCK_BUSY_RETRY_MS)
        );
        return;
      }
      // Still contended after TTL-exceeding retries: a LIVE actor owns this
      // lobby's transition. Destructive compensation here could tear the lobby
      // down underneath them — do nothing; the client-side found-modal watchdog
      // is the backstop if that actor also fails to finish.
      logger.error({ lobbyId, userId }, 'Ranked AI draft start still lock-busy after retries; leaving lobby to the lock holder');
      return;
    }
    if (draftResult === 'already_active') {
      // A competitor committed this draft between our guard and the lock — the
      // live flow owns it; nothing to notify.
      logger.info({ lobbyId, userId }, 'Ranked AI draft start skipped: draft already committed by another actor');
      return;
    }
    if (draftResult === 'lobby_missing') {
      // Vanished between our re-read and startDraft's own re-read.
      const compensation = await releasePreMatch('draft_start_cancel');
      await notifyRankedCallbackFailure({
        io,
        userId,
        lobbyId,
        source: 'ranked_ai_draft_start_lobby_missing',
        message: 'Match preparation failed. Please restart ranked matchmaking.',
        compensation,
      });
      return;
    }
    // 'insufficient_categories' already notified the lobby room and reset ready
    // state inside startDraft; 'started' needs nothing more.
  } catch (error) {
    logger.warn({ error, lobbyId }, 'Failed to start ranked AI draft');
    // startDraft may have ACTIVATED (committed_at set) before throwing. The locked
    // abort's in-lock live-match check is the authoritative gate: if a reconnect
    // created a match, it no-ops (the live draft keeps the bot); only a stuck
    // no-match draft is reclaimed.
    const compensation = await releasePreMatch('draft_start_error');
    // Compensation may detach every socket from the lobby room. The user's
    // stable room remains reachable after teardown; the guarded notify also
    // covers the case where the error emit itself would have failed silently.
    await notifyRankedCallbackFailure({
      io,
      userId,
      lobbyId,
      source: 'ranked_ai_draft_start',
      message: 'Match preparation got stuck. Please restart ranked matchmaking.',
      compensation,
    });
  }
}
