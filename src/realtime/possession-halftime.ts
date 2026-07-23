import { logger } from '../core/logger.js';
import { getRandom } from '../core/rng.js';
import { harnessDelayMs, isHarnessFastTimers } from '../core/harness-timing.js';
import { trackPossessionPhaseEntered } from '../core/analytics/game-events.js';
import { lobbiesService } from '../modules/lobbies/lobbies.service.js';
import { matchesRepo } from '../modules/matches/matches.repo.js';
import {
  RANKED_RECENT_CATEGORY_MODE,
  userRecentCategoriesRepo,
} from '../modules/user-recent-categories/user-recent-categories.repo.js';
import type { PossessionStatePayload } from '../modules/matches/matches.service.js';
import { acquireLock, releaseLock } from './locks.js';
import { matchPauseKey } from './match-keys.js';
import { cancelRealtimeTimer, scheduleRealtimeTimer } from './realtime-timer-scheduler.js';
import {
  getCachedPlayer,
  getMatchCacheOrRebuild,
  setMatchCache,
} from './match-cache.js';
import type { QuizballServer } from './socket-server.js';
import type { DraftCategory } from './socket.types.js';
import {
  type Seat,
  nextSeat,
  seatToBanKey,
  bumpStateVersion,
  toMatchStatePayload,
} from './possession-state.js';
import { getRedisClient } from './redis.js';

// ── Constants ──

export const HALFTIME_DURATION_MS = 20000;
export const HALFTIME_POST_BAN_REVEAL_MS = 2000;
const HALFTIME_AI_BAN_DELAY_MIN_MS = 700;
const HALFTIME_AI_BAN_DELAY_MAX_MS = 1800;
const HALFTIME_AI_BAN_NO_UI_READY_DELAY_MS = 3500;
// How many times finalizeHalftime extends the deadline waiting for a client
// `match:halftime_ui_ready` before force-opening the ban window. 3 × 20s on
// top of the initial 20s ≈ 80s of patience for slow/backgrounded clients,
// bounded so a client that never signals can't stall the match forever.
const HALFTIME_READY_DEFER_MAX = 3;

// ── Types ──

type SendQuestionFn = (io: QuizballServer, matchId: string, qIndex: number, opts?: { cache?: import('./match-cache.js').MatchCache; postReadyAck?: boolean }) => Promise<{ correctIndex: number } | null>;
type ResolveAiUserFn = (matchId: string) => Promise<string | null>;

