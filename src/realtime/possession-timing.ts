import type { PossessionStatePayload } from '../modules/matches/matches.service.js';
import { clamp } from './scoring.js';
import {
  buildPlayableQuestionTiming,
  FRONTEND_REVEAL_MS,
  PENALTY_INTRO_DELAY_MS,
  QUESTION_TIME_MS,
  ROUND_RESULT_DELAY_MS,
  TIMEOUT_RESOLVE_BUFFER_MS,
  TIMEOUT_RESOLVE_GRACE_MS,
} from './possession-state.js';
import type { MatchQuestionKind } from './socket.types.js';

export const REVEAL_ACK_GRACE_MS = 1500;
export const CLIENT_TIME_SLACK_MS = 1500;

export type AnswerElapsedSource =
  | 'reveal_ack'
  | 'client_early'
  | 'client_capped'
  | 'authoritative';

export interface ResolvedAnswerElapsed {
  elapsedMs: number;
  source: AnswerElapsedSource;
  predictedElapsedMs: number;
  rawPredictedElapsedMs: number;
  clientElapsedMs: number;
  revealAtMs: number | null;
  effectiveRevealAtMs: number | null;
}

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

function clampElapsedMs(value: number, questionTimeMs: number): number {
  if (!Number.isFinite(value)) return 0;
  return clamp(Math.round(value), 0, questionTimeMs);
}

function parseTimestampMs(value: string | null): number | null {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

export function clampRevealAckMs(revealAtMs: number, shownAt: string | null): number {
  if (!Number.isFinite(revealAtMs)) return Date.now();
  const shownAtMs = parseTimestampMs(shownAt);
  if (shownAtMs === null) return Math.round(revealAtMs);
  return clamp(
    Math.round(revealAtMs),
    shownAtMs - FRONTEND_REVEAL_MS,
    shownAtMs + REVEAL_ACK_GRACE_MS
  );
}

function computePredictedElapsedMs(params: {
  shownAt: string | null;
  deadlineAt: string | null;
  nowMs: number;
  clientTimeMs: number;
  questionTimeMs: number;
}): number {
  const shownAtMs = parseTimestampMs(params.shownAt);
  if (shownAtMs !== null) return Math.round(params.nowMs - shownAtMs);

  const deadlineAtMs = parseTimestampMs(params.deadlineAt);
  if (deadlineAtMs !== null) {
    return Math.round(params.questionTimeMs - (deadlineAtMs - params.nowMs));
  }

  return Math.round(params.clientTimeMs);
}

export function resolveAnswerElapsedMs(params: {
  revealAtMs?: number | null;
  shownAt: string | null;
  deadlineAt: string | null;
  nowMs: number;
  clientTimeMs: number;
  questionTimeMs: number;
}): ResolvedAnswerElapsed {
  const clientElapsedMs = clampElapsedMs(params.clientTimeMs, params.questionTimeMs);
  const rawPredictedElapsedMs = computePredictedElapsedMs(params);
  const predictedElapsedMs = clampElapsedMs(rawPredictedElapsedMs, params.questionTimeMs);

  if (typeof params.revealAtMs === 'number' && Number.isFinite(params.revealAtMs)) {
    const effectiveRevealAtMs = clampRevealAckMs(params.revealAtMs, params.shownAt);
    return {
      elapsedMs: clampElapsedMs(params.nowMs - effectiveRevealAtMs, params.questionTimeMs),
      source: 'reveal_ack',
      predictedElapsedMs,
      rawPredictedElapsedMs,
      clientElapsedMs,
      revealAtMs: Math.round(params.revealAtMs),
      effectiveRevealAtMs,
    };
  }

  if (rawPredictedElapsedMs < 0) {
    return {
      elapsedMs: clientElapsedMs,
      source: 'client_early',
      predictedElapsedMs,
      rawPredictedElapsedMs,
      clientElapsedMs,
      revealAtMs: null,
      effectiveRevealAtMs: null,
    };
  }

  if (rawPredictedElapsedMs > clientElapsedMs + CLIENT_TIME_SLACK_MS) {
    return {
      elapsedMs: clampElapsedMs(clientElapsedMs + CLIENT_TIME_SLACK_MS, params.questionTimeMs),
      source: 'client_capped',
      predictedElapsedMs,
      rawPredictedElapsedMs,
      clientElapsedMs,
      revealAtMs: null,
      effectiveRevealAtMs: null,
    };
  }

  return {
    elapsedMs: predictedElapsedMs,
    source: 'authoritative',
    predictedElapsedMs,
    rawPredictedElapsedMs,
    clientElapsedMs,
    revealAtMs: null,
    effectiveRevealAtMs: null,
  };
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
