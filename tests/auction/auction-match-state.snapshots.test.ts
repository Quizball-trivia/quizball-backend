import { describe, expect, it } from 'vitest';

import {
  toHiddenFootballer,
  toRevealedFootballer,
} from '../../src/modules/auction/auction-match-state.js';
import type { AuctionFootballer } from '../../src/modules/auction/auction.types.js';

const footballer: AuctionFootballer = {
  id: 'f1',
  name: 'Gabri Veiga',
  positionGroup: 'MID',
  trueValue: 30_000_000,
  startingPrice: 20_000_000,
  clues: ['Goals', 'Assists', 'Market value', 'Age', 'League'],
  currentClub: 'FC Porto',
  nationality: 'Spain',
  league: 'Primeira Liga',
  snapshots: [
    { season: '2020/21', league: 'La Liga', age: 19, apps: 20, goals: 3, valueEur: 5_000_000 },
    { season: '2022/23', league: 'La Liga', age: 21, apps: 36, goals: 11, valueEur: 30_000_000 },
    { season: '2025/26', league: 'Primeira Liga', age: 24, apps: 31, goals: 3, valueEur: 30_000_000 },
  ],
};

describe('snapshot exposure over the wire', () => {
  it('hidden lots redact the scoring season value and the current league', () => {
    const hidden = toHiddenFootballer(footballer, ['Goals']);

    expect(hidden.name).toBeUndefined();
    expect(hidden.league).toBeUndefined();
    // Early seasons travel intact — they are the clue content.
    expect(hidden.snapshots![0].valueEur).toBe(5_000_000);
    // The final season's value is the answer to the gamble: zeroed until reveal,
    // but its season label survives for the "value in 2025/26" hook.
    expect(hidden.snapshots!.at(-1)).toMatchObject({ season: '2025/26', valueEur: 0 });
  });

  it('revealed footballers carry full snapshots and league', () => {
    const revealed = toRevealedFootballer(footballer);

    expect(revealed.league).toBe('Primeira Liga');
    expect(revealed.snapshots!.at(-1)!.valueEur).toBe(30_000_000);
  });
});
