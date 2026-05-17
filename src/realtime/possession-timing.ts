import type { PossessionStatePayload } from '../modules/matches/matches.service.js';
import { clamp } from './scoring.js';
import {
  buildPlayableQuestionTiming,
  PENALTY_INTRO_DELAY_MS,
  QUESTION_TIME_MS,
  ROUND_RESULT_DELAY_MS,
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

  return {
    playableAt: new Date(params.resumedAtMs + revealRemainingMs),
    deadlineAt: new Date(params.resumedAtMs + answerRemainingMs),
  };
}
