import { afterEach, describe, expect, it, vi } from 'vitest';
import '../setup.js';

const originalFastTimers = process.env.REGRESSION_FAST_TIMERS;

afterEach(() => {
  if (originalFastTimers === undefined) {
    delete process.env.REGRESSION_FAST_TIMERS;
  } else {
    process.env.REGRESSION_FAST_TIMERS = originalFastTimers;
  }
  vi.resetModules();
});

describe('realtime auction engine context', () => {
  it('compresses persisted study and turn deadlines in harness mode', async () => {
    process.env.REGRESSION_FAST_TIMERS = '1';
    vi.resetModules();

    const { resolveRealtimeAuctionContext } = await import(
      '../../src/realtime/services/auction-engine-context.js'
    );
    const {
      applyBid,
      beginClueStudy,
      createInitialAuctionMatch,
      revealNextClue,
      startBidding,
      startBiddingRound,
    } = await import('../../src/modules/auction/auction-engine.js');

    let id = 0;
    const context = resolveRealtimeAuctionContext({
      now: () => new Date('2026-06-20T10:00:00.000Z'),
      random: () => 0,
      createId: (kind) => `${kind}-${++id}`,
    });
    const initial = createInitialAuctionMatch({
      matchId: 'match-1',
      humanUserId: 'user-1',
      humanDisplayName: 'Human',
      formation: '2-2-2',
      context,
    });
    const footballer = {
      id: 'footballer-1',
      clueCardId: 'clue-card-1',
      name: 'Player One',
      positionGroup: 'FWD' as const,
      trueValue: 100_000_000,
      startingPrice: 10_000_000,
      clues: ['one', 'two', 'three'],
      imageUrl: 'https://img.example/player-1.jpg',
      currentClub: 'QuizBall FC',
      nationality: 'Georgia',
    };
    let state = startBiddingRound(initial, 'FWD', footballer, initial.seats, context);
    state = revealNextClue(state, context);
    state = revealNextClue(state, context);
    state = revealNextClue(state, context);

    const studying = beginClueStudy(state, context);
    expect(studying.currentRound?.biddingStartsAt).toBe('2026-06-20T10:00:00.150Z');

    const bidding = startBidding(studying, context);
    expect(bidding.currentRound?.turnEndsAt).toBe('2026-06-20T10:00:00.400Z');

    const raised = applyBid(
      bidding,
      bidding.currentRound!.currentTurnSeatId!,
      bidding.currentRound!.startingPrice,
      context
    );
    expect(raised.currentRound?.turnEndsAt).toBe('2026-06-20T10:00:00.400Z');
  });
});
