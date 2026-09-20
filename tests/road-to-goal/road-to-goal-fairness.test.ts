import { describe, expect, it } from 'vitest';
import {
  calculateRoadToGoalSurvivalOdds,
  newRoadToGoalServerSeed,
  ROAD_TO_GOAL_DESIRED_SKILL_GAP_BP,
  ROAD_TO_GOAL_MAX_ACCURACY_BP,
  ROAD_TO_GOAL_MAX_SURVIVAL_BP,
  ROAD_TO_GOAL_MIN_ACCURACY_BP,
  ROAD_TO_GOAL_MIN_SURVIVAL_BP,
  roadToGoalDidSurvive,
  ROAD_TO_GOAL_RULES_MANIFEST,
  roadToGoalRulesManifestHash,
  roadToGoalServerSeedCommitment,
  roadToGoalZoneRollBp,
  targetSurvivalBpForZone,
  verifyRoadToGoalServerSeedCommitment,
  verifyRoadToGoalZoneProof,
  type RoadToGoalZoneProof,
} from '../../src/modules/road-to-goal/road-to-goal.fairness.js';
import {
  ROAD_TO_GOAL_ACCURACY_PRIORS_BP,
  ROAD_TO_GOAL_DIFFICULTIES,
  ROAD_TO_GOAL_MULTIPLIERS_BP,
  ROAD_TO_GOAL_ZONE_ACCURACY_PRIORS_BP,
} from '../../src/modules/road-to-goal/road-to-goal.constants.js';

const EXPECTED_TARGETS_BP = [
  9_515,
  9_537,
  9_391,
  9_274,
  9_118,
  8_947,
  8_837,
  8_687,
  8_426,
  8_103,
  7_250,
] as const;
const QUESTION_SET_HASH = '33'.repeat(32);

