import { logger } from '../core/logger.js';
import { matchesRepo } from '../modules/matches/matches.repo.js';
import { POSSESSION_QUESTIONS_PER_HALF } from '../modules/matches/matches.service.js';
import { acquireLock, releaseLock } from './locks.js';
import { getMatchCacheOrRebuild, setMatchCache } from './match-cache.js';
import { HALFTIME_DURATION_MS } from './possession-halftime.js';
import {
  clearAiAnswerTimer,
  clearHalftimeTimer,
  clearQuestionTimer,
  emitMatchState,
  ensureHalftimeCategories,
  fireAndForget,
  scheduleHalftimeTimeout,
  schedulePossessionAiHalftimeBan,
  sendPossessionMatchQuestion,
} from './possession-match-flow.js';
import { bumpStateVersion, nextSeat } from './possession-state.js';
import type { QuizballServer } from './socket-server.js';

export async function devSkipToPossessionPhase(
  io: QuizballServer,
  matchId: string,
  target: 'halftime' | 'last_attack' | 'shot' | 'penalties' | 'penalty_ban' | 'second_half'
): Promise<void> {
  // Hold the match-scoped lock so the cache mutation can't interleave with
  // a concurrent resolver, timer, or halftime handler.
  const lockKey = `lock:match:${matchId}:dev_skip`;
  const lock = await acquireLock(lockKey, 5000);
  if (!lock.acquired || !lock.token) {
    logger.warn({ matchId, target }, 'Dev skip: could not acquire match lock');
    return;
  }

  try {
    const cache = await getMatchCacheOrRebuild(matchId);
    if (!cache || cache.status !== 'active') return;

    clearQuestionTimer(matchId, cache.currentQIndex);
    clearAiAnswerTimer(matchId, cache.currentQIndex);
    clearHalftimeTimer(matchId);

    const state = cache.statePayload;
    const nextQIndex = cache.currentQIndex + 1;

    switch (target) {
      case 'halftime':
        state.normalQuestionsAnsweredInHalf = POSSESSION_QUESTIONS_PER_HALF;
        state.phase = 'HALFTIME';
        state.halftime.deadlineAt = new Date(Date.now() + HALFTIME_DURATION_MS).toISOString();
        await ensureHalftimeCategories(state, cache.categoryAId, matchId);
        state.currentQuestion = null;
        break;

      case 'second_half':
        state.half = 2;
        state.phase = 'NORMAL_PLAY';
        state.possessionDiff = 0;
        state.kickOffSeat = nextSeat(state.kickOffSeat);
        state.lastAttack.attackerSeat = null;
        state.normalQuestionsAnsweredInHalf = 0;
        state.halftime.categoryOptions = [];
        state.halftime.firstBanSeat = null;
        state.halftime.readyDeferCount = 0;
        state.halftime.bans.seat1 = null;
        state.halftime.bans.seat2 = null;
        state.halftime.deadlineAt = null;
        state.currentQuestion = null;
        break;

      case 'last_attack':
      case 'shot':
        state.phase = 'LAST_ATTACK';
        state.lastAttack.attackerSeat = 1;
        state.currentQuestion = null;
        break;

      case 'penalties':
        state.half = 2;
        state.normalQuestionsAnsweredInHalf = POSSESSION_QUESTIONS_PER_HALF;
        state.goals = { seat1: 1, seat2: 1 };
        state.phase = 'PENALTY_SHOOTOUT';
        state.penalty = {
          round: 1,
          shooterSeat: 1,
          suddenDeath: false,
          kicksTaken: { seat1: 0, seat2: 0 },
        };
        state.currentQuestion = null;
        break;

      case 'penalty_ban':
        // Full penalty flow: land in the category-ban interlude (reusing the
        // HALFTIME ban machinery with purpose='penalty'), which finalizes into
        // the shootout. Mirrors the 'halftime' case but for penalties.
        state.half = 2;
        state.normalQuestionsAnsweredInHalf = POSSESSION_QUESTIONS_PER_HALF;
        state.goals = { seat1: 1, seat2: 1 };
        state.phase = 'HALFTIME';
        state.halftime.purpose = 'penalty';
        state.halftime.uiReadyAt = null;
        state.halftime.readyDeferCount = 0;
        state.halftime.firstBanSeat = null;
        state.halftime.bans = { seat1: null, seat2: null };
        state.halftime.deadlineAt = new Date(Date.now() + HALFTIME_DURATION_MS).toISOString();
        await ensureHalftimeCategories(state, cache.categoryAId, matchId, cache.categoryBId);
        state.currentQuestion = null;
        break;
    }

    cache.currentQIndex = nextQIndex;
    cache.currentQuestion = null;
    cache.answers = {};
    bumpStateVersion(state);
    await setMatchCache(cache);
    fireAndForget('setMatchStatePayload(devSkip)', async () => {
      await matchesRepo.setMatchStatePayload(matchId, state, nextQIndex);
    });
    await emitMatchState(io, matchId, state);

    if (target === 'halftime' || target === 'penalty_ban') {
      scheduleHalftimeTimeout(io, matchId);
      schedulePossessionAiHalftimeBan(io, matchId);
    } else {
      await sendPossessionMatchQuestion(io, matchId, nextQIndex);
    }

    logger.info({ matchId, target, phase: state.phase }, 'Dev skip: state modified');
  } finally {
    await releaseLock(lockKey, lock.token).catch(() => {});
  }
}
