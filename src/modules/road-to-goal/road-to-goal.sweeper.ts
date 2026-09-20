import { logger } from '../../core/logger.js';
import { config } from '../../core/config.js';
import { roadToGoalService } from './road-to-goal.service.js';

const SWEEP_INTERVAL_MS = 15_000;
const CALIBRATION_INTERVAL_MS = 60 * 60_000;

let timer: NodeJS.Timeout | null = null;
let calibrationTimer: NodeJS.Timeout | null = null;
let inFlight = false;
let calibrationInFlight = false;

/** Runs even while new rounds are disabled so an existing coin liability is
 * always either auto-cashed at a decision point or lost on question timeout. */
export function startRoadToGoalSweeper(): void {
  if (timer) return;
  timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void roadToGoalService
      .sweepStaleRounds()
      .then(({ settled }) => {
        if (settled > 0) logger.info({ settled }, 'road-to-goal sweeper settled stale rounds');
      })
      .catch((error) => logger.error({ error }, 'road-to-goal sweeper tick failed'))
      .finally(() => {
        inFlight = false;
      });
  }, SWEEP_INTERVAL_MS);
  timer.unref?.();

  const publishCalibration = () => {
    if (calibrationInFlight) return;
    calibrationInFlight = true;
    void roadToGoalService
      .publishDailyCalibration()
      .catch((error) => logger.error({ error }, 'road-to-goal calibration publish failed'))
      .finally(() => {
        calibrationInFlight = false;
      });
  };
  if (config.ROAD_TO_GOAL_ENABLED) {
    publishCalibration();
    calibrationTimer = setInterval(publishCalibration, CALIBRATION_INTERVAL_MS);
    calibrationTimer.unref?.();
  }
}

export async function stopRoadToGoalSweeper(): Promise<void> {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (calibrationTimer) {
    clearInterval(calibrationTimer);
    calibrationTimer = null;
  }
  const deadline = Date.now() + 5_000;
  while (inFlight && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  while (calibrationInFlight && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
