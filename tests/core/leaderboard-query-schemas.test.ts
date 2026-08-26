import { describe, expect, it } from 'vitest';
import { auctionLeaderboardQuerySchema } from '../../src/modules/auction/auction-leaderboard.schemas.js';
import { footballGridLeaderboardQuerySchema } from '../../src/modules/football-grid/football-grid-leaderboard.schemas.js';
import { rankedLeaderboardQuerySchema } from '../../src/modules/ranked/ranked.schemas.js';

const schemas = [
  ['Ranked', rankedLeaderboardQuerySchema],
  ['Auction', auctionLeaderboardQuerySchema],
  ['Tic Tac Toe', footballGridLeaderboardQuerySchema],
] as const;

describe.each(schemas)('%s leaderboard pagination', (_name, schema) => {
  it('accepts the supported offset range', () => {
    expect(schema.parse({ offset: '0' }).offset).toBe(0);
    expect(schema.parse({ offset: '10000' }).offset).toBe(10_000);
  });

  it.each(['10001', '1e100', '9007199254740992', '-1', '1.5'])
    ('rejects unsafe, deep, negative or fractional offsets: %s', (offset) => {
      expect(schema.safeParse({ offset }).success).toBe(false);
    });
});
