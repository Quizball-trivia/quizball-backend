import { describe, expect, it } from 'vitest';
import {
  AUCTION_SQUAD_SIZE,
  FORMATIONS,
  MIN_BID_INCREMENT,
  MIN_PLAYER_COST,
  STARTING_BUDGET,
} from '../../src/modules/auction/auction.constants.js';
import {
  canAffordMinBid,
  canPlayerContinue,
  createEmptyTeam,
  getEmptySlots,
  getFilledCount,
  getFormationNeeds,
  getMaxBid,
  getMinBid,
  getTotalTeamValue,
  isBidValid,
  isTeamComplete,
  needsPosition,
  rankAuctionPlayers,
  shouldEliminateAfterPurchase,
} from '../../src/modules/auction/auction-rules.js';
import type {
  AuctionFootballer,
  AuctionPlayer,
  AuctionTeam,
  FormationName,
  PositionGroup,
} from '../../src/modules/auction/auction.types.js';

function footballer(
  id: string,
  positionGroup: PositionGroup,
  trueValue: number
): AuctionFootballer {
  return {
    id,
    name: id,
    positionGroup,
    trueValue,
    startingPrice: 20_000_000,
  };
}

function player(
  seatId: string,
  team: AuctionTeam,
  overrides: Partial<AuctionPlayer> = {}
): AuctionPlayer {
  return {
    seatId,
    userId: null,
    displayName: seatId,
    isBot: false,
    budget: STARTING_BUDGET,
    team,
    isEliminated: false,
    ...overrides,
  };
}

function fillPosition(team: AuctionTeam, positionGroup: PositionGroup, values: number[]): AuctionTeam {
  return {
    ...team,
    slots: {
      ...team.slots,
      [positionGroup]: [
        ...team.slots[positionGroup],
        ...values.map((value, index) => footballer(`${positionGroup}-${index}-${value}`, positionGroup, value)),
      ],
    },
  };
}

function completeTeam(formationName: FormationName, baseValue: number): AuctionTeam {
  let team = createEmptyTeam(formationName);
  for (const [positionGroup, count] of Object.entries(team.formation.required) as [PositionGroup, number][]) {
    team = fillPosition(
      team,
      positionGroup,
      Array.from({ length: count }, (_, index) => baseValue + index)
    );
  }
  return team;
}

