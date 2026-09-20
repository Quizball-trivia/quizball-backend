import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  nodeEnv: 'prod',
  trackEvent: vi.fn(),
}));

vi.mock('../../src/core/analytics.js', () => ({
  trackEvent: mocks.trackEvent,
}));

vi.mock('../../src/core/config.js', () => ({
  config: {
    get NODE_ENV() {
      return mocks.nodeEnv;
    },
  },
}));

import {
  trackRoadToGoalQuestionResolved,
  trackRoadToGoalRunSettled,
  trackRoadToGoalRunStarted,
} from '../../src/modules/road-to-goal/road-to-goal.analytics.js';
import type {
  RoadToGoalQuestionSnapshot,
  RoadToGoalRoundRow,
} from '../../src/modules/road-to-goal/road-to-goal.types.js';

const round: RoadToGoalRoundRow = {
  id: '11111111-1111-4111-8111-111111111111',
  user_id: '22222222-2222-4222-8222-222222222222',
  status: 'active',
  phase: 'question',
  state_version: 1,
  stake_coins: 25,
  cleared_zones: 0,
  run_questions: [],
  question_deadline_at: '2026-08-20T10:00:16.500Z',
  client_nonce: 'client-nonce',
  payout_coins: null,
  calibration_version_id: '33333333-3333-4333-8333-333333333333',
  server_seed: 'server-seed',
  commit_hash: 'commit-hash',
  commitment_version: 3,
  rules_manifest_hash: 'rules-hash',
  question_set_hash: 'question-set-hash',
  client_seed: 'client-seed',
  auto_cashout_zone: null,
  decision_deadline_at: null,
  settlement_reason: null,
  last_seen_at: '2026-08-20T10:00:00.000Z',
  created_at: '2026-08-20T10:00:00.000Z',
  updated_at: '2026-08-20T10:00:00.000Z',
  settled_at: null,
};

const question: RoadToGoalQuestionSnapshot = {
  commitment_salt: 'a'.repeat(64),
  question_id: '44444444-4444-4444-8444-444444444444',
  difficulty: 'easy',
  prompt: { en: 'Question', ka: 'Question' },
  options: [
    { id: 'a', text: { en: 'A', ka: 'A' } },
    { id: 'b', text: { en: 'B', ka: 'B' } },
  ],
  correct_option_id: 'a',
  expected_accuracy_bp: 7_000,
  calibration_source: 'blended',
};

describe('Road to Goal analytics', () => {
  beforeEach(() => {
    mocks.nodeEnv = 'prod';
    mocks.trackEvent.mockReset();
  });

  it('tracks an idempotent authoritative run start', () => {
    trackRoadToGoalRunStarted(round);

    expect(mocks.trackEvent).toHaveBeenCalledWith(
      'road_to_goal_run_started',
      round.user_id,
      expect.objectContaining({
        $insert_id: `road-to-goal:${round.id}:started`,
        round_id: round.id,
        stake_coins: 25,
        total_zones: 11,
      }),
    );
  });

  it('tracks correctness, survival, timing, and calibrated odds per zone', () => {
    trackRoadToGoalQuestionResolved({
      row: { ...round, cleared_zones: 1, phase: 'decision', state_version: 2 },
      question,
      zone: 1,
      outcome: 'correct',
      answerMs: 2_350,
      survived: true,
      expectedAccuracyBp: 7_000,
      targetSurvivalBp: 8_000,
      correctSurvivalBp: 8_300,
      wrongSurvivalBp: 7_300,
      appliedSurvivalBp: 8_300,
      rollBp: 5_123,
    });

    expect(mocks.trackEvent).toHaveBeenCalledWith(
      'road_to_goal_question_resolved',
      round.user_id,
      expect.objectContaining({
        zone: 1,
        difficulty: 'easy',
        answered_correctly: true,
        survived: true,
        answer_duration_ms: 2_350,
        correct_survival_bp: 8_300,
        roll_bp: 5_123,
      }),
    );
  });

  it('tracks terminal economy and total duration without exposing answer text', () => {
    trackRoadToGoalRunSettled({
      ...round,
      status: 'cashed',
      phase: 'settled',
      cleared_zones: 4,
      payout_coins: '31.00',
      settlement_reason: 'road_to_goal_cashout',
      settled_at: '2026-08-20T10:00:42.000Z',
      updated_at: '2026-08-20T10:00:42.000Z',
    });

    expect(mocks.trackEvent).toHaveBeenCalledWith(
      'road_to_goal_run_settled',
      round.user_id,
      expect.objectContaining({
        result: 'cashed',
        payout_coins: 31,
        net_coins: 6,
        payout_multiplier: 1.24,
        cleared_zones: 4,
        run_duration_ms: 42_000,
      }),
    );
  });

  it('never emits Road to Goal events from staging or local', () => {
    mocks.nodeEnv = 'staging';
    trackRoadToGoalRunStarted(round);
    mocks.nodeEnv = 'local';
    trackRoadToGoalRunSettled({ ...round, status: 'lost' });

    expect(mocks.trackEvent).not.toHaveBeenCalled();
  });
});
