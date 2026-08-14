import { describe, expect, it } from 'vitest';
import {
  computeParticipantSettlement,
  type ParticipantSettlementInput,
} from '../../src/modules/ranked/season-rp-formula.js';

function input(overrides: Partial<ParticipantSettlementInput> = {}): ParticipantSettlementInput {
  return {
    oldRp: 450,
    placementStatus: 'unplaced',
    placementPlayed: 0,
    placementWins: 0,
    placementSeedRp: null,
    placementPerfSum: 0,
    placementPointsForSum: 0,
    placementPointsAgainstSum: 0,
    currentWinStreak: 0,
    placementRequired: 3,
    isWin: true,
    decision: 'goals',
    goalMargin: 1,
    opponentRp: 400,
    opponentIsStronger: false,
    isHumanForCoins: false,
    ...overrides,
  };
}

describe('computeParticipantSettlement', () => {
  it('settles placement game 1 with the production ranked formula', () => {
    const result = computeParticipantSettlement(input({ goalMargin: 2 }));

    expect(result).toMatchObject({
      newRp: 515,
      deltaRp: 65,
      result: 'win',
      isPlacement: true,
      placementStatus: 'in_progress',
      placementPlayed: 1,
      placementWins: 1,
      placementGameNo: 1,
      placementAnchorRp: 400,
      calculationMethod: 'placement_seed',
    });
  });

  it('marks placement game 3 placed and records its new RP as the seed', () => {
    const result = computeParticipantSettlement(input({
      oldRp: 540,
      placementStatus: 'in_progress',
      placementPlayed: 2,
      placementWins: 1,
      placementPerfSum: 99,
      placementPointsForSum: 1200,
      placementPointsAgainstSum: 900,
    }));

    expect(result.placementStatus).toBe('placed');
    expect(result.placementPlayed).toBe(3);
    expect(result.placementSeedRp).toBe(result.newRp);
    expect(result.placementPerfSum).toBe(0);
    expect(result.placementPointsForSum).toBe(0);
    expect(result.placementPointsAgainstSum).toBe(0);
  });

  it('applies +50 for a post-placement ranked-formula win', () => {
    const result = computeParticipantSettlement(input({
      oldRp: 1200,
      placementStatus: 'placed',
      placementPlayed: 3,
      placementWins: 2,
    }));

    expect(result.deltaRp).toBe(50);
    expect(result.calculationMethod).toBe('ranked_formula');
    expect(result.isPlacement).toBe(false);
  });

  it('applies -25 for a post-placement ranked-formula loss', () => {
    const result = computeParticipantSettlement(input({
      oldRp: 1200,
      placementStatus: 'placed',
      placementPlayed: 3,
      placementWins: 2,
      isWin: false,
      goalMargin: -1,
    }));

    expect(result.deltaRp).toBe(-25);
    expect(result.currentWinStreak).toBe(0);
  });

  it('adds +10 for beating a stronger opponent', () => {
    const common = {
      oldRp: 1200,
      placementStatus: 'placed' as const,
      placementPlayed: 3,
      placementWins: 2,
      opponentRp: 1400,
    };
    const ordinary = computeParticipantSettlement(input({
      ...common,
      opponentIsStronger: false,
    }));
    const upset = computeParticipantSettlement(input({
      ...common,
      opponentIsStronger: true,
    }));

    expect(upset.deltaRp - ordinary.deltaRp).toBe(10);
  });

  it('awards coins only to humans, using the production win/loss amounts', () => {
    expect(computeParticipantSettlement(input({
      isHumanForCoins: false,
    })).coinsAwarded).toBe(0);
    expect(computeParticipantSettlement(input({
      isHumanForCoins: true,
    })).coinsAwarded).toBe(700);
    expect(computeParticipantSettlement(input({
      isWin: false,
      isHumanForCoins: true,
    })).coinsAwarded).toBe(250);
  });
});
