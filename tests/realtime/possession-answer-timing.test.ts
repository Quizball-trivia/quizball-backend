import { describe, expect, it } from 'vitest';
import {
  CLIENT_TIME_SLACK_MS,
  REVEAL_ACK_GRACE_MS,
  resolveAnswerElapsedMs,
} from '../../src/realtime/possession-timing.js';
import { FRONTEND_REVEAL_MS, QUESTION_TIME_MS } from '../../src/realtime/possession-state.js';

const T = new Date('2026-07-04T12:00:00.000Z').getTime();
const shownAt = new Date(T).toISOString();

describe('resolveAnswerElapsedMs', () => {
  it('scores from a reveal ack when present', () => {
    const result = resolveAnswerElapsedMs({
      revealAtMs: T + 100,
      shownAt,
      deadlineAt: null,
      nowMs: T + 900,
      clientTimeMs: 700,
      questionTimeMs: QUESTION_TIME_MS,
    });

    expect(result).toMatchObject({
      elapsedMs: 800,
      source: 'reveal_ack',
      effectiveRevealAtMs: T + 100,
    });
  });

  it('clamps a late reveal ack to the grace upper bound', () => {
    const result = resolveAnswerElapsedMs({
      revealAtMs: T + 5000,
      shownAt,
      deadlineAt: null,
      nowMs: T + 4100,
      clientTimeMs: 900,
      questionTimeMs: QUESTION_TIME_MS,
    });

    expect(result.source).toBe('reveal_ack');
    expect(result.effectiveRevealAtMs).toBe(T + REVEAL_ACK_GRACE_MS);
    expect(result.elapsedMs).toBe(4100 - REVEAL_ACK_GRACE_MS);
  });

  it('clamps an early reveal ack to the pre-reveal lower bound', () => {
    const result = resolveAnswerElapsedMs({
      revealAtMs: T - 10_000,
      shownAt,
      deadlineAt: null,
      nowMs: T + 1400,
      clientTimeMs: 1400,
      questionTimeMs: QUESTION_TIME_MS,
    });

    expect(result.source).toBe('reveal_ack');
    expect(result.effectiveRevealAtMs).toBe(T - FRONTEND_REVEAL_MS);
    expect(result.elapsedMs).toBe(1400 + FRONTEND_REVEAL_MS);
  });

  it('uses client time when the predicted server elapsed is negative', () => {
    const result = resolveAnswerElapsedMs({
      revealAtMs: null,
      shownAt: new Date(T + 3000).toISOString(),
      deadlineAt: null,
      nowMs: T + 1400,
      clientTimeMs: 1400,
      questionTimeMs: QUESTION_TIME_MS,
    });

    expect(result).toMatchObject({
      elapsedMs: 1400,
      source: 'client_early',
      rawPredictedElapsedMs: -1600,
      clientElapsedMs: 1400,
    });
  });

  it('caps an over-penalizing predicted elapsed to client time plus slack', () => {
    const result = resolveAnswerElapsedMs({
      revealAtMs: null,
      shownAt,
      deadlineAt: null,
      nowMs: T + 4100,
      clientTimeMs: 900,
      questionTimeMs: QUESTION_TIME_MS,
    });

    expect(result).toMatchObject({
      elapsedMs: 900 + CLIENT_TIME_SLACK_MS,
      source: 'client_capped',
      predictedElapsedMs: 4100,
      clientElapsedMs: 900,
    });
  });

  it('uses predicted elapsed when it is close to client time', () => {
    const result = resolveAnswerElapsedMs({
      revealAtMs: null,
      shownAt,
      deadlineAt: null,
      nowMs: T + 1400,
      clientTimeMs: 1200,
      questionTimeMs: QUESTION_TIME_MS,
    });

    expect(result).toMatchObject({
      elapsedMs: 1400,
      source: 'authoritative',
    });
  });

  it('final-clamps resolved elapsed to the question duration', () => {
    const result = resolveAnswerElapsedMs({
      revealAtMs: null,
      shownAt,
      deadlineAt: null,
      nowMs: T + 40_000,
      clientTimeMs: 40_000,
      questionTimeMs: QUESTION_TIME_MS,
    });

    expect(result.elapsedMs).toBe(QUESTION_TIME_MS);
  });
});
