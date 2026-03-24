import { describe, expect, it, vi } from 'vitest';
import { __possessionInternals } from '../../src/realtime/possession-match-flow.js';

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
});
