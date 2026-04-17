import { logger } from '../core/logger.js';
import { lobbiesService } from '../modules/lobbies/lobbies.service.js';
import { matchesRepo } from '../modules/matches/matches.repo.js';
import type { PossessionStatePayload } from '../modules/matches/matches.service.js';
import { acquireLock, releaseLock } from './locks.js';
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

// ── Constants ──

export const HALFTIME_DURATION_MS = 20000;
export const HALFTIME_POST_BAN_REVEAL_MS = 2000;
const HALFTIME_AI_BAN_DELAY_MIN_MS = 700;
const HALFTIME_AI_BAN_DELAY_MAX_MS = 1800;
// Matches FRONTEND HALFTIME_INTRO_MS — the client hides ban cards for this long
// while showing the score card. Without this extra delay on the first AI ban of
// a halftime, the AI bans before the player can even see the cards.
const HALFTIME_INTRO_DELAY_MS = 3000;

// ── Types ──

type SendQuestionFn = (io: QuizballServer, matchId: string, qIndex: number, opts?: { cache?: import('./match-cache.js').MatchCache; postReadyAck?: boolean }) => Promise<{ correctIndex: number } | null>;
type ResolveAiUserFn = (matchId: string) => Promise<string | null>;

export function createPossessionHalftime(deps: { sendQuestion: SendQuestionFn; resolveAiUserId: ResolveAiUserFn }) {
  const halftimeTimers = new Map<string, NodeJS.Timeout>();
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
    return Math.floor(Math.random() * (HALFTIME_AI_BAN_DELAY_MAX_MS - HALFTIME_AI_BAN_DELAY_MIN_MS + 1))
      + HALFTIME_AI_BAN_DELAY_MIN_MS;
  }

  function clearHalftimeAiBanTimer(matchId: string): void {
    const timer = halftimeAiBanTimers.get(matchId);
    if (!timer) return;
    clearTimeout(timer);
    halftimeAiBanTimers.delete(matchId);
  }

  function clearHalftimeTimer(matchId: string): void {
    const timer = halftimeTimers.get(matchId);
    if (timer) {
      clearTimeout(timer);
      halftimeTimers.delete(matchId);
    }
    clearHalftimeAiBanTimer(matchId);
  }

  function getHalftimeTurnSeat(state: PossessionStatePayload): Seat | null {
    const firstSeat = state.halftime.firstBanSeat ?? 2;
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
    matchId: string
  ): Promise<void> {
    if (state.halftime.categoryOptions.length >= 3) return;
    try {
      const match = await matchesRepo.getMatch(matchId);
      const lobbyId = match?.lobby_id ?? null;

      if (!state.halftime.firstBanSeat) {
        state.halftime.firstBanSeat = match?.is_dev
          ? (Math.random() < 0.5 ? 1 : 2)
          : 2;
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
      const primary = await selectExcluding(3, Array.from(excludedIds));
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
    return candidates[Math.floor(Math.random() * candidates.length)] ?? null;
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

    try {
      const cache = await getMatchCacheOrRebuild(matchId);
      if (!cache || cache.status !== 'active') return;
      const state = cache.statePayload;
      if (state.phase !== 'HALFTIME') return;

      const halftimeResult = resolveHalftimeResult(state);
      state.halftime.bans.seat1 = halftimeResult.seat1Ban;
      state.halftime.bans.seat2 = halftimeResult.seat2Ban;
      state.halftime.deadlineAt = null;

      const halfTwoCategoryId = halftimeResult.remainingCategoryId ?? cache.categoryAId;
      cache.categoryBId = halfTwoCategoryId;
      fireAndForget('setMatchCategoryB(finalizeHalftime)', async () => {
        await matchesRepo.setMatchCategoryB(matchId, halfTwoCategoryId);
      });

      state.half = 2;
      state.phase = 'NORMAL_PLAY';
      state.possessionDiff = 0;
      state.kickOffSeat = nextSeat(state.kickOffSeat);
      state.lastAttack.attackerSeat = null;
      state.halftime.firstBanSeat = null;
      state.currentQuestion = null;
      state.normalQuestionsAnsweredInHalf = 0;
      bumpStateVersion(state);

      cache.currentQuestion = null;
      cache.answers = {};
      await setMatchCache(cache);
      fireAndForget('setMatchStatePayload(finalizeHalftime)', async () => {
        await matchesRepo.setMatchStatePayload(matchId, state, cache.currentQIndex);
      });
      await emitMatchState(io, matchId, state);

      await deps.sendQuestion(io, matchId, cache.currentQIndex, { cache });
    } finally {
      clearHalftimeTimer(matchId);
      await releaseLock(lockKey, lock.token);
    }
  }

  function scheduleFinalizeHalftime(io: QuizballServer, matchId: string, delayMs: number): void {
    clearHalftimeTimer(matchId);
    const timer = setTimeout(() => {
      void finalizeHalftime(io, matchId).catch((error) => {
        logger.error({ error, matchId }, 'Failed to finalize halftime after both bans');
      });
    }, delayMs);
    halftimeTimers.set(matchId, timer);
  }

  function scheduleHalftimeTimeout(io: QuizballServer, matchId: string): void {
    clearHalftimeTimer(matchId);
    const timer = setTimeout(() => {
      void finalizeHalftime(io, matchId).catch((error) => {
        logger.error({ error, matchId }, 'Failed to finalize halftime timer');
      });
    }, HALFTIME_DURATION_MS);
    halftimeTimers.set(matchId, timer);
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

        const aiUserId = await deps.resolveAiUserId(matchId);
        if (!aiUserId) return;
        const aiPlayer = getCachedPlayer(cache, aiUserId);
        if (!aiPlayer) return;

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

        if (state.halftime.bans.seat1 && state.halftime.bans.seat2) {
          scheduleFinalizeHalftime(io, matchId, HALFTIME_POST_BAN_REVEAL_MS);
        }
      } finally {
        await releaseLock(lockKey, lock.token);
      }
    };

    void (async () => {
      // If no bans have been placed yet, this is the first AI ban of the halftime.
      // The client hides ban cards for HALFTIME_INTRO_DELAY_MS while showing the
      // score card, so add that to the thinking delay — otherwise the AI bans
      // before the player can see the cards.
      const cache = await getMatchCacheOrRebuild(matchId);
      const state = cache?.statePayload;
      const isInitialBan = Boolean(
        state && state.phase === 'HALFTIME' && !state.halftime.bans.seat1 && !state.halftime.bans.seat2
      );
      const baseDelay = isInitialBan ? HALFTIME_INTRO_DELAY_MS : 0;
      const delayMs = baseDelay + getHalftimeAiBanDelayMs();

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

  return {
    clearHalftimeTimer,
    clearHalftimeAiBanTimer,
    getHalftimeTurnSeat,
    uniqueDraftCategories,
    ensureHalftimeCategories,
    pickRandomCategoryId,
    resolveHalftimeResult,
    finalizeHalftime,
    scheduleFinalizeHalftime,
    scheduleHalftimeTimeout,
    schedulePossessionAiHalftimeBan,
  };
}
