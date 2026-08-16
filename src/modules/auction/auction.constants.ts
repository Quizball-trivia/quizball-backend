import type { AuctionFormation, FormationName, PositionGroup, PositionNeeds } from './auction.types.js';

export const AUCTION_SEAT_COUNT = 3;
export const AUCTION_SQUAD_SIZE = 7;

// 7-a-side squads: 350M forces trade-offs (a couple of premiums + cheap fills)
// rather than buying every star like the old 1B budget allowed.
export const STARTING_BUDGET = 350_000_000;
// Every raise is exactly one increment — the bidding UI offers a single
// "+10M" button, so the minimum raise and the only raise are the same value.
export const MIN_BID_INCREMENT = 10_000_000;
export const MIN_PLAYER_COST = 20_000_000;
export const OPENING_TURN_MS = 30_000;
export const RAISE_TURN_MS = 15_000;
// Snapshot lots reveal five stat facets instead of three sentences; 3s per
// facet keeps the clue phase at the same ~15s total as the old 3×5s cadence.
export const CLUE_REVEAL_INTERVAL_MS = 3_000;
// Study window after the third clue lands, before the first turn opens.
export const CLUE_STUDY_MS = 10_000;

export const POSITION_GROUPS = ['GK', 'DEF', 'MID', 'FWD'] as const satisfies readonly PositionGroup[];

// Fixed 7-a-side shape: 2 FWD · 2 MID · 2 DEF · 1 GK (sums to AUCTION_SQUAD_SIZE).
export const FORMATIONS = [
  {
    name: '2-2-2',
    required: { GK: 1, DEF: 2, MID: 2, FWD: 2 },
    rows: [
      { pos: 'FWD', count: 2 },
      { pos: 'MID', count: 2 },
      { pos: 'DEF', count: 2 },
      { pos: 'GK', count: 1 },
    ],
  },
] as const satisfies readonly AuctionFormation[];

export const FORMATION_BY_NAME = FORMATIONS.reduce<Record<FormationName, AuctionFormation>>(
  (acc, formation) => {
    acc[formation.name] = formation;
    return acc;
  },
  {} as Record<FormationName, AuctionFormation>
);

export const EMPTY_POSITION_NEEDS: PositionNeeds = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
