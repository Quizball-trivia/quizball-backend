import { describe, expect, it } from 'vitest';
import '../setup.js';

import { createInitialAuctionMatch } from '../../src/modules/auction/auction-engine.js';
import {
  auctionMatchOrigin,
  type AuctionMatchState,
} from '../../src/modules/auction/auction-match-state.js';

function createMatch(origin?: 'queue' | 'lobby') {
  return createInitialAuctionMatch({
    humanUserId: 'user-a',
    humanDisplayName: 'Player A',
    origin,
  });
}

describe('auction match origin', () => {
  it('defaults a created match to the queue origin', () => {
    expect(createMatch().origin).toBe('queue');
  });

  it('stamps the lobby origin when the lobby path creates the match', () => {
    expect(createMatch('lobby').origin).toBe('lobby');
  });

  it('survives the Redis JSON round-trip the state store performs', () => {
    const restored = JSON.parse(JSON.stringify(createMatch('lobby'))) as AuctionMatchState;
    expect(auctionMatchOrigin(restored)).toBe('lobby');
  });

  it('reads a legacy state with no origin as queue', () => {
    // Matches already in flight when this shipped have no `origin` in their
    // stored blob; they all came from the queue, so they must still pay AP.
    const legacy = { matchId: 'm1', phase: 'finished' } as unknown as AuctionMatchState;
    expect(auctionMatchOrigin(legacy)).toBe('queue');
  });
});
