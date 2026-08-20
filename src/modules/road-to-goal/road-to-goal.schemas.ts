import { z } from 'zod';
import { i18nFieldSchema } from '../../http/schemas/shared.js';
import { ROAD_TO_GOAL_STAKES } from './road-to-goal.constants.js';

const expectedVersionSchema = z.number().int().min(0).max(2_147_483_647);
const roundIdSchema = z.string().uuid();
const requestNonceSchema = z.string().uuid();
const coinAmountSchema = z.number().min(0).multipleOf(0.01);

export const prepareRoadToGoalCommitmentSchema = z.object({
  stake: z.union(ROAD_TO_GOAL_STAKES.map((stake) => z.literal(stake)) as [
    z.ZodLiteral<10>,
    z.ZodLiteral<25>,
    z.ZodLiteral<50>,
  ]),
  request_nonce: requestNonceSchema,
  auto_cashout_zone: z.number().int().min(1).max(10).nullable().optional().default(null),
});
export type PrepareRoadToGoalCommitmentRequest = z.infer<typeof prepareRoadToGoalCommitmentSchema>;

export const startRoadToGoalRoundSchema = z.object({
  commitment_id: roundIdSchema,
  client_nonce: z.string().uuid(),
  client_seed: z.string().trim().min(1).max(128),
});
export type StartRoadToGoalRoundRequest = z.infer<typeof startRoadToGoalRoundSchema>;

const roadToGoalRulesManifestSchema = z.object({
  game: z.literal('road-to-goal'),
  version: z.literal(3),
  fairnessVersion: z.number().int().positive(),
  targetRtpBp: z.number().int().min(1).max(10_000),
  desiredSkillGapBp: z.number().int().nonnegative(),
  minimumAccuracyBp: z.number().int().min(0).max(10_000),
  maximumAccuracyBp: z.number().int().min(0).max(10_000),
  minimumSurvivalBp: z.number().int().min(0).max(10_000),
  maximumSurvivalBp: z.number().int().min(0).max(10_000),
  multiplierLadderBp: z.array(z.number().int().positive()).length(11),
  difficulties: z.array(z.enum(['easy', 'medium', 'hard'])).length(11),
  zoneAccuracyPriorsBp: z.array(z.number().int().min(0).max(10_000)).length(11),
  timeoutTreatment: z.literal('gameplay_incorrect_editorial_separate'),
});

export const roadToGoalCommitmentResponseSchema = z.object({
  commitment_id: z.string().uuid(),
  commitment_version: z.literal(3),
  calibration_version_id: z.string().uuid(),
  stake_coins: z.union([z.literal(10), z.literal(25), z.literal(50)]),
  auto_cashout_zone: z.number().int().min(1).max(10).nullable(),
  commit_hash: z.string().regex(/^[0-9a-f]{64}$/),
  rules_manifest: roadToGoalRulesManifestSchema,
  rules_manifest_hash: z.string().regex(/^[0-9a-f]{64}$/),
  question_set_hash: z.string().regex(/^[0-9a-f]{64}$/),
  question_hashes: z.array(z.string().regex(/^[0-9a-f]{64}$/)).length(11),
  expires_at: z.string().datetime(),
  server_now: z.string().datetime(),
});

export const answerRoadToGoalQuestionSchema = z.object({
  round_id: roundIdSchema,
  question_id: z.string().uuid(),
  option_id: z.string().min(1).max(64),
  expected_version: expectedVersionSchema,
  request_nonce: requestNonceSchema,
});
export type AnswerRoadToGoalQuestionRequest = z.infer<typeof answerRoadToGoalQuestionSchema>;

export const continueRoadToGoalRoundSchema = z.object({
  round_id: roundIdSchema,
  expected_version: expectedVersionSchema,
  request_nonce: requestNonceSchema,
});
export type ContinueRoadToGoalRoundRequest = z.infer<typeof continueRoadToGoalRoundSchema>;

export const cashoutRoadToGoalRoundSchema = z.object({
  round_id: roundIdSchema,
  expected_version: expectedVersionSchema,
  request_nonce: requestNonceSchema,
});
export type CashoutRoadToGoalRoundRequest = z.infer<typeof cashoutRoadToGoalRoundSchema>;

export const roadToGoalRoundParamsSchema = z.object({
  roundId: roundIdSchema,
});
export type RoadToGoalRoundParams = z.infer<typeof roadToGoalRoundParamsSchema>;

