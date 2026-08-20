import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { TransactionSql } from '../../src/db/index.js';

const loggerMocks = vi.hoisted(() => ({ info: vi.fn() }));
const repoMocks = vi.hoisted(() => ({
  getDatabasePublicationDay: vi.fn(),
  getCalibrationVersionForDay: vi.fn(),
  lockCalibrationPublisher: vi.fn(),
  insertCalibrationVersion: vi.fn(),
  insertQuestionCalibrations: vi.fn(),
}));

vi.mock('../../src/core/logger.js', () => ({ logger: loggerMocks }));
vi.mock('../../src/modules/road-to-goal/road-to-goal.repo.js', () => ({
  roadToGoalRepo: repoMocks,
}));

import { ensureRoadToGoalDailyCalibration } from '../../src/modules/road-to-goal/road-to-goal.calibration.js';

const tx = {} as TransactionSql;
const version = {
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

describe('Road to Goal calibration publication logging', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (repoMocks.getDatabasePublicationDay as Mock).mockResolvedValue('2026-08-20');
    (repoMocks.getCalibrationVersionForDay as Mock)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    (repoMocks.lockCalibrationPublisher as Mock).mockResolvedValue(undefined);
    (repoMocks.insertCalibrationVersion as Mock).mockResolvedValue(version);
    (repoMocks.insertQuestionCalibrations as Mock).mockResolvedValue(26_690);
  });

  it('suppresses the published log for a benchmark transaction that will roll back', async () => {
    await ensureRoadToGoalDailyCalibration(tx, undefined, { logPublication: false });

    expect(loggerMocks.info).not.toHaveBeenCalled();
  });

  it('logs normal committed calibration publication by default', async () => {
    await ensureRoadToGoalDailyCalibration(tx);

    expect(loggerMocks.info).toHaveBeenCalledWith(
      expect.objectContaining({
        calibrationVersionId: version.id,
        publicationDay: version.publication_day,
        questionCount: 26_690,
      }),
      'road-to-goal daily calibration published'
    );
  });
});
