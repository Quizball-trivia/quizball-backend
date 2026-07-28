/**
 * Pure unit tests for the extracted Season-2026 RP delta math + an equivalence
 * assertion that ranked.service re-exports the SAME bindings (so the live
 * settlement path and the offline burn-in dry-run can never diverge).
 *
 * The numeric expectations mirror the values already asserted end-to-end in
 * tests/ranked/persistent-bot-settlement.integration.test.ts (win-by-2 = +65).
 */
import { describe, it, expect } from 'vitest';
import {
  computeSeasonRpDelta,
  seasonMarginBonus,
  SEASON_INITIAL_RP,
  SEASON_REGULAR_WIN_RP,
  SEASON_PENALTY_WIN_RP,
  SEASON_REGULAR_LOSS_RP,
  SEASON_PENALTY_LOSS_RP,
  SEASON_FORFEIT_LOSS_RP,
  SEASON_OPPONENT_FORFEIT_WIN_RP,
  SEASON_BEAT_STRONGER_BONUS_RP,
} from '../../src/modules/ranked/season-rp-formula.js';
import * as rankedService from '../../src/modules/ranked/ranked.service.js';

describe('seasonMarginBonus', () => {
  it('is a step function of signed goal margin, zero when not ahead', () => {
    expect(seasonMarginBonus(-3)).toBe(0);
    expect(seasonMarginBonus(0)).toBe(0);
    expect(seasonMarginBonus(1)).toBe(0);
    expect(seasonMarginBonus(2)).toBe(15);
    expect(seasonMarginBonus(3)).toBe(30);
    expect(seasonMarginBonus(4)).toBe(40);
    expect(seasonMarginBonus(9)).toBe(40);
  });
});

describe('computeSeasonRpDelta', () => {
  it('regular goals win: base + margin bonus', () => {
    expect(computeSeasonRpDelta(true, 'goals', 1, false)).toBe(SEASON_REGULAR_WIN_RP); // +50
    expect(computeSeasonRpDelta(true, 'goals', 2, false)).toBe(SEASON_REGULAR_WIN_RP + 15); // +65
    expect(computeSeasonRpDelta(true, 'goals', 4, false)).toBe(SEASON_REGULAR_WIN_RP + 40); // +90
  });

  it('beating a stronger opponent adds the upset bonus', () => {
    expect(computeSeasonRpDelta(true, 'goals', 1, true)).toBe(
      SEASON_REGULAR_WIN_RP + SEASON_BEAT_STRONGER_BONUS_RP,
    ); // +60
    expect(computeSeasonRpDelta(true, 'goals', 3, true)).toBe(
      SEASON_REGULAR_WIN_RP + 30 + SEASON_BEAT_STRONGER_BONUS_RP,
    ); // +90
  });

  it('penalty (shootout) win: flat, no margin bonus', () => {
    expect(computeSeasonRpDelta(true, 'penalty_goals', 0, false)).toBe(SEASON_PENALTY_WIN_RP); // +35
    expect(computeSeasonRpDelta(true, 'penalty_goals', 3, false)).toBe(SEASON_PENALTY_WIN_RP); // still +35
    expect(computeSeasonRpDelta(true, 'penalty_goals', 0, true)).toBe(
      SEASON_PENALTY_WIN_RP + SEASON_BEAT_STRONGER_BONUS_RP,
    ); // +45
  });

  it('opponent forfeit win pays a regular-win base with no margin bonus when behind', () => {
    expect(computeSeasonRpDelta(true, 'forfeit', -2, false)).toBe(SEASON_OPPONENT_FORFEIT_WIN_RP); // +50
    expect(computeSeasonRpDelta(true, 'forfeit', 2, false)).toBe(
      SEASON_OPPONENT_FORFEIT_WIN_RP + 15,
    ); // ahead → +65
  });

  it('losses subtract by decision type', () => {
    expect(computeSeasonRpDelta(false, 'goals', -2, false)).toBe(SEASON_REGULAR_LOSS_RP); // -25
    expect(computeSeasonRpDelta(false, 'penalty_goals', 0, false)).toBe(SEASON_PENALTY_LOSS_RP); // -15
    expect(computeSeasonRpDelta(false, 'forfeit', 0, false)).toBe(SEASON_FORFEIT_LOSS_RP); // -50 (you quit)
  });
});

describe('ranked.service re-exports the identical bindings', () => {
  it('exports the same function and constant references', () => {
    expect(rankedService.computeSeasonRpDelta).toBe(computeSeasonRpDelta);
    expect(rankedService.seasonMarginBonus).toBe(seasonMarginBonus);
    expect(rankedService.SEASON_INITIAL_RP).toBe(SEASON_INITIAL_RP);
    expect(rankedService.SEASON_REGULAR_WIN_RP).toBe(SEASON_REGULAR_WIN_RP);
    expect(rankedService.SEASON_PENALTY_WIN_RP).toBe(SEASON_PENALTY_WIN_RP);
    expect(rankedService.SEASON_REGULAR_LOSS_RP).toBe(SEASON_REGULAR_LOSS_RP);
    expect(rankedService.SEASON_PENALTY_LOSS_RP).toBe(SEASON_PENALTY_LOSS_RP);
    expect(rankedService.SEASON_FORFEIT_LOSS_RP).toBe(SEASON_FORFEIT_LOSS_RP);
    expect(rankedService.SEASON_OPPONENT_FORFEIT_WIN_RP).toBe(SEASON_OPPONENT_FORFEIT_WIN_RP);
    expect(rankedService.SEASON_BEAT_STRONGER_BONUS_RP).toBe(SEASON_BEAT_STRONGER_BONUS_RP);
  });
});
