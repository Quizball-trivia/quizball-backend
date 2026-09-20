import { createHash, createHmac, randomBytes } from 'crypto';
import {
  ROAD_TO_GOAL_COMMITMENT_VERSION,
} from './road-to-goal.constants.js';

export const ROAD_TO_GOAL_TARGET_RTP_BP = 9_800;
export const ROAD_TO_GOAL_DESIRED_SKILL_GAP_BP = 1_000;
export const ROAD_TO_GOAL_MIN_ACCURACY_BP = 3_500;
export const ROAD_TO_GOAL_MAX_ACCURACY_BP = 9_500;
export const ROAD_TO_GOAL_MIN_SURVIVAL_BP = 50;
export const ROAD_TO_GOAL_MAX_SURVIVAL_BP = 9_950;

const BASIS_POINTS = 10_000;
const FAIRNESS_VERSION = 1;
const MAX_ZONE_INDEX = 10;
const UINT32_RANGE = 0x1_0000_0000;
const SERVER_SEED_PATTERN = /^[a-f0-9]{64}$/i;
const COMMITMENT_PATTERN = /^[a-f0-9]{64}$/i;

export interface RoadToGoalSurvivalOdds {
  expectedAccuracyBp: number;
  targetSurvivalBp: number;
  correctSurvivalBp: number;
  wrongSurvivalBp: number;
  effectiveGapBp: number;
}

export interface RoadToGoalZoneProof {
  serverSeed: string;
  serverSeedCommitment: string;
  calibrationVersionId: string;
  rulesManifestHash: string;
  questionSetHash: string;
  stakeCoins: number;
  autoCashoutZone: number | null;
  clientSeed: string;
  roundId: string;
  zoneIndex: number;
  survivalBp: number;
  rollBp: number;
  survived: boolean;
}

export const ROAD_TO_GOAL_RULES_MANIFEST_V3 = {
  game: 'road-to-goal',
  version: 3,
  fairnessVersion: 1,
  targetRtpBp: 9_800,
  desiredSkillGapBp: 1_000,
  minimumAccuracyBp: 3_500,
  maximumAccuracyBp: 9_500,
  minimumSurvivalBp: 50,
  maximumSurvivalBp: 9_950,
  multiplierLadderBp: [
    10_300, 10_800, 11_500, 12_400, 13_600, 15_200,
    17_200, 19_800, 23_500, 29_000, 40_000,
  ],
  difficulties: [
    'easy', 'easy', 'easy', 'easy',
    'medium', 'medium', 'medium', 'medium',
    'hard', 'hard', 'hard',
  ],
  zoneAccuracyPriorsBp: [
    8_000, 8_042, 8_084, 8_126,
    6_669, 6_713, 6_757, 6_802,
    5_347, 5_393, 5_440,
  ],
  timeoutTreatment: 'gameplay_incorrect_editorial_separate',
} as const;

export type RoadToGoalRulesManifest = typeof ROAD_TO_GOAL_RULES_MANIFEST_V3;
export const ROAD_TO_GOAL_RULES_MANIFEST = ROAD_TO_GOAL_RULES_MANIFEST_V3;

function assertSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${label} must be a safe integer`);
  }
}

function assertZoneIndex(zoneIndex: number): void {
  assertSafeInteger(zoneIndex, 'zoneIndex');
  if (zoneIndex < 0 || zoneIndex > MAX_ZONE_INDEX) {
    throw new RangeError(`zoneIndex must be between 0 and ${MAX_ZONE_INDEX}`);
  }
}

function assertNonEmptyString(value: string, label: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

function assertServerSeed(serverSeed: string): void {
  if (!SERVER_SEED_PATTERN.test(serverSeed)) {
    throw new TypeError('serverSeed must be a 32-byte hexadecimal string');
  }
}

function roundedRatioBp(numeratorBp: number, denominatorBp: number): number {
  const numerator = BigInt(numeratorBp) * BigInt(BASIS_POINTS);
  const denominator = BigInt(denominatorBp);
  return Number((numerator + denominator / 2n) / denominator);
}

function validatedMultiplierLadder(multiplierLadderBp: readonly number[]): void {
  if (multiplierLadderBp.length !== MAX_ZONE_INDEX + 1) {
    throw new RangeError(`multiplierLadderBp must contain ${MAX_ZONE_INDEX + 1} zones`);
  }

  let previousMultiplier = 0;
  for (const multiplierBp of multiplierLadderBp) {
    assertSafeInteger(multiplierBp, 'multiplierBp');
    if (multiplierBp <= previousMultiplier) {
      throw new RangeError('multiplierLadderBp must be positive and strictly increasing');
    }
    previousMultiplier = multiplierBp;
  }
}

export function targetSurvivalBpForZone(
  multiplierLadderBp: readonly number[],
  zoneIndex: number,
  targetRtpBp = ROAD_TO_GOAL_TARGET_RTP_BP
): number {
  validatedMultiplierLadder(multiplierLadderBp);
  assertZoneIndex(zoneIndex);

  const numeratorBp = zoneIndex === 0
    ? targetRtpBp
    : multiplierLadderBp[zoneIndex - 1];
  const denominatorBp = multiplierLadderBp[zoneIndex];
  if (numeratorBp == null || denominatorBp == null) {
    throw new RangeError(`Missing multiplier for zone ${zoneIndex}`);
  }

  return roundedRatioBp(numeratorBp, denominatorBp);
}

function closestBoundedOdds(
  targetSurvivalBp: number,
  expectedAccuracyBp: number,
  gapBp: number,
  minimumSurvivalBp: number,
  maximumSurvivalBp: number
): { correctSurvivalBp: number; wrongSurvivalBp: number; error: number } | null {
  const idealWrongNumerator =
    targetSurvivalBp * BASIS_POINTS - expectedAccuracyBp * gapBp;
  const lowerWrongBp = Math.floor(idealWrongNumerator / BASIS_POINTS);
  const candidates = [lowerWrongBp, lowerWrongBp + 1];
  let closest: {
    correctSurvivalBp: number;
    wrongSurvivalBp: number;
    error: number;
  } | null = null;

  for (const wrongSurvivalBp of candidates) {
    const correctSurvivalBp = wrongSurvivalBp + gapBp;
    if (
      wrongSurvivalBp < minimumSurvivalBp ||
      correctSurvivalBp > maximumSurvivalBp
    ) {
      continue;
    }

    const weightedSurvivalNumerator =
      expectedAccuracyBp * correctSurvivalBp +
      (BASIS_POINTS - expectedAccuracyBp) * wrongSurvivalBp;
    const error = Math.abs(
      weightedSurvivalNumerator - targetSurvivalBp * BASIS_POINTS
    );
    if (closest == null || error < closest.error) {
      closest = { correctSurvivalBp, wrongSurvivalBp, error };
    }
  }

  return closest;
}

export function calculateRoadToGoalSurvivalOdds(input: {
  multiplierLadderBp: readonly number[];
  zoneIndex: number;
  expectedAccuracyBp: number;
  rules?: Pick<
    RoadToGoalRulesManifest,
    | 'targetRtpBp'
    | 'desiredSkillGapBp'
    | 'minimumAccuracyBp'
    | 'maximumAccuracyBp'
    | 'minimumSurvivalBp'
    | 'maximumSurvivalBp'
  >;
}): RoadToGoalSurvivalOdds {
  assertSafeInteger(input.expectedAccuracyBp, 'expectedAccuracyBp');
  const rules = input.rules ?? ROAD_TO_GOAL_RULES_MANIFEST;
  const expectedAccuracyBp = Math.min(
    rules.maximumAccuracyBp,
    Math.max(rules.minimumAccuracyBp, input.expectedAccuracyBp)
  );
  const targetSurvivalBp = targetSurvivalBpForZone(
    input.multiplierLadderBp,
    input.zoneIndex,
    rules.targetRtpBp
  );
  if (
    targetSurvivalBp < rules.minimumSurvivalBp ||
    targetSurvivalBp > rules.maximumSurvivalBp
  ) {
    throw new RangeError('The multiplier ladder produces an unsupported survival target');
  }

  for (
    let gapBp = rules.desiredSkillGapBp;
    gapBp > 0;
    gapBp -= 1
  ) {
    const odds = closestBoundedOdds(
      targetSurvivalBp,
      expectedAccuracyBp,
      gapBp,
      rules.minimumSurvivalBp,
      rules.maximumSurvivalBp
    );
    if (odds != null) {
      return {
        expectedAccuracyBp,
        targetSurvivalBp,
        correctSurvivalBp: odds.correctSurvivalBp,
        wrongSurvivalBp: odds.wrongSurvivalBp,
        effectiveGapBp: gapBp,
      };
    }
  }

  throw new RangeError('Unable to produce bounded skill-adjusted survival odds');
}

export function newRoadToGoalServerSeed(): string {
  return randomBytes(32).toString('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  ).join(',')}}`;
}

