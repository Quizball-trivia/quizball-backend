import { beforeEach, describe, expect, it, vi } from 'vitest';

const analytics = vi.hoisted(() => ({
  trackEvent: vi.fn(),
  stableAnalyticsEventUuid: vi.fn(),
}));

vi.mock('../../src/core/analytics.js', () => analytics);

import { trackStaleLobbyHealed } from '../../src/core/analytics/game-events.js';

describe('stale lobby analytics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('captures only bounded lobby attributes and idle duration', () => {
    trackStaleLobbyHealed({
      userId: 'user-1',
      lobbyId: 'lobby-1',
      mode: 'friendly',
      gameMode: 'auction',
      idleMs: 1_860_000,
    });

    expect(analytics.trackEvent).toHaveBeenCalledWith(
      'stale_lobby_healed',
      'user-1',
      {
        lobby_id: 'lobby-1',
        mode: 'friendly',
        game_mode: 'auction',
        idle_ms: 1_860_000,
      },
    );
  });
});
