export const FOOTBALL_GRID_BOT_GOVERNOR_EMA_ALPHA = 0.10;
export const FOOTBALL_GRID_BOT_GOVERNOR_MIN_OBSERVATIONS = 20;
export const FOOTBALL_GRID_BOT_GOVERNOR_COOLDOWN_OBSERVATIONS = 10;
export const FOOTBALL_GRID_BOT_GOVERNOR_COOLDOWN_MS = 60 * 60 * 1_000;
export const FOOTBALL_GRID_BOT_GOVERNOR_STEP = 0.025;
export const FOOTBALL_GRID_BOT_GOVERNOR_MIN_ADJUSTMENT = -0.20;
export const FOOTBALL_GRID_BOT_GOVERNOR_MAX_ADJUSTMENT = 0;
export const FOOTBALL_GRID_BOT_GOVERNOR_LOWER_SCORE = 0.375;
export const FOOTBALL_GRID_BOT_GOVERNOR_UPPER_SCORE = 0.475;

export interface FootballGridBotGovernorState {
  strengthAdjustment: number;
  scoreEma: number | null;
  observationCount: number;
  observationsAtAdjustment: number;
  adjustmentUpdatedAt: Date | null;
}

export type FootballGridBotGovernorTrigger =
  | 'none'
  | 'high_score_nerf'
  | 'low_score_restore'
  | 'disabled_reset';

export interface FootballGridBotGovernorDecision {
  next: FootballGridBotGovernorState;
  trigger: FootballGridBotGovernorTrigger;
  adjustmentChanged: boolean;
}

function quantize(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export function clampFootballGridBotStrengthAdjustment(value: number): number {
  if (!Number.isFinite(value)) throw new Error('Invalid Football Grid bot strength adjustment');
  return quantize(Math.min(
    FOOTBALL_GRID_BOT_GOVERNOR_MAX_ADJUSTMENT,
    Math.max(FOOTBALL_GRID_BOT_GOVERNOR_MIN_ADJUSTMENT, value),
  ));
}

export function parseFootballGridBotStrengthAdjustment(
  value: string | number | null,
  options: { required: boolean },
): number {
  if (value === null) {
    if (options.required) throw new Error('Football Grid v2 bot runtime is missing its pinned strength adjustment');
    return 0;
  }
  const parsed = Number(value);
  if (
    !Number.isFinite(parsed)
    || parsed < FOOTBALL_GRID_BOT_GOVERNOR_MIN_ADJUSTMENT
    || parsed > FOOTBALL_GRID_BOT_GOVERNOR_MAX_ADJUSTMENT
  ) {
    throw new Error('Football Grid bot runtime has an invalid strength adjustment');
  }
  return quantize(parsed);
}

export function updateFootballGridBotScoreEma(
  previous: number | null,
  outcomeScore: 0 | 0.5 | 1,
): number {
  if (previous === null) return outcomeScore;
  return quantize(previous + FOOTBALL_GRID_BOT_GOVERNOR_EMA_ALPHA * (outcomeScore - previous));
}

/**
 * Fold observation N first, then evaluate it. Sample 20 is the first eligible
 * adjustment; after an adjustment at 20, sample 30 is the next match-count
 * boundary (and it must also be at least one hour later).
 */
export function stepFootballGridBotGovernor(
  previous: FootballGridBotGovernorState,
  input: { outcomeScore: 0 | 0.5 | 1; now: Date; enabled: boolean },
): FootballGridBotGovernorDecision {
  if (
    !Number.isFinite(input.now.getTime())
    || (previous.adjustmentUpdatedAt !== null
      && !Number.isFinite(previous.adjustmentUpdatedAt.getTime()))
  ) {
    throw new Error('Invalid Football Grid governor timestamp');
  }
  const scoreEma = updateFootballGridBotScoreEma(previous.scoreEma, input.outcomeScore);
  const observationCount = previous.observationCount + 1;
  const folded: FootballGridBotGovernorState = {
    ...previous,
    scoreEma,
    observationCount,
  };

  if (!input.enabled) {
    if (previous.strengthAdjustment === 0) {
      return { next: folded, trigger: 'none', adjustmentChanged: false };
    }
    return {
      next: {
        ...folded,
        strengthAdjustment: 0,
        observationsAtAdjustment: observationCount,
        adjustmentUpdatedAt: input.now,
      },
      trigger: 'disabled_reset',
      adjustmentChanged: true,
    };
  }

  const enoughObservations = observationCount >= FOOTBALL_GRID_BOT_GOVERNOR_MIN_OBSERVATIONS;
  const enoughSinceAdjustment = observationCount - previous.observationsAtAdjustment
    >= FOOTBALL_GRID_BOT_GOVERNOR_COOLDOWN_OBSERVATIONS;
  const wallClockReady = previous.adjustmentUpdatedAt === null
    || input.now.getTime() - previous.adjustmentUpdatedAt.getTime()
      >= FOOTBALL_GRID_BOT_GOVERNOR_COOLDOWN_MS;
  if (!enoughObservations || !enoughSinceAdjustment || !wallClockReady) {
    return { next: folded, trigger: 'none', adjustmentChanged: false };
  }

  let strengthAdjustment = previous.strengthAdjustment;
  let trigger: FootballGridBotGovernorTrigger = 'none';
  if (scoreEma > FOOTBALL_GRID_BOT_GOVERNOR_UPPER_SCORE) {
    strengthAdjustment = clampFootballGridBotStrengthAdjustment(
      previous.strengthAdjustment - FOOTBALL_GRID_BOT_GOVERNOR_STEP,
    );
    if (strengthAdjustment !== previous.strengthAdjustment) trigger = 'high_score_nerf';
  } else if (scoreEma < FOOTBALL_GRID_BOT_GOVERNOR_LOWER_SCORE) {
    strengthAdjustment = clampFootballGridBotStrengthAdjustment(
      previous.strengthAdjustment + FOOTBALL_GRID_BOT_GOVERNOR_STEP,
    );
    if (strengthAdjustment !== previous.strengthAdjustment) trigger = 'low_score_restore';
  }
  if (trigger === 'none') return { next: folded, trigger, adjustmentChanged: false };
  return {
    next: {
      ...folded,
      strengthAdjustment,
      observationsAtAdjustment: observationCount,
      adjustmentUpdatedAt: input.now,
    },
    trigger,
    adjustmentChanged: true,
  };
}
