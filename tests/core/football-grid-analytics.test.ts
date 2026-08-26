import { beforeEach, describe, expect, it, vi } from 'vitest';

const analytics = vi.hoisted(() => ({
  trackEvent: vi.fn(),
  stableAnalyticsEventUuid: vi.fn((key: string) => `uuid:${key}`),
}));

vi.mock('../../src/core/analytics.js', () => analytics);

import {
  trackFootballGridMatchCompleted,
  trackFootballGridQueueJoined,
} from '../../src/core/analytics/game-events.js';

describe('Football Grid server analytics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses a retry-safe queue event identity and stable queue timestamp', () => {
    const queuedAt = '2026-08-20T10:00:00.000Z';
    trackFootballGridQueueJoined({
      userId: 'user-1',
      searchId: '12345678-1234-4123-8123-123456789012',
      locale: 'ka',
      queuedAt,
    });

    expect(analytics.trackEvent).toHaveBeenCalledWith(
      'football_grid_queue_joined',
      'user-1',
      {
        mode: 'football_grid',
        search_id_prefix: '12345678',
        locale: 'ka',
      },
      {
        uuid: 'uuid:football-grid:queue-joined:12345678-1234-4123-8123-123456789012:user-1',
        occurredAt: queuedAt,
      },
    );
  });

  it('emits one aggregate match completion without raw answer text', () => {
    trackFootballGridMatchCompleted({
      userId: 'user-1',
      matchId: 'match-1',
      origin: 'random',
      opponentType: 'human',
      result: 'win',
      completionReason: 'line',
      startedAt: '2026-08-20T10:00:00.000Z',
      endedAt: '2026-08-20T10:02:00.000Z',
      boardId: 'board-1',
      boardVersion: 4,
      boardDifficulty: 'normal',
      turns: 7,
      claimCount: 3,
      correctAnswers: 3,
      wrongAnswers: 1,
      ambiguousAnswers: 0,
      alreadyUsedAnswers: 1,
      passes: 1,
      noActionTimeouts: 0,
      averageResponseMs: 4_200,
      xpEarned: 70,
      coinsEarned: 300,
      tpEarned: 50,
      coinEligibilityReason: 'eligible',
      tpEligibilityReason: 'eligible',
    });

    expect(analytics.trackEvent).toHaveBeenCalledWith(
      'match_completed',
      'user-1',
      expect.objectContaining({
        mode: 'football_grid',
        result: 'win',
        duration_ms: 120_000,
        board_difficulty: 'normal',
        correct_answers: 3,
        wrong_answers: 1,
        average_response_ms: 4_200,
        xp_earned: 70,
        coins_earned: 300,
        tp_earned: 50,
        coin_eligibility_reason: 'eligible',
        tp_eligibility_reason: 'eligible',
      }),
      {
        uuid: 'uuid:football-grid:match_completed:match-1:user-1',
        occurredAt: '2026-08-20T10:02:00.000Z',
      },
    );
    expect(JSON.stringify(analytics.trackEvent.mock.calls)).not.toContain('submitted_text');
  });

  it('keeps no-contest terminals out of completed-match conversion counts', () => {
    trackFootballGridMatchCompleted({
      userId: 'user-1',
      matchId: 'match-2',
      origin: 'code',
      opponentType: 'human',
      result: 'draw',
      completionReason: 'loading_no_show',
      startedAt: '2026-08-20T10:00:00.000Z',
      endedAt: '2026-08-20T10:00:15.000Z',
      boardId: 'board-1',
      boardVersion: 4,
      boardDifficulty: 'normal',
      turns: 0,
      claimCount: 0,
      correctAnswers: 0,
      wrongAnswers: 0,
      ambiguousAnswers: 0,
      alreadyUsedAnswers: 0,
      passes: 0,
      noActionTimeouts: 0,
      averageResponseMs: null,
      xpEarned: 0,
      coinsEarned: 0,
      tpEarned: 0,
      coinEligibilityReason: 'no_contest',
      tpEligibilityReason: 'no_contest',
    });

    expect(analytics.trackEvent).toHaveBeenCalledWith(
      'match_abandoned',
      'user-1',
      expect.objectContaining({ completion_reason: 'loading_no_show' }),
      expect.objectContaining({ uuid: 'uuid:football-grid:match_abandoned:match-2:user-1' }),
    );
  });
});
