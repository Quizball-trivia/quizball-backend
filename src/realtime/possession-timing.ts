import type { PossessionStatePayload } from '../modules/matches/matches.service.js';
import { clamp } from './scoring.js';
import {
  buildPlayableQuestionTiming,
  PENALTY_INTRO_DELAY_MS,
  QUESTION_TIME_MS,
  ROUND_RESULT_DELAY_MS,
  TIMEOUT_RESOLVE_BUFFER_MS,
  TIMEOUT_RESOLVE_GRACE_MS,
} from './possession-state.js';
import type { MatchQuestionKind } from './socket.types.js';

export function getNextQuestionDelayMs(params: {
  phase: PossessionStatePayload['phase'];
}): number {
  if (params.phase === 'PENALTY_SHOOTOUT') {
    return PENALTY_INTRO_DELAY_MS;
  }
  return ROUND_RESULT_DELAY_MS;
}

export function computeAuthoritativeTimeMs(
  questionTiming: {
    shownAt: string | null;
    deadlineAt: string | null;
  },
  nowMs: number,
  fallbackTimeMs: number,
  questionTimeMs = QUESTION_TIME_MS
): number {
  if (questionTiming.shownAt) {
    const shownAtMs = new Date(questionTiming.shownAt).getTime();
    if (Number.isFinite(shownAtMs)) {
      return clamp(Math.round(nowMs - shownAtMs), 0, questionTimeMs);
    }
  }

  if (questionTiming.deadlineAt) {
    const deadlineMs = new Date(questionTiming.deadlineAt).getTime();
    if (Number.isFinite(deadlineMs)) {
      return clamp(Math.round(questionTimeMs - (deadlineMs - nowMs)), 0, questionTimeMs);
    }
  }

  return clamp(Math.round(fallbackTimeMs), 0, questionTimeMs);
}

export function toAuthoritativeTimeMs(
  questionTiming: {
    shown_at: string | null;
    deadline_at: string | null;
  },
  nowMs: number,
  fallbackTimeMs: number,
  questionTimeMs = QUESTION_TIME_MS
): number {
  return computeAuthoritativeTimeMs(
    { shownAt: questionTiming.shown_at, deadlineAt: questionTiming.deadline_at },
    nowMs,
    fallbackTimeMs,
    questionTimeMs
  );
}

export function toAuthoritativeTimeMsFromCache(
  questionTiming: {
    shownAt: string | null;
    deadlineAt: string | null;
  },
  nowMs: number,
  fallbackTimeMs: number,
  questionTimeMs = QUESTION_TIME_MS
): number {
  return computeAuthoritativeTimeMs(questionTiming, nowMs, fallbackTimeMs, questionTimeMs);
}

export function computeResumedPossessionTiming(params: {
  shownAtRaw: string | null;
  deadlineAtRaw: string | null;
  pauseStartedAtMs: number;
  resumedAtMs: number;
  qIndex: number;
  state: PossessionStatePayload;
  questionKind: MatchQuestionKind;
}): { playableAt: Date; deadlineAt: Date } {
  const shownAtMs = params.shownAtRaw ? new Date(params.shownAtRaw).getTime() : Number.NaN;
  const deadlineAtMs = params.deadlineAtRaw ? new Date(params.deadlineAtRaw).getTime() : Number.NaN;

  if (!Number.isFinite(shownAtMs) || !Number.isFinite(deadlineAtMs) || deadlineAtMs <= shownAtMs) {
    return buildPlayableQuestionTiming({
      qIndex: params.qIndex,
      state: params.state,
      questionKind: params.questionKind,
    });
  }

  const effectivePauseStartMs = Math.min(params.pauseStartedAtMs, deadlineAtMs);
  const revealRemainingMs = Math.max(0, shownAtMs - effectivePauseStartMs);
  const answerRemainingMs = Math.max(0, deadlineAtMs - effectivePauseStartMs);

  // PAUSE the scoring clock during disconnect: shift playableAt forward by
  // the disconnect duration so that timeMs = now - playableAt reflects only
  // ACTUAL play time, not time spent disconnected.
  //
  // elapsedPlayMs = how long the player was actively playing before the pause
  // (from question show to disconnect). playableAt is set so that
  // (now - playableAt) = elapsedPlayMs + time_since_reconnect, i.e. the
  // disconnect gap is excluded from scoring.
  //
  // Case 1 — question already revealed (shownAt <= pauseStart):
  //   elapsedPlayMs = pauseStart - shownAt
  //   playableAt = resumedAt - elapsedPlayMs
  //   → timeMs after answering 2s post-reconnect = elapsedPlayMs + 2
  //
  // Case 2 — question not yet revealed (shownAt > pauseStart, e.g. during
  // the reveal animation): revealRemainingMs > 0, schedule the reveal
  // relative to resumedAt as before.
  const playableAtMs = revealRemainingMs > 0
    ? params.resumedAtMs + revealRemainingMs
    : params.resumedAtMs - Math.max(0, effectivePauseStartMs - shownAtMs);

  return {
    playableAt: new Date(playableAtMs),
    deadlineAt: new Date(params.resumedAtMs + answerRemainingMs),
  };
}

export function shouldResolveExpiredQuestionOnResume(
  deadlineAtRaw: string | null,
  pauseStartedAtMs: number
): boolean {
  const deadlineAtMs = deadlineAtRaw ? new Date(deadlineAtRaw).getTime() : Number.NaN;
  return Number.isFinite(deadlineAtMs)
    && Number.isFinite(pauseStartedAtMs)
    && deadlineAtMs <= pauseStartedAtMs;
}

export function shouldResolveQuestionTimeoutNow(
  deadlineAtRaw: string | null,
  nowMs: number,
  graceMs = TIMEOUT_RESOLVE_GRACE_MS,
  bufferMs = TIMEOUT_RESOLVE_BUFFER_MS
): boolean {
  const deadlineAtMs = deadlineAtRaw ? new Date(deadlineAtRaw).getTime() : Number.NaN;
  return Number.isFinite(deadlineAtMs)
    && Number.isFinite(nowMs)
    && deadlineAtMs + graceMs + bufferMs <= nowMs;
}
