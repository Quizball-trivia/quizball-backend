import { describe, expect, it, vi } from 'vitest';
import { __possessionInternals } from '../../src/realtime/possession-match-flow.js';
import {
  shouldResolveExpiredQuestionOnResume,
  shouldResolveQuestionTimeoutNow,
} from '../../src/realtime/possession-timing.js';

const { buildPlayableQuestionTiming, computeAuthoritativeTimeMs } = __possessionInternals;

describe('possession authoritative timer fix', () => {
  it('computes the same authoritative elapsed time for both clients from shared shownAt', () => {
    const now = new Date('2026-03-24T12:00:04.000Z');
    const shownAt = '2026-03-24T12:00:00.000Z';

    const fastClientElapsed = computeAuthoritativeTimeMs(
      { shownAt, deadlineAt: null },
      now.getTime(),
      9500
    );
    const slowClientElapsed = computeAuthoritativeTimeMs(
      { shownAt, deadlineAt: null },
      now.getTime(),
      1200
    );

    expect(fastClientElapsed).toBe(4000);
    expect(slowClientElapsed).toBe(4000);
  });

  it('falls back to deadlineAt when shownAt is missing', () => {
    const now = new Date('2026-03-24T12:00:07.500Z');
    const deadlineAt = '2026-03-24T12:00:10.000Z';

    const elapsed = computeAuthoritativeTimeMs(
      { shownAt: null, deadlineAt },
      now.getTime(),
      1200
    );

    expect(elapsed).toBe(7500);
  });

  it('clamps to zero before the question becomes playable', () => {
    const now = new Date('2026-03-24T11:59:59.000Z');
    const shownAt = '2026-03-24T12:00:00.000Z';

    const elapsed = computeAuthoritativeTimeMs(
      { shownAt, deadlineAt: null },
      now.getTime(),
      8000
    );

    expect(elapsed).toBe(0);
  });

  it('builds a shared first-question timing window from server time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-24T12:00:00.000Z'));

    const timing = buildPlayableQuestionTiming({
      qIndex: 0,
      state: {
        half: 1,
        normalQuestionsAnsweredInHalf: 0,
      },
    });

    expect(timing.playableAt.toISOString()).toBe('2026-03-24T12:00:05.000Z');
    expect(timing.deadlineAt.toISOString()).toBe('2026-03-24T12:00:15.000Z');

    vi.useRealTimers();
  });

  it('builds a full transition and reveal window for the first second-half question', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-24T12:00:00.000Z'));

    const timing = buildPlayableQuestionTiming({
      qIndex: 6,
      state: {
        half: 2,
        normalQuestionsAnsweredInHalf: 0,
      },
    });

    expect(timing.playableAt.toISOString()).toBe('2026-03-24T12:00:05.500Z');
    expect(timing.deadlineAt.toISOString()).toBe('2026-03-24T12:00:15.500Z');

    vi.useRealTimers();
  });

  it('resolves instead of replaying when a question expired before disconnect pause', () => {
    const deadlineAt = '2026-03-24T12:00:30.000Z';
    const pauseStartedAtMs = Date.parse('2026-03-24T12:00:31.000Z');

    expect(shouldResolveExpiredQuestionOnResume(deadlineAt, pauseStartedAtMs)).toBe(true);
  });

  it('does not resolve on resume when the disconnect pause preserved answer time', () => {
    const deadlineAt = '2026-03-24T12:00:30.000Z';
    const pauseStartedAtMs = Date.parse('2026-03-24T12:00:29.000Z');

    expect(shouldResolveExpiredQuestionOnResume(deadlineAt, pauseStartedAtMs)).toBe(false);
  });

  it('resolves stale active questions immediately after timeout grace has elapsed', () => {
    const deadlineAt = '2026-03-24T12:00:30.000Z';
    const nowMs = Date.parse('2026-03-24T12:00:30.300Z');

    expect(shouldResolveQuestionTimeoutNow(deadlineAt, nowMs)).toBe(true);
  });
});