describe('auction rules', () => {
  it('defines formations with exactly 11 required slots', () => {
    for (const formation of FORMATIONS) {
      const total = Object.values(formation.required).reduce((sum, count) => sum + count, 0);

      expect(total).toBe(AUCTION_SQUAD_SIZE);
      expect(getFormationNeeds(formation.name)).toEqual(formation.required);
    }
  });

  it('creates empty teams and tracks position needs', () => {
    let team = createEmptyTeam('4-3-3');

    expect(getFilledCount(team)).toBe(0);
    expect(getEmptySlots(team)).toBe(11);
    expect(needsPosition(team, 'GK')).toBe(true);

    team = fillPosition(team, 'GK', [50_000_000]);

    expect(getFilledCount(team)).toBe(1);
    expect(getEmptySlots(team)).toBe(10);
    expect(needsPosition(team, 'GK')).toBe(false);
    expect(needsPosition(team, 'DEF')).toBe(true);
  });

  it('only marks teams complete when every formation requirement is filled', () => {
    const wrongShapeTeam = fillPosition(createEmptyTeam('4-3-3'), 'FWD', Array.from({ length: 11 }, () => 1));
    const fullTeam = completeTeam('4-3-3', 10_000_000);

    expect(getFilledCount(wrongShapeTeam)).toBe(11);
    expect(isTeamComplete(wrongShapeTeam)).toBe(false);
    expect(getEmptySlots(wrongShapeTeam)).toBe(8);
    expect(isTeamComplete(fullTeam)).toBe(true);
  });

  it('sums true squad market value, not purchase prices', () => {
    let team = createEmptyTeam('4-4-2');
    team = fillPosition(team, 'GK', [10_000_000]);
    team = fillPosition(team, 'DEF', [20_000_000, 30_000_000]);

    expect(getTotalTeamValue(team)).toBe(60_000_000);
  });

  it('keeps reserve budget in max bid except for the last empty slot', () => {
    expect(getMaxBid(STARTING_BUDGET, 11)).toBe(800_000_000);
    expect(getMaxBid(100_000_000, 3)).toBe(60_000_000);
    expect(getMaxBid(100_000_000, 1)).toBe(100_000_000);
    expect(getMaxBid(100_000_000, 0)).toBe(100_000_000);
    expect(getMaxBid(10_000_000, 3)).toBe(0);
  });

  it('calculates min bid from starting price or standing bid', () => {
    expect(getMinBid(10_000_000, null)).toBe(10_000_000);
    expect(getMinBid(10_000_000, 0)).toBe(10_000_000);
    expect(getMinBid(10_000_000, 25_000_000)).toBe(25_000_000 + MIN_BID_INCREMENT);
  });

  it('defines affordability through getMaxBid', () => {
    const maxBid = getMaxBid(50_000_000, 3);

    expect(maxBid).toBe(10_000_000);
    expect(canAffordMinBid(50_000_000, 3, 10_000_000)).toBe(true);
    expect(canAffordMinBid(50_000_000, 3, 15_000_000)).toBe(false);
  });

  it('validates bids against min bid and max bid', () => {
    const base = {
      budget: 100_000_000,
      emptySlots: 3,
      startingPrice: 20_000_000,
      highestBid: 30_000_000,
    };

    expect(isBidValid({ ...base, amount: 34_999_999 })).toBe(false);
    expect(isBidValid({ ...base, amount: 35_000_000 })).toBe(true);
    expect(isBidValid({ ...base, amount: 60_000_000 })).toBe(true);
    expect(isBidValid({ ...base, amount: 60_000_001 })).toBe(false);
    expect(isBidValid({ ...base, amount: 35_000_000.5 })).toBe(false);
  });

  it('uses MIN_PLAYER_COST for post-purchase elimination', () => {
    expect(shouldEliminateAfterPurchase(MIN_PLAYER_COST * 2, 2)).toBe(false);
    expect(shouldEliminateAfterPurchase(MIN_PLAYER_COST * 2 - 1, 2)).toBe(true);
    expect(shouldEliminateAfterPurchase(0, 0)).toBe(false);
  });

  it('computes whether a player can continue', () => {
    const incompleteTeam = fillPosition(createEmptyTeam('4-3-3'), 'GK', [20_000_000]);
    const fullTeam = completeTeam('4-3-3', 10_000_000);

    expect(canPlayerContinue(player('active', incompleteTeam, { budget: 400_000_000 }))).toBe(true);
    expect(canPlayerContinue(player('eliminated', incompleteTeam, { isEliminated: true }))).toBe(false);
    expect(canPlayerContinue(player('complete', fullTeam))).toBe(false);
    expect(canPlayerContinue(player('broke', incompleteTeam, { budget: 1 }))).toBe(false);
  });

  it('ranks complete teams above incomplete teams, then by true value', () => {
    const completeLower = player('complete-low', completeTeam('4-3-3', 10_000_000));
    const completeHigher = player('complete-high', completeTeam('4-3-3', 20_000_000));
    const incompleteHigherValue = player(
      'incomplete-high',
      fillPosition(createEmptyTeam('4-3-3'), 'FWD', [500_000_000, 400_000_000])
    );

    const rankings = rankAuctionPlayers([completeLower, incompleteHigherValue, completeHigher]);

    expect(rankings.map((ranking) => ranking.seatId)).toEqual([
      'complete-high',
      'complete-low',
      'incomplete-high',
    ]);
    expect(rankings.map((ranking) => ranking.rank)).toEqual([1, 2, 3]);
    expect(rankings[0].totalTrueValue).toBeGreaterThan(rankings[1].totalTrueValue);
    expect(rankings[2].isComplete).toBe(false);
  });
});