export function createPossessionHalftime(deps: { sendQuestion: SendQuestionFn; resolveAiUserId: ResolveAiUserFn }) {
  const halftimeAiBanTimers = new Map<string, NodeJS.Timeout>();

  function fireAndForget(label: string, fn: () => Promise<unknown>): void {
    fn().catch((error) => {
      logger.error({ error, label }, 'Fire-and-forget DB write failed');
    });
  }

  async function emitMatchState(io: QuizballServer, matchId: string, state: PossessionStatePayload): Promise<void> {
    io.to(`match:${matchId}`).emit('match:state', toMatchStatePayload(matchId, state));
  }

  function getHalftimeAiBanDelayMs(): number {
    return Math.floor(getRandom() * (HALFTIME_AI_BAN_DELAY_MAX_MS - HALFTIME_AI_BAN_DELAY_MIN_MS + 1))
      + HALFTIME_AI_BAN_DELAY_MIN_MS;
  }

  async function getPauseStartedAt(matchId: string): Promise<string | null> {
    const redis = getRedisClient();
    if (!redis || !redis.isOpen) return null;
    return redis.get(matchPauseKey(matchId));
  }

  function clearHalftimeAiBanTimer(matchId: string): void {
    const timer = halftimeAiBanTimers.get(matchId);
    if (!timer) return;
    clearTimeout(timer);
    halftimeAiBanTimers.delete(matchId);
  }

  function clearAllHalftimeAiBanTimers(): void {
    for (const timer of halftimeAiBanTimers.values()) {
      clearTimeout(timer);
    }
    halftimeAiBanTimers.clear();
  }

  function clearHalftimeTimer(matchId: string): void {
    void cancelRealtimeTimer('possession_halftime', matchId).catch((error) => {
      logger.warn({ error, matchId }, 'Failed to cancel possession halftime timer');
    });
    clearHalftimeAiBanTimer(matchId);
  }

  function getHalftimeTurnSeat(state: PossessionStatePayload): Seat | null {
    // Default to seat 1 (human) when firstBanSeat hasn't been set yet. The
    // round-resolver entry path schedules the AI ban BEFORE ensureHalftimeCategories
    // assigns firstBanSeat, so a `?? 2` default made the AI think it was its turn
    // and ban before the human ever saw the cards. Human-first mirrors the draft
    // ban flow (human bans, then the AI responds).
    const firstSeat = state.halftime.firstBanSeat ?? 1;
    const secondSeat = nextSeat(firstSeat);
    const firstKey = seatToBanKey(firstSeat);
    const secondKey = seatToBanKey(secondSeat);

    if (!state.halftime.bans[firstKey]) return firstSeat;
    if (!state.halftime.bans[secondKey]) return secondSeat;
    return null;
  }

  function uniqueDraftCategories(categories: DraftCategory[]): DraftCategory[] {
    const seen = new Set<string>();
    const unique: DraftCategory[] = [];
    for (const category of categories) {
      if (seen.has(category.id)) continue;
      seen.add(category.id);
      unique.push(category);
    }
    return unique;
  }

  async function ensureHalftimeCategories(
    state: PossessionStatePayload,
    categoryAId: string,
    matchId: string,
    categoryBId?: string | null
  ): Promise<void> {
    if (state.halftime.categoryOptions.length >= 3) return;
    try {
      const match = await matchesRepo.getMatch(matchId);
      const lobbyId = match?.lobby_id ?? null;

      if (!state.halftime.firstBanSeat) {
        // Human (seat 1) bans first — matches the working draft flow where the
        // AI ban is only scheduled after the human bans, so the player always
        // sees the cards and takes their turn before the AI acts.
        state.halftime.firstBanSeat = 1;
      }

      if (!Array.isArray(state.halftime.firstHalfShownCategoryIds) || state.halftime.firstHalfShownCategoryIds.length === 0) {
        if (lobbyId) {
          const firstHalfOptions = await lobbiesService.getLobbyCategories(lobbyId);
          state.halftime.firstHalfShownCategoryIds = uniqueDraftCategories(firstHalfOptions).map((category) => category.id);
        } else {
          state.halftime.firstHalfShownCategoryIds = [];
        }
      }

      const useRankedCategories = state.variant === 'ranked_sim';
      const selectExcluding = useRankedCategories
        ? lobbiesService.selectRandomRankedCategoriesExcluding.bind(lobbiesService)
        : lobbiesService.selectRandomCategoriesExcluding.bind(lobbiesService);
      const selectAny = useRankedCategories
        ? lobbiesService.selectRandomRankedCategories.bind(lobbiesService)
        : lobbiesService.selectRandomCategories.bind(lobbiesService);

      const excludedIds = new Set<string>([categoryAId, ...state.halftime.firstHalfShownCategoryIds]);
      // Penalty ban: also exclude the second-half category so penalties don't
      // re-offer a category that was just played.
      if (state.halftime.purpose === 'penalty' && categoryBId) {
        excludedIds.add(categoryBId);
      }

      let primary: DraftCategory[];
      if (useRankedCategories) {
        // Ranked: also avoid each human player's recently played categories
        // (soft — relaxed oldest-first if the pool would drop below 3). AI
        // users never have recents recorded, so excluding them just skips a
        // useless lookup.
        let recentAvoidUserIds: string[] = [];
        try {
          const [cache, aiUserId] = await Promise.all([
            getMatchCacheOrRebuild(matchId),
            deps.resolveAiUserId(matchId),
          ]);
          recentAvoidUserIds = (cache?.players ?? [])
            .map((player) => player.userId)
            .filter((userId) => userId !== aiUserId);
        } catch (error) {
          logger.warn({ error, matchId }, 'Failed to resolve players for halftime recent-category filter');
        }
        const selection = await lobbiesService.selectRankedCategoriesForDraft({
          count: 3,
          userIds: recentAvoidUserIds,
          excludeCategoryIds: Array.from(excludedIds),
        });
        primary = selection.categories;
      } else {
        primary = await selectExcluding(3, Array.from(excludedIds));
      }
      let categories = uniqueDraftCategories(primary).filter((category) => !excludedIds.has(category.id));

      if (categories.length < 3) {
        const fallback = await selectAny(9);
        categories = uniqueDraftCategories([...categories, ...fallback]).filter((category) => !excludedIds.has(category.id));
      }

      if (categories.length < 3) {
        logger.warn(
          {
            matchId,
            firstHalfShownCategoryIds: state.halftime.firstHalfShownCategoryIds,
            categoryAId,
            availableCount: categories.length,
          },
          'Insufficient unique halftime categories excluding first-half draft categories; relaxing exclusion'
        );
        const relaxed = await selectExcluding(3, [categoryAId]);
        categories = uniqueDraftCategories([...categories, ...relaxed]).filter((category) => category.id !== categoryAId);
      }

      state.halftime.categoryOptions = categories.slice(0, 3);
      state.halftime.bans = { seat1: null, seat2: null };
    } catch (error) {
      logger.error({ error }, 'Failed to initialize halftime category options');
      state.halftime.categoryOptions = [];
      state.halftime.bans = { seat1: null, seat2: null };
    }
  }

  function pickRandomCategoryId(
    categoryIds: string[],
    excludedCategoryIds: Set<string>
  ): string | null {
    const candidates = categoryIds.filter((categoryId) => !excludedCategoryIds.has(categoryId));
    if (candidates.length === 0) return null;
    return candidates[Math.floor(getRandom() * candidates.length)] ?? null;
  }

  function resolveHalftimeResult(
    state: PossessionStatePayload
  ): {
    seat1Ban: string | null;
    seat2Ban: string | null;
    remainingCategoryId: string | null;
  } {
    const categoryIds = state.halftime.categoryOptions.map((category) => category.id);
    if (categoryIds.length === 0) {
      return { seat1Ban: null, seat2Ban: null, remainingCategoryId: null };
    }

    const validCategoryIds = new Set(categoryIds);
    let seat1Ban = validCategoryIds.has(state.halftime.bans.seat1 ?? '') ? state.halftime.bans.seat1 : null;
    let seat2Ban = validCategoryIds.has(state.halftime.bans.seat2 ?? '') ? state.halftime.bans.seat2 : null;

    if (!seat1Ban) {
      seat1Ban = pickRandomCategoryId(categoryIds, new Set()) ?? null;
    }

    const seat2Preferred = seat2Ban && seat2Ban !== seat1Ban ? seat2Ban : null;
    if (!seat2Preferred) {
      seat2Ban = pickRandomCategoryId(categoryIds, new Set(seat1Ban ? [seat1Ban] : []));
      if (!seat2Ban) {
        seat2Ban = pickRandomCategoryId(categoryIds, new Set()) ?? seat2Ban;
      }
    } else {
      seat2Ban = seat2Preferred;
    }

    const remaining = categoryIds.filter((categoryId) => categoryId !== seat1Ban && categoryId !== seat2Ban);
    const remainingCategoryId = remaining[0]
      ?? categoryIds.find((categoryId) => categoryId !== seat1Ban)
      ?? categoryIds[0]
      ?? null;

    return {
      seat1Ban: seat1Ban ?? null,
      seat2Ban: seat2Ban ?? null,
      remainingCategoryId,
    };
  }

  async function finalizeHalftime(io: QuizballServer, matchId: string): Promise<void> {
    const lockKey = `lock:match:${matchId}:halftime`;
    const lock = await acquireLock(lockKey, 5000);
    if (!lock.acquired || !lock.token) return;

    let keepHalftimeTimers = false;
    try {
      const cache = await getMatchCacheOrRebuild(matchId);
      if (!cache || cache.status !== 'active') return;
      const state = cache.statePayload;
      if (state.phase !== 'HALFTIME') return;
      const pauseStartedAt = await getPauseStartedAt(matchId);
      if (pauseStartedAt) {
        logger.info(
          {
            eventName: 'match:halftime_finalize',
            matchId,
            pauseStartedAt,
            half: state.half,
            purpose: state.halftime.purpose,
          },
          'Possession halftime finalize skipped: match paused'
        );
        return;
      }

      const isPenaltyBan = state.halftime.purpose === 'penalty';
      const hadSeat1Ban = Boolean(state.halftime.bans.seat1);
      const hadSeat2Ban = Boolean(state.halftime.bans.seat2);
      const uiReadyAt = state.halftime.uiReadyAt;
      const deadlineAt = state.halftime.deadlineAt;
      const uiReadyForDeadline = Boolean(deadlineAt && uiReadyAt === deadlineAt);
      const needsReadyDefer = !uiReadyForDeadline && !hadSeat1Ban && !hadSeat2Ban;
      const aiUserId = needsReadyDefer ? await deps.resolveAiUserId(matchId) : null;
      if (needsReadyDefer && aiUserId && !isHarnessFastTimers()) {
        const deferCount = state.halftime.readyDeferCount ?? 0;
        if (deferCount < HALFTIME_READY_DEFER_MAX) {
          // No client has confirmed the ban cards are visible yet. Extend the
          // window WITHOUT forging uiReadyAt — previously this branch set
          // uiReadyAt = deadlineAt, which force-opened the ban window and let
          // the AI ban silently before the player ever saw the cards. The AI
          // ban scheduler stays gated until a real match:halftime_ui_ready
          // (which rebases the deadline and re-arms the AI) or the defer cap
          // below force-opens the window.
          const rebasedDeadlineAt = new Date(Date.now() + HALFTIME_DURATION_MS).toISOString();
          state.halftime.deadlineAt = rebasedDeadlineAt;
          state.halftime.readyDeferCount = deferCount + 1;
          bumpStateVersion(state);
          await setMatchCache(cache);
          fireAndForget('setMatchStatePayload(finalizeHalftime:deferUntilReady)', async () => {
            await matchesRepo.setMatchStatePayload(matchId, state, cache.currentQIndex);
          });
          await emitMatchState(io, matchId, state);
          logger.info(
            {
              eventName: 'match:halftime_finalize',
              matchId,
              half: state.half,
              purpose: state.halftime.purpose,
              deadlineAt,
              rebasedDeadlineAt,
              deferCount: deferCount + 1,
              maxDefers: HALFTIME_READY_DEFER_MAX,
            },
            'Possession halftime finalize deferred until ban window is ready'
          );
          scheduleHalftimeTimeout(io, matchId);
          keepHalftimeTimers = true;
          return;
        }
      }
      if (needsReadyDefer && aiUserId) {
        // Defer cap exhausted (or harness): no client ever signalled ui_ready.
        // Force the ban window open so the match still finishes — the AI bans,
        // and the next deadline auto-resolves the human's missing ban.
        const rebasedDeadlineAt = new Date(Date.now() + HALFTIME_DURATION_MS).toISOString();
        state.halftime.deadlineAt = rebasedDeadlineAt;
        state.halftime.uiReadyAt = rebasedDeadlineAt;
        bumpStateVersion(state);
        await setMatchCache(cache);
        fireAndForget('setMatchStatePayload(finalizeHalftime:forceOpen)', async () => {
          await matchesRepo.setMatchStatePayload(matchId, state, cache.currentQIndex);
        });
        await emitMatchState(io, matchId, state);
        logger.warn(
          {
            eventName: 'match:halftime_finalize',
            matchId,
            half: state.half,
            purpose: state.halftime.purpose,
            deadlineAt,
            rebasedDeadlineAt,
            aiUserId,
            deferCount: state.halftime.readyDeferCount ?? 0,
          },
          'Possession halftime ban window force-opened without client ui_ready'
        );
        scheduleHalftimeTimeout(io, matchId);
        schedulePossessionAiHalftimeBan(io, matchId);
        keepHalftimeTimers = true;
        return;
      }
      if (needsReadyDefer && !aiUserId) {
        logger.info(
          {
            eventName: 'match:halftime_finalize',
            matchId,
            half: state.half,
            purpose: state.halftime.purpose,
            deadlineAt,
          },
          'Possession halftime auto-resolving missing bans because match has no AI halftime actor'
        );
      }
      const timeoutTurnSeat = getHalftimeTurnSeat(state);
      if (timeoutTurnSeat) {
        const aiUserIdForTimeout = await deps.resolveAiUserId(matchId);
        const aiPlayer = aiUserIdForTimeout ? getCachedPlayer(cache, aiUserIdForTimeout) : null;
        const timeoutTurnKey = seatToBanKey(timeoutTurnSeat);
        if (aiPlayer && aiPlayer.seat !== timeoutTurnSeat && !state.halftime.bans[timeoutTurnKey]) {
          const otherSeatKey = seatToBanKey(nextSeat(timeoutTurnSeat));
          const otherBan = state.halftime.bans[otherSeatKey];
          const excluded = new Set<string>();
          if (otherBan) excluded.add(otherBan);
          const categoryIds = state.halftime.categoryOptions.map((category) => category.id);
          const autoBanCategoryId = pickRandomCategoryId(categoryIds, excluded);
          if (autoBanCategoryId) {
            state.halftime.bans[timeoutTurnKey] = autoBanCategoryId;
            state.halftime.deadlineAt = null;
            state.halftime.uiReadyAt = null;
            state.halftime.readyDeferCount = 0;
            bumpStateVersion(state);

            await setMatchCache(cache);
            fireAndForget('setMatchStatePayload(finalizeHalftime:autoFillHumanBan)', async () => {
              await matchesRepo.setMatchStatePayload(matchId, state, cache.currentQIndex);
            });
            await emitMatchState(io, matchId, state);
            logger.info(
              {
                eventName: 'match:halftime_finalize',
                matchId,
                half: state.half,
                purpose: state.halftime.purpose,
                autoFilledSeat: timeoutTurnSeat,
                categoryId: autoBanCategoryId,
                aiUserId: aiUserIdForTimeout,
              },
              'Possession halftime auto-filled player ban; scheduling AI response'
            );

            schedulePossessionAiHalftimeBan(io, matchId);
            keepHalftimeTimers = true;
            return;
          }
        }
      }

      const halftimeResult = resolveHalftimeResult(state);
      const autoFilledSeat1Ban = !hadSeat1Ban && Boolean(halftimeResult.seat1Ban);
      const autoFilledSeat2Ban = !hadSeat2Ban && Boolean(halftimeResult.seat2Ban);

      if (autoFilledSeat1Ban || autoFilledSeat2Ban) {
        state.halftime.bans.seat1 = halftimeResult.seat1Ban;
        state.halftime.bans.seat2 = halftimeResult.seat2Ban;
        state.halftime.deadlineAt = null;
        state.halftime.uiReadyAt = null;
        state.halftime.readyDeferCount = 0;
        state.halftime.firstBanSeat = null;
        bumpStateVersion(state);

        await setMatchCache(cache);
        fireAndForget('setMatchStatePayload(finalizeHalftime:autoFillReveal)', async () => {
          await matchesRepo.setMatchStatePayload(matchId, state, cache.currentQIndex);
        });
        await emitMatchState(io, matchId, state);
        logger.info(
          {
            eventName: 'match:halftime_finalize',
            matchId,
            half: state.half,
            purpose: state.halftime.purpose,
            autoFilledSeat1Ban,
            autoFilledSeat2Ban,
            seat1Ban: halftimeResult.seat1Ban,
            seat2Ban: halftimeResult.seat2Ban,
            chosenCategoryId: halftimeResult.remainingCategoryId,
            revealMs: HALFTIME_POST_BAN_REVEAL_MS,
          },
          'Possession halftime auto-filled missing bans; revealing before finalize'
        );

        scheduleFinalizeHalftime(io, matchId, HALFTIME_POST_BAN_REVEAL_MS);
        keepHalftimeTimers = true;
        return;
      }

      state.halftime.bans.seat1 = halftimeResult.seat1Ban;
      state.halftime.bans.seat2 = halftimeResult.seat2Ban;
      state.halftime.deadlineAt = null;
      state.halftime.uiReadyAt = null;
      state.halftime.readyDeferCount = 0;
      state.halftime.firstBanSeat = null;

      const chosenCategoryId = halftimeResult.remainingCategoryId ?? cache.categoryBId ?? cache.categoryAId;

      if (isPenaltyBan) {
        // Penalty ban → enter the shootout with the chosen category. Keep the
        // recorded second-half category (cache/DB categoryBId) untouched; the
        // penalty category lives only in state.penaltyCategoryId.
        state.penaltyCategoryId = chosenCategoryId;
        state.phase = 'PENALTY_SHOOTOUT';
        state.penalty.round = 1;
        state.penalty.shooterSeat = 1;
        state.penalty.suddenDeath = false;
        state.penalty.kicksTaken = { seat1: 0, seat2: 0 };
        state.halftime.purpose = 'second_half';
        state.currentQuestion = null;
        bumpStateVersion(state);

        // Phase-entered analytics moved here: the round resolver no longer sees a
        // direct →PENALTY_SHOOTOUT transition (it now goes via this ban interlude).
        try {
          for (const player of cache.players) {
            trackPossessionPhaseEntered({ userId: player.userId, matchId, phase: 'penalty' });
          }
        } catch (err) {
          logger.warn({ err, matchId }, 'possession_phase_entered (penalty) analytics failed');
        }
      } else {
        const halfTwoCategoryId = chosenCategoryId;
        cache.categoryBId = halfTwoCategoryId;
        fireAndForget('setMatchCategoryB(finalizeHalftime)', async () => {
          await matchesRepo.setMatchCategoryB(matchId, halfTwoCategoryId);
        });

        // The ban survivor is now ACTUALLY used for the second half — record
        // it as recently played for the real (non-AI) players so future
        // drafts avoid it. Best-effort, off the halftime hot path.
        if (state.variant === 'ranked_sim') {
          const playerUserIds = cache.players.map((player) => player.userId);
          fireAndForget('recordRecentCategory(finalizeHalftime)', async () => {
            const aiUserId = await deps.resolveAiUserId(matchId);
            const humanUserIds = playerUserIds.filter((userId) => userId !== aiUserId);
            await userRecentCategoriesRepo.recordPlayedCategoryForUsers({
              userIds: humanUserIds,
              categoryId: halfTwoCategoryId,
              mode: RANKED_RECENT_CATEGORY_MODE,
            });
          });
        }

        state.half = 2;
        state.phase = 'NORMAL_PLAY';
        state.possessionDiff = 0;
        state.kickOffSeat = nextSeat(state.kickOffSeat);
        state.lastAttack.attackerSeat = null;
        state.currentQuestion = null;
        state.normalQuestionsAnsweredInHalf = 0;
        bumpStateVersion(state);
      }

      cache.currentQuestion = null;
      cache.answers = {};
      cache.revealAcks = {};
      await setMatchCache(cache);
      fireAndForget('setMatchStatePayload(finalizeHalftime)', async () => {
        await matchesRepo.setMatchStatePayload(matchId, state, cache.currentQIndex);
      });
      await emitMatchState(io, matchId, state);
      logger.info(
        {
          eventName: 'match:halftime_finalize',
          matchId,
          half: state.half,
          purpose: isPenaltyBan ? 'penalty' : 'second_half',
          uiReady: Boolean(uiReadyAt && uiReadyAt === deadlineAt),
          autoFilledSeat1Ban,
          autoFilledSeat2Ban,
          seat1Ban: halftimeResult.seat1Ban,
          seat2Ban: halftimeResult.seat2Ban,
          chosenCategoryId,
        },
        'Possession halftime finalized'
      );

      await deps.sendQuestion(io, matchId, cache.currentQIndex, { cache });
    } finally {
      if (!keepHalftimeTimers) {
        clearHalftimeTimer(matchId);
      }
      await releaseLock(lockKey, lock.token);
    }
  }

  function scheduleFinalizeHalftime(_io: QuizballServer, matchId: string, delayMs: number): void {
    clearHalftimeTimer(matchId);
    // Collapse the post-ban reveal wait in the harness (prod untouched).
    delayMs = harnessDelayMs(delayMs);
    void scheduleRealtimeTimer('possession_halftime', matchId, new Date(Date.now() + delayMs), {
      kind: 'possession_halftime',
      matchId,
    }).catch((error) => {
      logger.error({ error, matchId }, 'Failed to schedule halftime post-ban finalize timer');
    });
  }

  function scheduleHalftimeTimeout(_io: QuizballServer, matchId: string): void {
    clearHalftimeTimer(matchId);
    void (async () => {
      const cache = await getMatchCacheOrRebuild(matchId);
      const deadlineAtRaw = cache?.statePayload.phase === 'HALFTIME'
        ? cache.statePayload.halftime.deadlineAt
        : null;
      const deadlineAtMs = deadlineAtRaw ? new Date(deadlineAtRaw).getTime() : Number.NaN;
      const dueAt = Number.isFinite(deadlineAtMs)
        ? new Date(deadlineAtMs)
        : new Date(Date.now() + HALFTIME_DURATION_MS);

      await scheduleRealtimeTimer('possession_halftime', matchId, dueAt, {
        kind: 'possession_halftime',
        matchId,
      });
    })().catch((error) => {
      logger.error({ error, matchId }, 'Failed to schedule halftime timer');
    });
  }

  function schedulePossessionAiHalftimeBan(io: QuizballServer, matchId: string): void {
    clearHalftimeAiBanTimer(matchId);

    const runBan = async () => {
      const lockKey = `lock:match:${matchId}:halftime_ban`;
      const lock = await acquireLock(lockKey, 3000);
      if (!lock.acquired || !lock.token) return;

      try {
        const cache = await getMatchCacheOrRebuild(matchId);
        if (!cache || cache.status !== 'active') return;
        const state = cache.statePayload;
        if (state.phase !== 'HALFTIME') return;
        const pauseStartedAt = await getPauseStartedAt(matchId);
        if (pauseStartedAt) {
          logger.info(
            {
              eventName: 'match:halftime_ai_ban',
              matchId,
              pauseStartedAt,
              half: state.half,
              purpose: state.halftime.purpose,
            },
            'Possession halftime AI ban skipped: match paused'
          );
          return;
        }

        const aiUserId = await deps.resolveAiUserId(matchId);
        if (!aiUserId) return;
        const aiPlayer = getCachedPlayer(cache, aiUserId);
        if (!aiPlayer || (aiPlayer.seat !== 1 && aiPlayer.seat !== 2)) return;

        const aiSeatKey = seatToBanKey(aiPlayer.seat);
        if (state.halftime.bans[aiSeatKey]) return;
        const turnSeat = getHalftimeTurnSeat(state);
        if (!turnSeat || aiPlayer.seat !== turnSeat) return;

        const options = state.halftime.categoryOptions.map((category) => category.id);
        if (options.length === 0) return;
        const otherSeatKey = aiSeatKey === 'seat1' ? 'seat2' : 'seat1';
        const otherBan = state.halftime.bans[otherSeatKey];
        const excluded = new Set<string>();
        if (otherBan) excluded.add(otherBan);
        const aiCategoryId = pickRandomCategoryId(options, excluded);
        if (!aiCategoryId) return;

        state.halftime.bans[aiSeatKey] = aiCategoryId;
        bumpStateVersion(state);

        await setMatchCache(cache);
        fireAndForget('setMatchStatePayload(halftimeAiBan)', async () => {
          await matchesRepo.setMatchStatePayload(matchId, state, cache.currentQIndex);
        });
        await emitMatchState(io, matchId, state);
        logger.info(
          {
            eventName: 'match:halftime_ai_ban',
            matchId,
            aiUserId,
            aiSeat: aiPlayer.seat,
            categoryId: aiCategoryId,
            half: state.half,
            purpose: state.halftime.purpose,
            uiReady: Boolean(state.halftime.uiReadyAt && state.halftime.uiReadyAt === state.halftime.deadlineAt),
          },
          'Possession halftime AI ban applied'
        );

        if (state.halftime.bans.seat1 && state.halftime.bans.seat2) {
          scheduleFinalizeHalftime(io, matchId, HALFTIME_POST_BAN_REVEAL_MS);
        }
      } finally {
        await releaseLock(lockKey, lock.token);
      }
    };

    void (async () => {
      const cache = await getMatchCacheOrRebuild(matchId);
      const state = cache?.statePayload;
      const isInitialBan = Boolean(
        state && state.phase === 'HALFTIME' && !state.halftime.bans.seat1 && !state.halftime.bans.seat2
      );
      const uiReadyForDeadline = Boolean(
        state?.halftime.deadlineAt
        && state.halftime.uiReadyAt === state.halftime.deadlineAt
      );
      // Never let the AI take the FIRST ban before a client confirms the ban
      // cards are visible (`match:halftime_ui_ready` re-invokes this scheduler;
      // finalizeHalftime's bounded defer force-opens the window if no client
      // ever signals). The harness has no client, so it keeps the fixed delay.
      if (isInitialBan && !uiReadyForDeadline && !isHarnessFastTimers()) {
        logger.info(
          { eventName: 'match:halftime_ai_ban', matchId, reason: 'awaiting_ui_ready' },
          'Possession halftime AI ban deferred until client UI ready'
        );
        return;
      }
      // Harness collapses the AI-ban think time so matches don't sit ~3.5s at
      // each halftime (prod untouched unless REGRESSION_FAST_TIMERS).
      const delayMs = harnessDelayMs(
        isInitialBan && !uiReadyForDeadline
          ? HALFTIME_AI_BAN_NO_UI_READY_DELAY_MS
          : getHalftimeAiBanDelayMs(),
      );
      logger.info(
        {
          eventName: 'match:halftime_ai_ban',
          matchId,
          delayMs,
          isInitialBan,
          uiReadyForDeadline,
        },
        'Possession halftime AI ban scheduled'
      );

      const timer = setTimeout(() => {
        runBan()
          .catch((error) => {
            logger.warn({ error, matchId }, 'Failed to process halftime AI ban');
          })
          .finally(() => {
            halftimeAiBanTimers.delete(matchId);
          });
      }, delayMs);

      halftimeAiBanTimers.set(matchId, timer);
    })().catch((error) => {
      logger.warn({ error, matchId }, 'Failed to schedule halftime AI ban');
    });
  }

  async function handlePossessionHalftimeUiReady(
    io: QuizballServer,
    userId: string,
    matchId: string
  ): Promise<void> {
    // Both players can emit `halftime:ui_ready` near-simultaneously after
    // the result screen closes. Serialize the read-modify-write through a
    // Redis lock and persist `uiReadyAt` on the shared halftime state so
    // the second emitter — possibly handled by a different Node instance —
    // sees the first instance's mark.
    const lockKey = `lock:match:${matchId}:halftime_ui_ready`;
    const lock = await acquireLock(lockKey, 3000);
    if (!lock.acquired || !lock.token) return;

    try {
      const cache = await getMatchCacheOrRebuild(matchId);
      if (!cache || cache.status !== 'active') return;
      const state = cache.statePayload;
      if (state.phase !== 'HALFTIME') return;
      if (!state.halftime.deadlineAt) return;

      const player = getCachedPlayer(cache, userId);
      if (!player) return;

      if (state.halftime.uiReadyAt === state.halftime.deadlineAt) {
        logger.info(
          {
            eventName: 'match:halftime_ui_ready',
            matchId,
            userId,
            half: state.half,
            deadlineAt: state.halftime.deadlineAt,
          },
          'Possession halftime UI ready already recorded'
        );
        schedulePossessionAiHalftimeBan(io, matchId);
        return;
      }

      const newDeadlineAt = new Date(Date.now() + HALFTIME_DURATION_MS).toISOString();
      state.halftime.deadlineAt = newDeadlineAt;
      state.halftime.uiReadyAt = newDeadlineAt;
      bumpStateVersion(state);
      await setMatchCache(cache);
      fireAndForget('setMatchStatePayload(halftimeUiReady)', async () => {
        await matchesRepo.setMatchStatePayload(matchId, state, cache.currentQIndex);
      });
      await emitMatchState(io, matchId, state);
      logger.info(
        {
          eventName: 'match:halftime_ui_ready',
          matchId,
          userId,
          half: state.half,
          deadlineAt: newDeadlineAt,
        },
        'Possession halftime UI ready recorded'
      );

      scheduleHalftimeTimeout(io, matchId);
      schedulePossessionAiHalftimeBan(io, matchId);
    } finally {
      await releaseLock(lockKey, lock.token);
    }
  }

  async function resumePossessionHalftimeAfterPause(
    io: QuizballServer,
    matchId: string,
    pauseStartedAtMs: number
  ): Promise<boolean> {
    const lockKey = `lock:match:${matchId}:halftime_resume`;
    const lock = await acquireLock(lockKey, 3000);
    if (!lock.acquired || !lock.token) return false;

    try {
      const cache = await getMatchCacheOrRebuild(matchId);
      if (!cache || cache.status !== 'active') return false;
      const state = cache.statePayload;
      if (state.phase !== 'HALFTIME') return false;

      const previousDeadlineAt = state.halftime.deadlineAt;
      const previousDeadlineMs = previousDeadlineAt ? new Date(previousDeadlineAt).getTime() : Number.NaN;
      const pausedAtMs = Number.isFinite(pauseStartedAtMs) && pauseStartedAtMs > 0
        ? pauseStartedAtMs
        : Date.now();
      const remainingAtPauseMs = Number.isFinite(previousDeadlineMs)
        ? Math.max(0, previousDeadlineMs - pausedAtMs)
        : HALFTIME_DURATION_MS;
      const rebasedDeadlineAt = new Date(Date.now() + remainingAtPauseMs).toISOString();
      const uiReadyWasForDeadline = Boolean(
        previousDeadlineAt && state.halftime.uiReadyAt === previousDeadlineAt
      );

      state.halftime.deadlineAt = rebasedDeadlineAt;
      if (uiReadyWasForDeadline) {
        state.halftime.uiReadyAt = rebasedDeadlineAt;
      }
      bumpStateVersion(state);
      await setMatchCache(cache);
      fireAndForget('setMatchStatePayload(halftimeResume)', async () => {
        await matchesRepo.setMatchStatePayload(matchId, state, cache.currentQIndex);
      });
      await emitMatchState(io, matchId, state);
      scheduleHalftimeTimeout(io, matchId);
      if (uiReadyWasForDeadline) {
        schedulePossessionAiHalftimeBan(io, matchId);
      }
      logger.info(
        {
          eventName: 'match:halftime_resume',
          matchId,
          half: state.half,
          purpose: state.halftime.purpose,
          previousDeadlineAt,
          rebasedDeadlineAt,
          remainingAtPauseMs,
          uiReadyWasForDeadline,
        },
        'Possession halftime deadline rebased after pause'
      );
      return true;
    } finally {
      await releaseLock(lockKey, lock.token);
    }
  }

  return {
    clearHalftimeTimer,
    clearHalftimeAiBanTimer,
    clearAllHalftimeAiBanTimers,
    getHalftimeTurnSeat,
    uniqueDraftCategories,
    ensureHalftimeCategories,
    pickRandomCategoryId,
    resolveHalftimeResult,
    finalizeHalftime,
    scheduleFinalizeHalftime,
    scheduleHalftimeTimeout,
    schedulePossessionAiHalftimeBan,
    handlePossessionHalftimeUiReady,
    resumePossessionHalftimeAfterPause,
  };
}
