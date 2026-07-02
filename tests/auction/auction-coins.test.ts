import { describe, expect, it } from 'vitest';
import {
  AUCTION_WIN_COINS,
  AUCTION_FINISH_COINS,
  auctionCoinsForPlacement,
} from '../../src/realtime/services/auction-persistence.service.js';

describe('auctionCoinsForPlacement', () => {
  it('pays the win reward for 1st place', () => {
    expect(auctionCoinsForPlacement(1)).toBe(AUCTION_WIN_COINS);
    expect(AUCTION_WIN_COINS).toBe(500);
  });

  it('pays the finish reward for any non-1st placement', () => {
    expect(auctionCoinsForPlacement(2)).toBe(AUCTION_FINISH_COINS);
    expect(auctionCoinsForPlacement(3)).toBe(AUCTION_FINISH_COINS);
    expect(AUCTION_FINISH_COINS).toBe(300);
  });
});
