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

/** A complete 2-2-2 squad where every footballer has the same value and,
 *  optionally, a shared club + nation (for chemistry). `linked: false` gives
 *  every seat a distinct club/nation so no chemistry links form. */
function chemistryTeam(value: number, opts: { linked: boolean }): AuctionTeam {
  let team = createEmptyTeam('2-2-2');
  let seat = 0;
  for (const [positionGroup, count] of Object.entries(team.formation.required) as [PositionGroup, number][]) {
    for (let i = 0; i < count; i += 1) {
      const f: AuctionFootballer = {
        id: `${positionGroup}-${seat}`,
        name: `${positionGroup}-${seat}`,
        positionGroup,
        trueValue: value,
        startingPrice: 20_000_000,
        currentClub: opts.linked ? 'Shared FC' : `Club ${seat}`,
        nationality: opts.linked ? 'Brazil' : `Nation ${seat}`,
      };
      team = { ...team, slots: { ...team.slots, [positionGroup]: [...team.slots[positionGroup], f] } };
      seat += 1;
    }
  }
  return team;
}

describe('auction rules', () => {
  it('defines formations with exactly AUCTION_SQUAD_SIZE required slots', () => {
    for (const formation of FORMATIONS) {
      const total = Object.values(formation.required).reduce((sum, count) => sum + count, 0);

      expect(total).toBe(AUCTION_SQUAD_SIZE);
      expect(getFormationNeeds(formation.name)).toEqual(formation.required);
    }
  });

  it('creates empty teams and tracks position needs', () => {
    let team = createEmptyTeam('2-2-2');

    expect(getFilledCount(team)).toBe(0);
    expect(getEmptySlots(team)).toBe(AUCTION_SQUAD_SIZE);
    expect(needsPosition(team, 'GK')).toBe(true);

    team = fillPosition(team, 'GK', [50_000_000]);

    expect(getFilledCount(team)).toBe(1);
    expect(getEmptySlots(team)).toBe(AUCTION_SQUAD_SIZE - 1);
    expect(needsPosition(team, 'GK')).toBe(false);
    expect(needsPosition(team, 'DEF')).toBe(true);
  });

  it('only marks teams complete when every formation requirement is filled', () => {
    // Overfill FWD (needs 2) and leave GK/DEF/MID empty — filled count is high
    // but the shape is wrong, so the team is not complete.
    const wrongShapeTeam = fillPosition(createEmptyTeam('2-2-2'), 'FWD', Array.from({ length: 3 }, () => 1));
    const fullTeam = completeTeam('2-2-2', 10_000_000);

    expect(getFilledCount(wrongShapeTeam)).toBe(3);
    expect(isTeamComplete(wrongShapeTeam)).toBe(false);
    // GK(1) + DEF(2) + MID(2) still empty; FWD is over capacity so contributes 0.
    expect(getEmptySlots(wrongShapeTeam)).toBe(5);
    expect(isTeamComplete(fullTeam)).toBe(true);
  });

  it('sums true squad market value, not purchase prices', () => {
    let team = createEmptyTeam('2-2-2');
    team = fillPosition(team, 'GK', [10_000_000]);
    team = fillPosition(team, 'DEF', [20_000_000, 30_000_000]);

    expect(getTotalTeamValue(team)).toBe(60_000_000);
  });

  it('keeps reserve budget in max bid except for the last empty slot', () => {
    // 7 empty slots: reserve MIN_PLAYER_COST for each of the other 6.
    expect(getMaxBid(STARTING_BUDGET, AUCTION_SQUAD_SIZE)).toBe(STARTING_BUDGET - 6 * MIN_PLAYER_COST);
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

    expect(isBidValid({ ...base, amount: 39_999_999 })).toBe(false);
    expect(isBidValid({ ...base, amount: 40_000_000 })).toBe(true);
    expect(isBidValid({ ...base, amount: 60_000_000 })).toBe(true);
    expect(isBidValid({ ...base, amount: 60_000_001 })).toBe(false);
    expect(isBidValid({ ...base, amount: 40_000_000.5 })).toBe(false);
  });

  it('uses MIN_PLAYER_COST for post-purchase elimination', () => {
    expect(shouldEliminateAfterPurchase(MIN_PLAYER_COST * 2, 2)).toBe(false);
    expect(shouldEliminateAfterPurchase(MIN_PLAYER_COST * 2 - 1, 2)).toBe(true);
    expect(shouldEliminateAfterPurchase(0, 0)).toBe(false);
  });

  it('computes whether a player can continue', () => {
    const incompleteTeam = fillPosition(createEmptyTeam('2-2-2'), 'GK', [20_000_000]);
    const fullTeam = completeTeam('2-2-2', 10_000_000);

    expect(canPlayerContinue(player('active', incompleteTeam, { budget: 400_000_000 }))).toBe(true);
    expect(canPlayerContinue(player('eliminated', incompleteTeam, { isEliminated: true }))).toBe(false);
    expect(canPlayerContinue(player('complete', fullTeam))).toBe(false);
    expect(canPlayerContinue(player('broke', incompleteTeam, { budget: 1 }))).toBe(false);
  });

  it('ranks complete teams above incomplete teams, then by chemistry-adjusted profit', () => {
    const completeLower = player('complete-low', completeTeam('2-2-2', 10_000_000));
    const completeHigher = player('complete-high', completeTeam('2-2-2', 20_000_000));
    const incompleteHigherValue = player(
      'incomplete-high',
      fillPosition(createEmptyTeam('2-2-2'), 'FWD', [500_000_000, 400_000_000])
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

  it('ranks forfeiters below every non-forfeiter, regardless of squad value', () => {
    // Best complete squad but quit — must NOT win by forfeiting while ahead.
    const forfeitedBest = player('forfeited-best', completeTeam('2-2-2', 90_000_000), {
      isEliminated: true,
      forfeited: true,
    });
    const honestComplete = player('honest-complete', completeTeam('2-2-2', 10_000_000));
    // Honest budget elimination is NOT penalized — ranks by what they built.
    const budgetEliminated = player(
      'budget-eliminated',
      fillPosition(createEmptyTeam('2-2-2'), 'FWD', [5_000_000]),
      { isEliminated: true }
    );

    const rankings = rankAuctionPlayers([forfeitedBest, honestComplete, budgetEliminated]);

    expect(rankings.map((ranking) => ranking.seatId)).toEqual([
      'honest-complete',
      'budget-eliminated',
      'forfeited-best',
    ]);
    expect(rankings[2].rank).toBe(3);
  });

  it('ranks by chemistry-adjusted profit, not raw squad value', () => {
    // Identical raw value (7 × 30M = 210M) and identical spend (both left 200M
    // of 350M), so profit is equal — chemistry is the only differentiator.
    const linked = player('linked', chemistryTeam(30_000_000, { linked: true }), { budget: 200_000_000 });
    const scattered = player('scattered', chemistryTeam(30_000_000, { linked: false }), { budget: 200_000_000 });

    const rankings = rankAuctionPlayers([scattered, linked]);

    expect(rankings[0].seatId).toBe('linked');
    expect(rankings[0].chemistry).toBe(21); // full club + nation links across 7
    expect(rankings[1].chemistry).toBe(0);
    // Same 60M profit, but ×3.1 chemistry beats ×1.0.
    expect(rankings[0].profit).toBe(rankings[1].profit);
    expect(rankings[0].adjustedProfit).toBeGreaterThan(rankings[1].adjustedProfit);
  });

  it('rewards leftover budget: spending less on the same squad means more profit', () => {
    // Same squad value and no chemistry — the thriftier buyer profits more.
    const thrifty = player('thrifty', chemistryTeam(30_000_000, { linked: false }), { budget: 250_000_000 });
    const spender = player('spender', chemistryTeam(30_000_000, { linked: false }), { budget: 100_000_000 });

    const rankings = rankAuctionPlayers([spender, thrifty]);

    expect(rankings[0].seatId).toBe('thrifty');
    expect(rankings[0].profit).toBeGreaterThan(rankings[1].profit);
  });
});