export function roadToGoalRulesManifestHash(manifest: unknown = ROAD_TO_GOAL_RULES_MANIFEST): string {
  return createHash('sha256').update(canonicalJson(manifest)).digest('hex');
}

const ROAD_TO_GOAL_RULES_BY_HASH = new Map<string, RoadToGoalRulesManifest>([
  [roadToGoalRulesManifestHash(ROAD_TO_GOAL_RULES_MANIFEST_V3), ROAD_TO_GOAL_RULES_MANIFEST_V3],
]);

/** Resolve a frozen, supported ruleset by its committed digest. New releases
 * must add a new manifest instead of mutating an existing one. */
export function roadToGoalRulesManifestByHash(hash: string): RoadToGoalRulesManifest | null {
  return ROAD_TO_GOAL_RULES_BY_HASH.get(hash.toLowerCase()) ?? null;
}

type CommittedQuestion = {
  commitment_salt?: string;
  question_id: string;
  difficulty: string;
  prompt: unknown;
  image?: unknown;
  options: ReadonlyArray<{ id: string; text: unknown }>;
  correct_option_id: string;
  expected_accuracy_bp: number;
  calibration_source: string;
};

function roadToGoalQuestionCommitmentView(question: CommittedQuestion, zone: number) {
  return {
    zone,
    commitment_salt: question.commitment_salt ?? null,
    question_id: question.question_id,
    difficulty: question.difficulty,
    prompt: question.prompt,
    image: question.image ?? null,
    options: question.options,
    correct_option_id: question.correct_option_id,
    expected_accuracy_bp: question.expected_accuracy_bp,
    calibration_source: question.calibration_source,
  };
}

export function roadToGoalQuestionHash(question: CommittedQuestion, zone: number): string {
  if (!Number.isInteger(zone) || zone < 1 || zone > 11) {
    throw new RangeError('Question zone must be between 1 and 11');
  }
  return createHash('sha256')
    .update(canonicalJson(roadToGoalQuestionCommitmentView(question, zone)))
    .digest('hex');
}

export function roadToGoalQuestionHashes(questions: ReadonlyArray<CommittedQuestion>): string[] {
  if (questions.length !== 11) throw new RangeError('Question set must contain 11 zones');
  return questions.map((question, index) => roadToGoalQuestionHash(question, index + 1));
}

export function roadToGoalQuestionSetHash(questions: ReadonlyArray<CommittedQuestion>): string {
  return createHash('sha256')
    .update(canonicalJson(roadToGoalQuestionHashes(questions)))
    .digest('hex');
}

export function roadToGoalServerSeedCommitment(input: {
  commitmentVersion?: number;
  serverSeed: string;
  roundId: string;
  calibrationVersionId: string;
  rulesManifestHash: string;
  questionSetHash: string;
  stakeCoins: number;
  autoCashoutZone: number | null;
}): string {
  const {
    commitmentVersion = ROAD_TO_GOAL_COMMITMENT_VERSION,
    serverSeed,
    roundId,
    calibrationVersionId,
    rulesManifestHash,
    questionSetHash,
    stakeCoins,
    autoCashoutZone,
  } = input;
  assertServerSeed(serverSeed);
  assertSafeInteger(commitmentVersion, 'commitmentVersion');
  assertNonEmptyString(roundId, 'roundId');
  assertNonEmptyString(calibrationVersionId, 'calibrationVersionId');
  if (!COMMITMENT_PATTERN.test(rulesManifestHash)) {
    throw new TypeError('rulesManifestHash must be a SHA-256 hexadecimal string');
  }
  if (!COMMITMENT_PATTERN.test(questionSetHash)) {
    throw new TypeError('questionSetHash must be a SHA-256 hexadecimal string');
  }
  assertSafeInteger(stakeCoins, 'stakeCoins');
  if (autoCashoutZone != null) assertSafeInteger(autoCashoutZone, 'autoCashoutZone');
  return createHash('sha256').update(JSON.stringify([
    'road-to-goal-commitment',
    commitmentVersion,
    roundId,
    calibrationVersionId,
    rulesManifestHash.toLowerCase(),
    questionSetHash.toLowerCase(),
    stakeCoins,
    autoCashoutZone,
    serverSeed.toLowerCase(),
  ])).digest('hex');
}

