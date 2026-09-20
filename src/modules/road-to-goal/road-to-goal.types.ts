import type { I18nField, Json } from '../../db/types.js';

export type RoadToGoalDifficulty = 'easy' | 'medium' | 'hard';
export type RoadToGoalQuestionSelectionMode = 'unseen' | 'least_exposed';
export type RoadToGoalStatus = 'active' | 'cashed' | 'lost' | 'completed';
export type RoadToGoalPhase = 'question' | 'decision' | 'settled';
export type RoadToGoalCalibrationSource = 'difficulty_prior' | 'ranked' | 'blended' | 'road';

export interface RoadToGoalQuestionCandidate {
  id: string;
  difficulty: RoadToGoalDifficulty;
  prompt: Json;
  payload: Json;
  /** Present on fallback rows so the in-process validator cannot discard the
   * database's least-exposed / least-recent ordering. */
  selection_priority?: number;
}

export interface RoadToGoalQuestionImage {
  url: string;
  width: number;
  height: number;
  aspect_ratio?: string;
}

export interface RoadToGoalQuestionSnapshot {
  /** Per-zone hiding salt disclosed only if this question was dealt. */
  commitment_salt: string;
  question_id: string;
  difficulty: RoadToGoalDifficulty;
  prompt: I18nField;
  image?: RoadToGoalQuestionImage;
  options: Array<{ id: string; text: I18nField }>;
  correct_option_id: string;
  expected_accuracy_bp: number;
  calibration_source: RoadToGoalCalibrationSource;
}

export interface RoadToGoalRoundRow {
  id: string;
  user_id: string;
  status: RoadToGoalStatus;
  phase: RoadToGoalPhase;
  state_version: number;
  stake_coins: number;
  cleared_zones: number;
  run_questions: Json;
  question_deadline_at: string | null;
  client_nonce: string;
  payout_coins: number | string | null;
  calibration_version_id: string | null;
  server_seed: string | null;
  commit_hash: string | null;
  commitment_version: number | null;
  rules_manifest_hash: string | null;
  question_set_hash: string | null;
  client_seed: string | null;
  auto_cashout_zone: number | null;
  decision_deadline_at: string | null;
  settlement_reason: string | null;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
  settled_at: string | null;
  /** Database clock and deadline comparisons projected by repository queries. */
  database_now?: string;
  question_expired?: boolean;
  decision_expired?: boolean;
}

export interface RoadToGoalCommitmentRow {
  round_id: string;
  user_id: string;
  request_nonce: string;
  stake_coins: number;
  auto_cashout_zone: number | null;
  calibration_version_id: string;
  commitment_version: 3;
  server_seed: string;
  commit_hash: string;
  rules_manifest: Json;
  rules_manifest_hash: string;
  run_questions: Json;
  question_set_hash: string;
  status: 'prepared' | 'consumed' | 'expired';
  expires_at: string;
  consumed_at: string | null;
  created_at: string;
  database_now?: string;
}

export type RoadToGoalEventType =
  | 'start'
  | 'question_dealt'
  | 'answer'
  | 'continue'
  | 'cashout'
  | 'auto_cashout'
  | 'complete'
  | 'timeout';

export interface RoadToGoalEventInput {
  roundId: string;
  userId: string;
  zone: number;
  stateVersion: number;
  eventType: RoadToGoalEventType;
  questionId?: string | null;
  answerOption?: string | null;
  correctOption?: string | null;
  answerCorrect?: boolean | null;
  answerMs?: number | null;
  multiplierBp?: number | null;
  stakeCoins?: number | null;
  payoutCoins?: number | string | null;
  clientNonce?: string | null;
  requestNonce?: string | null;
  expectedAccuracyBp?: number | null;
  targetSurvivalBp?: number | null;
  correctSurvivalBp?: number | null;
  wrongSurvivalBp?: number | null;
  appliedSurvivalBp?: number | null;
  rollBp?: number | null;
  survived?: boolean | null;
}

export interface RoadToGoalEventRow {
  id: string;
  round_id: string;
  user_id: string;
  zone: number;
  state_version: number;
  event_type: RoadToGoalEventType;
  question_id: string | null;
  answer_option: string | null;
  correct_option: string | null;
  answer_correct: boolean | null;
  answer_ms: number | null;
  multiplier_bp: number | null;
  stake_coins: number | null;
  payout_coins: number | string | null;
  client_nonce: string | null;
  request_nonce: string | null;
  expected_accuracy_bp: number | null;
  target_survival_bp: number | null;
  correct_survival_bp: number | null;
  wrong_survival_bp: number | null;
  applied_survival_bp: number | null;
  roll_bp: number | null;
  survived: boolean | null;
  created_at: string;
}

export interface RoadToGoalCalibrationVersionRow {
  id: string;
  publication_day: string;
  rules_version: number;
  target_rtp_bp: number;
  skill_gap_bp: number;
  easy_prior_bp: number;
  medium_prior_bp: number;
  hard_prior_bp: number;
  minimum_accuracy_bp: number;
  maximum_accuracy_bp: number;
  minimum_survival_bp: number;
  maximum_survival_bp: number;
  minimum_road_answers: number;
  config: Json;
  created_at: string;
}

export interface RoadToGoalQuestionCalibrationRow {
  question_id: string;
  zone: number;
  expected_accuracy_bp: number;
  source: RoadToGoalCalibrationSource;
}
