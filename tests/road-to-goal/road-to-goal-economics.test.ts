import { describe, expect, it } from 'vitest';
import {
  calculateRoadToGoalSurvivalOdds,
  ROAD_TO_GOAL_TARGET_RTP_BP,
} from '../../src/modules/road-to-goal/road-to-goal.fairness.js';
import {
  ROAD_TO_GOAL_DIFFICULTIES,
  ROAD_TO_GOAL_MULTIPLIERS_BP,
} from '../../src/modules/road-to-goal/road-to-goal.constants.js';

const BASIS_POINTS = 10_000n;
const EXPECTED_ACCURACY_BY_DIFFICULTY_BP = {
  easy: 8_000,
  medium: 6_500,
  hard: 5_000,
} as const;

describe('Road to Goal economics', () => {
  it('preserves 98% theoretical RTP within one basis point at every cashout', () => {
    let cumulativeSurvivalNumerator = 1n;
    let cumulativeSurvivalDenominator = 1n;

    for (let zoneIndex = 0; zoneIndex < ROAD_TO_GOAL_MULTIPLIERS_BP.length; zoneIndex += 1) {
      const difficulty = ROAD_TO_GOAL_DIFFICULTIES[zoneIndex];
      const multiplierBp = ROAD_TO_GOAL_MULTIPLIERS_BP[zoneIndex];
      if (difficulty == null || multiplierBp == null) {
        throw new Error(`Missing configuration for zone ${zoneIndex}`);
      }
      const odds = calculateRoadToGoalSurvivalOdds({
        multiplierLadderBp: ROAD_TO_GOAL_MULTIPLIERS_BP,
        zoneIndex,
        expectedAccuracyBp: EXPECTED_ACCURACY_BY_DIFFICULTY_BP[difficulty],
      });
      const weightedSurvivalNumerator = BigInt(
        odds.expectedAccuracyBp * odds.correctSurvivalBp +
        (10_000 - odds.expectedAccuracyBp) * odds.wrongSurvivalBp
      );

      cumulativeSurvivalNumerator *= weightedSurvivalNumerator;
      cumulativeSurvivalDenominator *= BASIS_POINTS * BASIS_POINTS;

      const returnNumerator =
        BigInt(multiplierBp) * cumulativeSurvivalNumerator;
      const returnDenominator = cumulativeSurvivalDenominator;
      const targetNumerator =
        BigInt(ROAD_TO_GOAL_TARGET_RTP_BP) * returnDenominator;
      const difference = returnNumerator >= targetNumerator
        ? returnNumerator - targetNumerator
        : targetNumerator - returnNumerator;

      expect(difference).toBeLessThanOrEqual(returnDenominator);
    }
  });
});
