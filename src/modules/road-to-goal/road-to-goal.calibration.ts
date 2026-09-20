import {
  ROAD_TO_GOAL_ACCURACY_PRIORS_BP,
  ROAD_TO_GOAL_CALIBRATION_MIN_ROAD_ANSWERS,
  ROAD_TO_GOAL_ZONE_ACCURACY_PRIORS_BP,
} from './road-to-goal.constants.js';
import {
  ROAD_TO_GOAL_DESIRED_SKILL_GAP_BP,
  ROAD_TO_GOAL_MAX_ACCURACY_BP,
  ROAD_TO_GOAL_MAX_SURVIVAL_BP,
  ROAD_TO_GOAL_MIN_ACCURACY_BP,
  ROAD_TO_GOAL_MIN_SURVIVAL_BP,
  ROAD_TO_GOAL_TARGET_RTP_BP,
} from './road-to-goal.fairness.js';
import { logger } from '../../core/logger.js';
import { sql, type TransactionSql } from '../../db/index.js';
import { ROAD_TO_GOAL_MULTIPLIERS_BP } from './road-to-goal.constants.js';
import { roadToGoalRepo } from './road-to-goal.repo.js';
import type {
  RoadToGoalCalibrationVersionRow,
  RoadToGoalQuestionCalibrationRow,
  RoadToGoalQuestionSnapshot,
} from './road-to-goal.types.js';

export const ROAD_TO_GOAL_CALIBRATION_CONFIG = {
  rulesVersion: 2,
  targetRtpBp: ROAD_TO_GOAL_TARGET_RTP_BP,
  skillGapBp: ROAD_TO_GOAL_DESIRED_SKILL_GAP_BP,
  easyPriorBp: ROAD_TO_GOAL_ACCURACY_PRIORS_BP.easy,
  mediumPriorBp: ROAD_TO_GOAL_ACCURACY_PRIORS_BP.medium,
  hardPriorBp: ROAD_TO_GOAL_ACCURACY_PRIORS_BP.hard,
  minimumAccuracyBp: ROAD_TO_GOAL_MIN_ACCURACY_BP,
  maximumAccuracyBp: ROAD_TO_GOAL_MAX_ACCURACY_BP,
  minimumSurvivalBp: ROAD_TO_GOAL_MIN_SURVIVAL_BP,
  maximumSurvivalBp: ROAD_TO_GOAL_MAX_SURVIVAL_BP,
  minimumRoadAnswers: ROAD_TO_GOAL_CALIBRATION_MIN_ROAD_ANSWERS,
  zoneAccuracyPriorsBp: ROAD_TO_GOAL_ZONE_ACCURACY_PRIORS_BP,
} as const;

export function applyQuestionCalibrations(
  questions: readonly RoadToGoalQuestionSnapshot[],
  calibrations: readonly RoadToGoalQuestionCalibrationRow[]
): RoadToGoalQuestionSnapshot[] {
  const byQuestionAndZone = new Map(
    calibrations.map((row) => [`${row.question_id}:${row.zone}`, row])
  );
  return questions.map((question, index) => {
    const calibration = byQuestionAndZone.get(`${question.question_id}:${index + 1}`);
    if (!calibration) {
      const zonePrior = ROAD_TO_GOAL_ZONE_ACCURACY_PRIORS_BP[index];
      if (zonePrior == null) throw new RangeError(`Missing accuracy prior for zone ${index + 1}`);
      return {
        ...question,
        expected_accuracy_bp: zonePrior,
        calibration_source: 'difficulty_prior',
      };
    }
    return {
      ...question,
      expected_accuracy_bp: calibration.expected_accuracy_bp,
      calibration_source: calibration.source,
    };
  });
}

export function assertCalibrationVersion(
  version: RoadToGoalCalibrationVersionRow
): void {
  const expected = ROAD_TO_GOAL_CALIBRATION_CONFIG;
  if (
    version.target_rtp_bp !== expected.targetRtpBp
    || version.rules_version !== expected.rulesVersion
    || version.skill_gap_bp !== expected.skillGapBp
    || version.easy_prior_bp !== expected.easyPriorBp
    || version.medium_prior_bp !== expected.mediumPriorBp
    || version.hard_prior_bp !== expected.hardPriorBp
    || version.minimum_accuracy_bp !== expected.minimumAccuracyBp
    || version.maximum_accuracy_bp !== expected.maximumAccuracyBp
    || version.minimum_survival_bp !== expected.minimumSurvivalBp
    || version.maximum_survival_bp !== expected.maximumSurvivalBp
    || version.minimum_road_answers !== expected.minimumRoadAnswers
  ) {
    throw new RangeError('Road to Goal calibration version does not match the active game rules');
  }
}

function utcPublicationDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Publish at most one immutable calibration snapshot per UTC day. The
 * transaction-scoped advisory lock keeps multi-replica publication safe while
 * normal game starts take the indexed fast path. */
export async function ensureRoadToGoalDailyCalibration(
  tx: TransactionSql,
  now?: Date,
  options: { logPublication?: boolean } = {}
): Promise<RoadToGoalCalibrationVersionRow> {
  const publicationDay = now
    ? utcPublicationDay(now)
    : await roadToGoalRepo.getDatabasePublicationDay(tx);
  let version = await roadToGoalRepo.getCalibrationVersionForDay(tx, publicationDay);
  if (version) {
    assertCalibrationVersion(version);
    return version;
  }

  await roadToGoalRepo.lockCalibrationPublisher(tx);
  version = await roadToGoalRepo.getCalibrationVersionForDay(tx, publicationDay);
  if (version) {
    assertCalibrationVersion(version);
    return version;
  }

  const config = ROAD_TO_GOAL_CALIBRATION_CONFIG;
  version = await roadToGoalRepo.insertCalibrationVersion(tx, {
    publicationDay,
    ...config,
    config: {
      version: 2,
      multiplier_ladder_bp: ROAD_TO_GOAL_MULTIPLIERS_BP,
      zone_accuracy_priors_bp: ROAD_TO_GOAL_ZONE_ACCURACY_PRIORS_BP,
      conditional_accuracy: 'question_and_reached_zone',
      timeout_treatment: 'gameplay_incorrect_editorial_separate',
      road_prior_strength: 20,
    },
  });
  const questionCount = await roadToGoalRepo.insertQuestionCalibrations(tx, version);
  if (options.logPublication !== false) {
    logger.info(
      { calibrationVersionId: version.id, publicationDay, questionCount },
      'road-to-goal daily calibration published'
    );
  }
  return version;
}

export async function publishRoadToGoalDailyCalibration(
  now = new Date()
): Promise<RoadToGoalCalibrationVersionRow> {
  return sql.begin((tx) => ensureRoadToGoalDailyCalibration(tx, now));
}
