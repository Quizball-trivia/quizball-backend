import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '../setup.js';

const serviceMocks = vi.hoisted(() => ({
  sweepStaleRounds: vi.fn().mockResolvedValue({ settled: 0 }),
  publishDailyCalibration: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/core/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../src/modules/road-to-goal/road-to-goal.service.js', () => ({
  roadToGoalService: serviceMocks,
}));

import { config } from '../../src/core/config.js';
import {
  startRoadToGoalSweeper,
  stopRoadToGoalSweeper,
} from '../../src/modules/road-to-goal/road-to-goal.sweeper.js';

const mutableConfig = config as unknown as { ROAD_TO_GOAL_ENABLED: boolean };

describe('Road to Goal sweeper flag gating', () => {
  const originalEnabled = mutableConfig.ROAD_TO_GOAL_ENABLED;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await stopRoadToGoalSweeper();
    mutableConfig.ROAD_TO_GOAL_ENABLED = originalEnabled;
    vi.useRealTimers();
  });

  it('keeps stale paid-run settlement active while the feature is disabled', async () => {
    mutableConfig.ROAD_TO_GOAL_ENABLED = false;
    const setIntervalSpy = vi.spyOn(global, 'setInterval');

    startRoadToGoalSweeper();
    await vi.advanceTimersByTimeAsync(15_000);

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(serviceMocks.sweepStaleRounds).toHaveBeenCalledTimes(1);
    expect(serviceMocks.publishDailyCalibration).not.toHaveBeenCalled();
  });

  it('publishes and schedules calibration only while the feature is enabled', async () => {
    mutableConfig.ROAD_TO_GOAL_ENABLED = true;
    const setIntervalSpy = vi.spyOn(global, 'setInterval');

    startRoadToGoalSweeper();
    await Promise.resolve();

    expect(setIntervalSpy).toHaveBeenCalledTimes(2);
    expect(serviceMocks.publishDailyCalibration).toHaveBeenCalledTimes(1);
  });
});