export function verifyRoadToGoalServerSeedCommitment(
  input: {
    commitmentVersion?: number;
    serverSeed: string;
    roundId: string;
    calibrationVersionId: string;
    rulesManifestHash: string;
    questionSetHash: string;
    stakeCoins: number;
    autoCashoutZone: number | null;
  },
  commitment: string
): boolean {
  if (!SERVER_SEED_PATTERN.test(input.serverSeed) || !COMMITMENT_PATTERN.test(commitment)) {
    return false;
  }
  try {
    return roadToGoalServerSeedCommitment(input) === commitment.toLowerCase();
  } catch {
    return false;
  }
}

export function roadToGoalZoneHmacInput(input: {
  clientSeed: string;
  roundId: string;
  zoneIndex: number;
}): string {
  assertNonEmptyString(input.clientSeed, 'clientSeed');
  assertNonEmptyString(input.roundId, 'roundId');
  assertZoneIndex(input.zoneIndex);
  return JSON.stringify([
    'road-to-goal',
    FAIRNESS_VERSION,
    input.clientSeed,
    input.roundId,
    input.zoneIndex,
  ]);
}

function unbiasedRollBp(serverSeed: string, hmacInput: string): number {
  const rejectionLimit = Math.floor(UINT32_RANGE / BASIS_POINTS) * BASIS_POINTS;
  let digest = createHmac('sha256', serverSeed).update(hmacInput).digest();
  let counter = 0;

  for (;;) {
    for (let offset = 0; offset + 4 <= digest.length; offset += 4) {
      const value = digest.readUInt32BE(offset);
      if (value < rejectionLimit) {
        return value % BASIS_POINTS;
      }
    }
    counter += 1;
    digest = createHmac('sha256', serverSeed)
      .update(`${hmacInput}:${counter}`)
      .digest();
  }
}

export function roadToGoalZoneRollBp(input: {
  serverSeed: string;
  clientSeed: string;
  roundId: string;
  zoneIndex: number;
}): number {
  assertServerSeed(input.serverSeed);
  const hmacInput = roadToGoalZoneHmacInput(input);
  return unbiasedRollBp(input.serverSeed, hmacInput);
}

export function roadToGoalDidSurvive(rollBp: number, survivalBp: number): boolean {
  assertSafeInteger(rollBp, 'rollBp');
  assertSafeInteger(survivalBp, 'survivalBp');
  if (rollBp < 0 || rollBp >= BASIS_POINTS) {
    throw new RangeError(`rollBp must be between 0 and ${BASIS_POINTS - 1}`);
  }
  if (
    survivalBp < ROAD_TO_GOAL_MIN_SURVIVAL_BP ||
    survivalBp > ROAD_TO_GOAL_MAX_SURVIVAL_BP
  ) {
    throw new RangeError(
      `survivalBp must be between ${ROAD_TO_GOAL_MIN_SURVIVAL_BP} and ${ROAD_TO_GOAL_MAX_SURVIVAL_BP}`
    );
  }
  return rollBp < survivalBp;
}

export function verifyRoadToGoalZoneProof(proof: RoadToGoalZoneProof): boolean {
  try {
    if (
      !verifyRoadToGoalServerSeedCommitment(
        {
          serverSeed: proof.serverSeed,
          roundId: proof.roundId,
          calibrationVersionId: proof.calibrationVersionId,
          rulesManifestHash: proof.rulesManifestHash,
          questionSetHash: proof.questionSetHash,
          stakeCoins: proof.stakeCoins,
          autoCashoutZone: proof.autoCashoutZone,
        },
        proof.serverSeedCommitment
      )
    ) {
      return false;
    }
    const rollBp = roadToGoalZoneRollBp(proof);
    return (
      rollBp === proof.rollBp &&
      roadToGoalDidSurvive(rollBp, proof.survivalBp) === proof.survived
    );
  } catch {
    return false;
  }
}
