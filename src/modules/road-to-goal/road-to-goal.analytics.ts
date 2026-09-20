import { trackEvent } from '../../core/analytics.js';
import { config } from '../../core/config.js';
import { ROAD_TO_GOAL_ZONES } from './road-to-goal.constants.js';
import type {
  RoadToGoalQuestionSnapshot,
  RoadToGoalRoundRow,
} from './road-to-goal.types.js';

function decimal(value: number | string | null): number {
  if (value == null) return 0;
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function durationMs(row: RoadToGoalRoundRow): number {
  const startedAt = new Date(row.created_at).getTime();
  const endedAt = new Date(row.settled_at ?? row.updated_at).getTime();
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt)) return 0;
  return Math.max(0, endedAt - startedAt);
}

function runInsertId(roundId: string, suffix: string): string {
  return `road-to-goal:${roundId}:${suffix}`;
}

function productionAnalyticsEnabled(): boolean {
  return config.NODE_ENV === 'prod';
}

export function trackRoadToGoalRunStarted(row: RoadToGoalRoundRow): void {
  if (!productionAnalyticsEnabled()) return;
  trackEvent('road_to_goal_run_started', row.user_id, {
    $insert_id: runInsertId(row.id, 'started'),
    game: 'road_to_goal',
    game_mode: 'live',
    round_id: row.id,
    stake_coins: row.stake_coins,
    auto_cashout_zone: row.auto_cashout_zone,
    total_zones: ROAD_TO_GOAL_ZONES,
    commitment_version: row.commitment_version,
    calibration_version_id: row.calibration_version_id,
  });
}

export function trackRoadToGoalQuestionResolved(input: {
  row: RoadToGoalRoundRow;
  question: RoadToGoalQuestionSnapshot;
  zone: number;
  outcome: 'correct' | 'wrong' | 'late';
  answerMs: number | null;
  survived: boolean;
  expectedAccuracyBp: number;
  targetSurvivalBp: number;
  correctSurvivalBp: number;
  wrongSurvivalBp: number;
  appliedSurvivalBp: number;
  rollBp: number;
}): void {
  if (!productionAnalyticsEnabled()) return;
  trackEvent('road_to_goal_question_resolved', input.row.user_id, {
    $insert_id: runInsertId(input.row.id, `zone:${input.zone}:resolved`),
    game: 'road_to_goal',
    game_mode: 'live',
    round_id: input.row.id,
    zone: input.zone,
    total_zones: ROAD_TO_GOAL_ZONES,
    question_id: input.question.question_id,
    difficulty: input.question.difficulty,
    calibration_source: input.question.calibration_source,
    outcome: input.outcome,
    answered_correctly: input.outcome === 'correct',
    timed_out: input.outcome === 'late',
    survived: input.survived,
    answer_duration_ms: input.answerMs,
    expected_accuracy_bp: input.expectedAccuracyBp,
    target_survival_bp: input.targetSurvivalBp,
    correct_survival_bp: input.correctSurvivalBp,
    wrong_survival_bp: input.wrongSurvivalBp,
    applied_survival_bp: input.appliedSurvivalBp,
    roll_bp: input.rollBp,
    stake_coins: input.row.stake_coins,
    terminal_status: input.row.status === 'active' ? null : input.row.status,
  });
}

export function trackRoadToGoalRunSettled(row: RoadToGoalRoundRow): void {
  if (!productionAnalyticsEnabled() || row.status === 'active') return;

  const payoutCoins = decimal(row.payout_coins);
  const questionsAttempted = row.status === 'lost'
    ? Math.min(ROAD_TO_GOAL_ZONES, row.cleared_zones + 1)
    : row.cleared_zones;
  const settlementReason = row.settlement_reason ?? 'unknown';

  trackEvent('road_to_goal_run_settled', row.user_id, {
    $insert_id: runInsertId(row.id, 'settled'),
    game: 'road_to_goal',
    game_mode: 'live',
    round_id: row.id,
    result: row.status,
    settlement_reason: settlementReason,
    stake_coins: row.stake_coins,
    payout_coins: payoutCoins,
    net_coins: payoutCoins - row.stake_coins,
    payout_multiplier: row.stake_coins > 0 ? payoutCoins / row.stake_coins : 0,
    cleared_zones: row.cleared_zones,
    questions_attempted: questionsAttempted,
    total_zones: ROAD_TO_GOAL_ZONES,
    run_duration_ms: durationMs(row),
    completed_all_zones: row.status === 'completed',
    cashed_out: row.status === 'cashed',
    auto_cashout: settlementReason.includes('auto_cashout')
      || settlementReason.includes('decision_timeout'),
    timed_out: settlementReason.includes('timeout'),
    commitment_version: row.commitment_version,
    calibration_version_id: row.calibration_version_id,
  });
}
