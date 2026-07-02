import type { AuctionFormation, FormationName, PositionGroup, PositionNeeds } from './auction.types.js';

export const AUCTION_SEAT_COUNT = 3;
export const AUCTION_SQUAD_SIZE = 11;

export const STARTING_BUDGET = 1_000_000_000;
export const MIN_BID_INCREMENT = 5_000_000;
export const MIN_PLAYER_COST = 20_000_000;
export const OPENING_TURN_MS = 30_000;
export const RAISE_TURN_MS = 10_000;
export const CLUE_REVEAL_INTERVAL_MS = 2_500;

export const POSITION_GROUPS = ['GK', 'DEF', 'MID', 'FWD'] as const satisfies readonly PositionGroup[];

export const FORMATIONS = [
  {
    name: '4-3-3',
    required: { GK: 1, DEF: 4, MID: 3, FWD: 3 },
    rows: [
      { pos: 'FWD', count: 3 },
      { pos: 'MID', count: 3 },
      { pos: 'DEF', count: 4 },
      { pos: 'GK', count: 1 },
    ],
  },
  {
    name: '4-4-2',
    required: { GK: 1, DEF: 4, MID: 4, FWD: 2 },
    rows: [
      { pos: 'FWD', count: 2 },
      { pos: 'MID', count: 4 },
      { pos: 'DEF', count: 4 },
      { pos: 'GK', count: 1 },
    ],
  },
  {
    name: '3-5-2',
    required: { GK: 1, DEF: 3, MID: 5, FWD: 2 },
    rows: [
      { pos: 'FWD', count: 2 },
      { pos: 'MID', count: 5 },
      { pos: 'DEF', count: 3 },
      { pos: 'GK', count: 1 },
    ],
  },
  {
    name: '4-2-3-1',
    required: { GK: 1, DEF: 4, MID: 5, FWD: 1 },
    rows: [
      { pos: 'FWD', count: 1 },
      { pos: 'MID', count: 3 },
      { pos: 'MID', count: 2 },
      { pos: 'DEF', count: 4 },
      { pos: 'GK', count: 1 },
    ],
  },
  {
    name: '3-4-3',
    required: { GK: 1, DEF: 3, MID: 4, FWD: 3 },
    rows: [
      { pos: 'FWD', count: 3 },
      { pos: 'MID', count: 4 },
      { pos: 'DEF', count: 3 },
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
