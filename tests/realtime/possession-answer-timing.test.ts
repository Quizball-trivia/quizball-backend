import { describe, expect, it } from 'vitest';
import {
  CLIENT_TIME_SLACK_MS,
  resolveAnswerElapsedMs,
} from '../../src/realtime/possession-timing.js';
import { QUESTION_TIME_MS } from '../../src/realtime/possession-state.js';

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

  it('scores from the actual server-received reveal when the UI unlocks late', () => {
    const result = resolveAnswerElapsedMs({
      revealAtMs: T + 5000,
      shownAt,
      deadlineAt: null,
      nowMs: T + 5700,
      clientTimeMs: 700,
      questionTimeMs: QUESTION_TIME_MS,
    });

    expect(result.source).toBe('reveal_ack');
    expect(result.effectiveRevealAtMs).toBe(T + 5000);
    expect(result.elapsedMs).toBe(700);
  });

  it('preserves a very late server-received reveal instead of charging delivery delay', () => {
    const result = resolveAnswerElapsedMs({
      revealAtMs: T + 12_000,
      shownAt,
      deadlineAt: null,
      nowMs: T + 12_500,
      clientTimeMs: 500,
      questionTimeMs: 30_000,
    });

    expect(result.source).toBe('reveal_ack');
    expect(result.effectiveRevealAtMs).toBe(T + 12_000);
    expect(result.elapsedMs).toBe(500);
  });

  it('preserves an ack that looks early when the dispatch replica clock is ahead', () => {
    const result = resolveAnswerElapsedMs({
      revealAtMs: T - 5_300,
      shownAt,
      deadlineAt: null,
      nowMs: T - 4_600,
      clientTimeMs: 700,
      questionTimeMs: QUESTION_TIME_MS,
    });

    expect(result.source).toBe('reveal_ack');
    expect(result.effectiveRevealAtMs).toBe(T - 5_300);
    expect(result.elapsedMs).toBe(700);
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