describe('Road to Goal fairness', () => {
  it('calculates the target survival for every multiplier-ladder zone', () => {
    expect(
      ROAD_TO_GOAL_MULTIPLIERS_BP.map((_, zoneIndex) =>
        targetSurvivalBpForZone(ROAD_TO_GOAL_MULTIPLIERS_BP, zoneIndex)
      )
    ).toEqual(EXPECTED_TARGETS_BP);
  });

  it('keeps weighted skill-adjusted survival within one basis point of target', () => {
    for (let zoneIndex = 0; zoneIndex < ROAD_TO_GOAL_MULTIPLIERS_BP.length; zoneIndex += 1) {
      for (const expectedAccuracyBp of [0, 3_500, 5_001, 8_000, 9_500, 10_000]) {
        const odds = calculateRoadToGoalSurvivalOdds({
          multiplierLadderBp: ROAD_TO_GOAL_MULTIPLIERS_BP,
          zoneIndex,
          expectedAccuracyBp,
        });
        const weightedNumerator =
          odds.expectedAccuracyBp * odds.correctSurvivalBp +
          (10_000 - odds.expectedAccuracyBp) * odds.wrongSurvivalBp;
        const targetNumerator = odds.targetSurvivalBp * 10_000;

        expect(Math.abs(weightedNumerator - targetNumerator)).toBeLessThanOrEqual(10_000);
        expect(odds.correctSurvivalBp).toBeGreaterThan(odds.wrongSurvivalBp);
        expect(odds.wrongSurvivalBp).toBeGreaterThanOrEqual(ROAD_TO_GOAL_MIN_SURVIVAL_BP);
        expect(odds.correctSurvivalBp).toBeLessThanOrEqual(ROAD_TO_GOAL_MAX_SURVIVAL_BP);
      }
    }
  });

  it('clamps extreme accuracies and shrinks the gap at a survival boundary', () => {
    const lowAccuracy = calculateRoadToGoalSurvivalOdds({
      multiplierLadderBp: ROAD_TO_GOAL_MULTIPLIERS_BP,
      zoneIndex: 1,
      expectedAccuracyBp: 0,
    });
    const highAccuracy = calculateRoadToGoalSurvivalOdds({
      multiplierLadderBp: ROAD_TO_GOAL_MULTIPLIERS_BP,
      zoneIndex: 1,
      expectedAccuracyBp: 10_000,
    });

    expect(lowAccuracy.expectedAccuracyBp).toBe(ROAD_TO_GOAL_MIN_ACCURACY_BP);
    expect(highAccuracy.expectedAccuracyBp).toBe(ROAD_TO_GOAL_MAX_ACCURACY_BP);
    expect(lowAccuracy.effectiveGapBp).toBeLessThan(ROAD_TO_GOAL_DESIRED_SKILL_GAP_BP);
    expect(lowAccuracy.correctSurvivalBp).toBeLessThanOrEqual(ROAD_TO_GOAL_MAX_SURVIVAL_BP);
    expect(highAccuracy.wrongSurvivalBp).toBeGreaterThanOrEqual(ROAD_TO_GOAL_MIN_SURVIVAL_BP);
  });

  it('commits to a 32-byte server seed and rejects a different reveal', () => {
    const serverSeed = newRoadToGoalServerSeed();
    const context = {
      serverSeed,
      roundId: '11111111-1111-4111-8111-111111111111',
      calibrationVersionId: '22222222-2222-4222-8222-222222222222',
      rulesManifestHash: roadToGoalRulesManifestHash(),
      questionSetHash: QUESTION_SET_HASH,
      stakeCoins: 25,
      autoCashoutZone: null,
    };
    const commitment = roadToGoalServerSeedCommitment(context);

    expect(serverSeed).toMatch(/^[a-f0-9]{64}$/);
    expect(commitment).toMatch(/^[a-f0-9]{64}$/);
    expect(verifyRoadToGoalServerSeedCommitment(context, commitment)).toBe(true);
    expect(
      verifyRoadToGoalServerSeedCommitment(
        { ...context, serverSeed: newRoadToGoalServerSeed() },
        commitment
      )
    ).toBe(false);
    expect(
      verifyRoadToGoalServerSeedCommitment({ ...context, roundId: 'tampered' }, commitment)
    ).toBe(false);
    expect(roadToGoalRulesManifestHash(ROAD_TO_GOAL_RULES_MANIFEST))
      .toBe(context.rulesManifestHash);
  });

  it('derives deterministic unbiased rolls within the basis-point range', () => {
    const serverSeed = 'ab'.repeat(32);
    const buckets = Array.from({ length: 10 }, () => 0);
    const trials = 30_000;

    for (let index = 0; index < trials; index += 1) {
      const input = {
        serverSeed,
        clientSeed: `client-${index}`,
        roundId: `round-${index}`,
        zoneIndex: index % ROAD_TO_GOAL_MULTIPLIERS_BP.length,
      };
      const first = roadToGoalZoneRollBp(input);
      const second = roadToGoalZoneRollBp(input);
      expect(first).toBe(second);
      expect(first).toBeGreaterThanOrEqual(0);
      expect(first).toBeLessThan(10_000);
      const bucketIndex = Math.floor(first / 1_000);
      buckets[bucketIndex] = (buckets[bucketIndex] ?? 0) + 1;
    }

    const expected = trials / buckets.length;
    const sigma = Math.sqrt(trials * 0.1 * 0.9);
    for (const observed of buckets) {
      expect(Math.abs(observed - expected)).toBeLessThan(6 * sigma);
    }
  });

  it('verifies a complete zone proof and rejects tampering', () => {
    const serverSeed = 'cd'.repeat(32);
    const base = {
      serverSeed,
      calibrationVersionId: '22222222-2222-4222-8222-222222222222',
      rulesManifestHash: roadToGoalRulesManifestHash(),
      questionSetHash: QUESTION_SET_HASH,
      stakeCoins: 25,
      autoCashoutZone: null,
      clientSeed: 'player-seed',
      roundId: 'round-proof',
      zoneIndex: 4,
      survivalBp: 8_500,
    };
    const serverSeedCommitment = roadToGoalServerSeedCommitment({
      serverSeed,
      roundId: base.roundId,
      calibrationVersionId: base.calibrationVersionId,
      rulesManifestHash: base.rulesManifestHash,
      questionSetHash: base.questionSetHash,
      stakeCoins: base.stakeCoins,
      autoCashoutZone: base.autoCashoutZone,
    });
    const rollBp = roadToGoalZoneRollBp(base);
    const proof: RoadToGoalZoneProof = {
      ...base,
      serverSeedCommitment,
      rollBp,
      survived: roadToGoalDidSurvive(rollBp, base.survivalBp),
    };

    expect(verifyRoadToGoalZoneProof(proof)).toBe(true);
    expect(verifyRoadToGoalZoneProof({ ...proof, clientSeed: 'tampered' })).toBe(false);
    expect(verifyRoadToGoalZoneProof({ ...proof, rollBp: (rollBp + 1) % 10_000 })).toBe(false);
    expect(verifyRoadToGoalZoneProof({ ...proof, survived: !proof.survived })).toBe(false);
  });

  it('uses an exclusive survival threshold', () => {
    expect(roadToGoalDidSurvive(49, ROAD_TO_GOAL_MIN_SURVIVAL_BP)).toBe(true);
    expect(roadToGoalDidSurvive(50, ROAD_TO_GOAL_MIN_SURVIVAL_BP)).toBe(false);
  });

  it('holds near 98% under heterogeneous skill and survivor selection', () => {
    const cohortAccuracyBp = {
      high: { easy: 10_000, medium: 8_500, hard: 7_000 },
      low: { easy: 6_000, medium: 4_500, hard: 3_000 },
    } as const;

    const simulate = (zonePriors: readonly number[]) => {
      let highMass = 0.5;
      let lowMass = 0.5;
      return ROAD_TO_GOAL_MULTIPLIERS_BP.map((multiplierBp, zoneIndex) => {
        const difficulty = ROAD_TO_GOAL_DIFFICULTIES[zoneIndex];
        const expectedAccuracyBp = zonePriors[zoneIndex];
        if (!difficulty || expectedAccuracyBp == null) throw new Error('invalid test model');
        const odds = calculateRoadToGoalSurvivalOdds({
          multiplierLadderBp: ROAD_TO_GOAL_MULTIPLIERS_BP,
          zoneIndex,
          expectedAccuracyBp,
        });
        const survive = (accuracyBp: number) => (
          accuracyBp * odds.correctSurvivalBp
          + (10_000 - accuracyBp) * odds.wrongSurvivalBp
        ) / 100_000_000;
        highMass *= survive(cohortAccuracyBp.high[difficulty]);
        lowMass *= survive(cohortAccuracyBp.low[difficulty]);
        return (highMass + lowMass) * (multiplierBp / 10_000);
      });
    };

    const conditionalRtp = simulate(ROAD_TO_GOAL_ZONE_ACCURACY_PRIORS_BP);
    for (const rtp of conditionalRtp) {
      expect(Math.abs(rtp - 0.98)).toBeLessThan(0.0001);
    }

    const naivePriors = ROAD_TO_GOAL_DIFFICULTIES.map(
      (difficulty) => ROAD_TO_GOAL_ACCURACY_PRIORS_BP[difficulty]
    );
    expect(simulate(naivePriors).at(-1)).toBeGreaterThan(1.005);
  });
});
