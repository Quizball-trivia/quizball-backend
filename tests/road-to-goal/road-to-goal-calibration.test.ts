import { describe, expect, it } from 'vitest';
import {
  applyQuestionCalibrations,
  assertCalibrationVersion,
} from '../../src/modules/road-to-goal/road-to-goal.calibration.js';
import type {
  RoadToGoalCalibrationVersionRow,
  RoadToGoalQuestionSnapshot,
} from '../../src/modules/road-to-goal/road-to-goal.types.js';

const question: RoadToGoalQuestionSnapshot = {
  question_id: '11111111-1111-4111-8111-111111111111',
  difficulty: 'easy',
  prompt: { en: 'Question' },
  options: [
    { id: 'a', text: { en: 'A' } },
    { id: 'b', text: { en: 'B' } },
    { id: 'c', text: { en: 'C' } },
    { id: 'd', text: { en: 'D' } },
  ],
  correct_option_id: 'a',
  expected_accuracy_bp: 8_000,
  calibration_source: 'difficulty_prior',
};

const version: RoadToGoalCalibrationVersionRow = {
  id: '22222222-2222-4222-8222-222222222222',
  publication_day: '2026-08-20',
  rules_version: 2,
  target_rtp_bp: 9_800,
  skill_gap_bp: 1_000,
  easy_prior_bp: 8_000,
  medium_prior_bp: 6_500,
  hard_prior_bp: 5_000,
  minimum_accuracy_bp: 3_500,
  maximum_accuracy_bp: 9_500,
  minimum_survival_bp: 50,
  maximum_survival_bp: 9_950,
  minimum_road_answers: 100,
  config: {},
  created_at: '2026-08-20T00:00:00.000Z',
};

describe('Road to Goal calibration snapshots', () => {
  it('applies a published question calibration and preserves fallback priors', () => {
    const calibrated = applyQuestionCalibrations([question, { ...question, question_id: 'other' }], [
      { question_id: question.question_id, zone: 1, expected_accuracy_bp: 7_412, source: 'blended' },
    ]);

    expect(calibrated[0]).toMatchObject({ expected_accuracy_bp: 7_412, calibration_source: 'blended' });
    expect(calibrated[1]).toMatchObject({ expected_accuracy_bp: 8_042, calibration_source: 'difficulty_prior' });
  });

  it('rejects a version published for different economics', () => {
    expect(() => assertCalibrationVersion(version)).not.toThrow();
    expect(() => assertCalibrationVersion({ ...version, target_rtp_bp: 9_700 }))
      .toThrow('does not match');
  });
});