const roadToGoalQuestionImageSchema = z.object({
  url: z.string().url(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  aspect_ratio: z.string().optional(),
});

const roadToGoalQuestionResponseSchema = z.object({
  question_id: z.string().uuid(),
  zone: z.number().int().min(1).max(11),
  difficulty: z.enum(['easy', 'medium', 'hard']),
  prompt: i18nFieldSchema,
  image: roadToGoalQuestionImageSchema.nullable(),
  options: z.array(z.object({
    id: z.string().min(1).max(64),
    text: i18nFieldSchema,
  })).length(4),
  duration_ms: z.number().int().positive(),
  deadline_at: z.string().datetime(),
  expected_accuracy_bp: z.number().int().min(0).max(10_000),
  target_survival_bp: z.number().int().min(0).max(10_000),
  correct_survival_bp: z.number().int().min(0).max(10_000),
  wrong_survival_bp: z.number().int().min(0).max(10_000),
});

export const roadToGoalStateResponseSchema = z.object({
  round_id: z.string().uuid(),
  status: z.enum(['active', 'cashed', 'lost', 'completed']),
  phase: z.enum(['question', 'decision', 'settled']),
  state_version: expectedVersionSchema,
  stake_coins: z.union([z.literal(10), z.literal(25), z.literal(50)]),
  cleared_zones: z.number().int().min(0).max(11),
  total_zones: z.literal(11),
  current_multiplier_bp: z.number().int().nonnegative(),
  next_multiplier_bp: z.number().int().nonnegative().nullable(),
  current_return_coins: coinAmountSchema,
  next_return_coins: coinAmountSchema.nullable(),
  zone_multipliers_bp: z.array(z.number().int().positive()).length(11),
  calibration_version_id: z.string().uuid().nullable(),
  commitment_version: z.literal(3).nullable(),
  commit_hash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  rules_manifest_hash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  question_set_hash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  client_seed: z.string().min(1).max(128).nullable(),
  server_seed: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  auto_cashout_zone: z.number().int().min(1).max(10).nullable(),
  decision_deadline_at: z.string().datetime().nullable(),
  settlement_reason: z.string().nullable(),
  question: roadToGoalQuestionResponseSchema.nullable(),
  payout_coins: coinAmountSchema.nullable(),
  server_now: z.string().datetime(),
});

export const answerRoadToGoalResponseSchema = z.object({
  outcome: z.enum(['correct', 'wrong', 'late']),
  correct_option_id: z.string().min(1).max(64),
  survived: z.boolean(),
  expected_accuracy_bp: z.number().int().min(0).max(10_000),
  target_survival_bp: z.number().int().min(0).max(10_000),
  correct_survival_bp: z.number().int().min(0).max(10_000),
  wrong_survival_bp: z.number().int().min(0).max(10_000),
  applied_survival_bp: z.number().int().min(0).max(10_000),
  roll_bp: z.number().int().min(0).max(9_999),
  state: roadToGoalStateResponseSchema,
});

export const roadToGoalProofResponseSchema = z.object({
  version: z.literal(3),
  round_id: z.string().uuid(),
  calibration_version_id: z.string().uuid().nullable(),
  commitment_version: z.literal(3),
  commit_hash: z.string().regex(/^[0-9a-f]{64}$/),
  rules_manifest: roadToGoalRulesManifestSchema,
  rules_manifest_hash: z.string().regex(/^[0-9a-f]{64}$/),
  question_set_hash: z.string().regex(/^[0-9a-f]{64}$/),
  question_hashes: z.array(z.string().regex(/^[0-9a-f]{64}$/)).length(11),
  stake_coins: z.union([z.literal(10), z.literal(25), z.literal(50)]),
  auto_cashout_zone: z.number().int().min(1).max(10).nullable(),
  question_set: z.array(z.object({
    zone: z.number().int().min(1).max(11),
    commitment_salt: z.string().regex(/^[0-9a-f]{64}$/),
    question_id: z.string().uuid(),
    difficulty: z.enum(['easy', 'medium', 'hard']),
    prompt: i18nFieldSchema,
    image: roadToGoalQuestionImageSchema.nullable(),
    options: z.array(z.object({
      id: z.string().min(1).max(64),
      text: i18nFieldSchema,
    })).length(4),
    correct_option_id: z.string().min(1).max(64),
    expected_accuracy_bp: z.number().int().min(0).max(10_000),
    calibration_source: z.enum(['difficulty_prior', 'ranked', 'blended', 'road']),
  })).min(1).max(11),
  server_seed: z.string().regex(/^[0-9a-f]{64}$/),
  client_seed: z.string().min(1).max(128),
  status: z.enum(['cashed', 'lost', 'completed']),
  payout_coins: coinAmountSchema,
  cleared_zones: z.number().int().min(0).max(11),
  zones: z.array(z.object({
    zone: z.number().int().min(1).max(11),
    question_id: z.string().uuid(),
    answer_option_id: z.string().min(1).max(64).nullable(),
    correct_option_id: z.string().min(1).max(64),
    outcome: z.enum(['correct', 'wrong', 'late']),
    expected_accuracy_bp: z.number().int().min(0).max(10_000),
    target_survival_bp: z.number().int().min(0).max(10_000),
    correct_survival_bp: z.number().int().min(0).max(10_000),
    wrong_survival_bp: z.number().int().min(0).max(10_000),
    applied_survival_bp: z.number().int().min(0).max(10_000),
    roll_bp: z.number().int().min(0).max(9_999),
    survived: z.boolean(),
  })).max(11),
});
