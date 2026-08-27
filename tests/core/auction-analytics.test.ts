import { beforeEach, describe, expect, it, vi } from 'vitest';

const analytics = vi.hoisted(() => ({
  trackEvent: vi.fn(),
  stableAnalyticsEventUuid: vi.fn((key: string) => `uuid:${key}`),
}));

vi.mock('../../src/core/analytics.js', () => analytics);

import {
  trackAuctionMatchCompleted,
  trackAuctionMatchFound,
  trackAuctionMatchStarted,
  type TrackAuctionMatchCompletedOptions,
} from '../../src/core/analytics/game-events.js';

const COMPLETED_BASE: TrackAuctionMatchCompletedOptions = {
  userId: 'user-1',
  matchId: 'match-1',
  origin: 'queue',
  placement: 1,
  seatCount: 3,
  humanCount: 1,
  botCount: 2,
  profit: 12_000_000,
  adjustedProfit: 15_000_000,
  chemistry: 7,
  totalTrueValue: 90_000_000,
  budgetRemaining: 3_000_000,
  squadComplete: true,
  forfeited: false,
  roundsPlayed: 11,
  coinsEarned: 500,
  auctionPointsEarned: 50,
  startedAt: '2026-08-27T10:00:00.000Z',
  endedAt: '2026-08-27T10:08:00.000Z',
};

function lastCall() {
  return analytics.trackEvent.mock.calls.at(-1)!;
}

describe('Auction server analytics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('emits a retry-safe match_found keyed on match + user', () => {
    const foundAt = new Date('2026-08-27T09:59:00.000Z');
    trackAuctionMatchFound({
      userId: 'user-1',
      matchId: 'match-1',
      humanCount: 1,
      botCount: 2,
      locale: 'ka',
      formation: '4-3-3',
      occurredAt: foundAt,
    });

    expect(analytics.trackEvent).toHaveBeenCalledWith(
      'auction_match_found',
      'user-1',
      {
        match_id: 'match-1',
        mode: 'auction',
        variant: 'auction',
        human_count: 1,
        bot_count: 2,
        opponent_is_ai: true,
        locale: 'ka',
        formation: '4-3-3',
      },
      {
        uuid: 'uuid:auction:match-found:match-1:user-1',
        occurredAt: foundAt,
      },
    );
  });

  it('reuses the canonical match_started name so auction joins cross-mode charts', () => {
    trackAuctionMatchStarted({
      userId: 'user-1',
      matchId: 'match-1',
      origin: 'lobby',
      humanCount: 3,
      botCount: 0,
      locale: 'en',
      formation: '4-4-2',
      occurredAt: '2026-08-27T10:00:00.000Z',
    });

    const [event, distinctId, properties, delivery] = lastCall();
    expect(event).toBe('match_started');
    expect(distinctId).toBe('user-1');
    expect(properties).toMatchObject({
      mode: 'auction',
      variant: 'auction',
      origin: 'lobby',
      human_count: 3,
      bot_count: 0,
      // An all-human match must not be reported as facing AI.
      opponent_is_ai: false,
    });
    expect(delivery).toEqual({
      uuid: 'uuid:auction:match-started:match-1:user-1',
      occurredAt: '2026-08-27T10:00:00.000Z',
    });
  });

  it('reports placement, bot count and derived duration on completion', () => {
    trackAuctionMatchCompleted(COMPLETED_BASE);

    const [event, distinctId, properties, delivery] = lastCall();
    expect(event).toBe('match_completed');
    expect(distinctId).toBe('user-1');
    expect(properties).toMatchObject({
      mode: 'auction',
      variant: 'auction',
      origin: 'queue',
      placement: 1,
      won: true,
      seat_count: 3,
      human_count: 1,
      bot_count: 2,
      opponent_is_ai: true,
      profit: 12_000_000,
      adjusted_profit: 15_000_000,
      rounds_played: 11,
      coins_earned: 500,
      auction_points_earned: 50,
      duration_ms: 480_000,
      duration_sec: 480,
    });
    expect(delivery).toEqual({
      uuid: 'uuid:auction:match-completed:match-1:user-1',
      occurredAt: '2026-08-27T10:08:00.000Z',
    });
  });

  it('marks only placement 1 as a win', () => {
    trackAuctionMatchCompleted({ ...COMPLETED_BASE, placement: 3 });
    expect(lastCall()[2]).toMatchObject({ placement: 3, won: false });
  });

  it('sends null rather than NaN for scoring fields missing on legacy state', () => {
    trackAuctionMatchCompleted({
      ...COMPLETED_BASE,
      profit: Number.NaN,
      adjustedProfit: Number.NaN,
      budgetRemaining: Number.POSITIVE_INFINITY,
    });

    expect(lastCall()[2]).toMatchObject({
      profit: null,
      adjusted_profit: null,
      budget_remaining: null,
      // Finite neighbours are untouched.
      chemistry: 7,
      total_true_value: 90_000_000,
    });
  });

  it('distinguishes "no AP awarded at all" from "awarded zero AP"', () => {
    trackAuctionMatchCompleted({ ...COMPLETED_BASE, auctionPointsEarned: null });
    expect(lastCall()[2]).toMatchObject({ auction_points_earned: null });

    trackAuctionMatchCompleted({ ...COMPLETED_BASE, auctionPointsEarned: 0 });
    expect(lastCall()[2]).toMatchObject({ auction_points_earned: 0 });
  });

  it('falls back to null duration when timestamps are unparseable', () => {
    trackAuctionMatchCompleted({ ...COMPLETED_BASE, startedAt: 'not-a-date' });
    expect(lastCall()[2]).toMatchObject({ duration_ms: null, duration_sec: null });
  });

  it('never reports a negative duration when a clock skews backwards', () => {
    trackAuctionMatchCompleted({
      ...COMPLETED_BASE,
      startedAt: '2026-08-27T10:08:00.000Z',
      endedAt: '2026-08-27T10:00:00.000Z',
    });
    expect(lastCall()[2]).toMatchObject({ duration_ms: 0, duration_sec: 0 });
  });
});
