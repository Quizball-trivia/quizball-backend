/**
 * Builds the persistent-bot calibrated-model pin for ranked_context at match
 * creation (PR8). Replaces PR7's temporary difficulty bridge
 * (buildPersistentBotMatchContext -> correctnessFromAnchor ≤0.75) with a
 * snapshot of the active model params + the bot's frozen skill inputs.
 *
 * Returns null when the calibration is unavailable (no active bot_model_params,
 * or the bot has no synthetic profile) so the caller can fall back to the bridge
 * and matchmaking never fails on a missing artifact.
 */

import { logger } from '../../core/logger.js';
import { config } from '../../core/config.js';
import type { PersistentBotModelPin } from '../lobbies/lobbies.types.js';
import { botModelParamsRepo } from './bot-model-params.repo.js';
import { syntheticProfileRepo } from './synthetic-profile.repo.js';
import { questionStatsRepo } from './question-stats.repo.js';
import { loadBotTuning } from './tuning/tuning-config.service.js';
import { ceilingAccuracyForMargin } from './tuning/tuning.schemas.js';
import { logit } from './calibration/math.js';
import { effectiveProbCap, solveThetaCeilingBound } from '../../realtime/persistent-bot-gameplay.js';
import type { BotModelParams } from './calibration/params-schema.js';

// Asia/Tbilisi is a fixed UTC+4 (no DST) — mirrors store.service's convention.
const GEORGIA_UTC_OFFSET_MS = 4 * 60 * 60 * 1000;

/** The current Georgia calendar day as YYYY-MM-DD, for the daily-form seed. */
export function georgiaDaySeed(now: Date = new Date()): string {
  const shifted = new Date(now.getTime() + GEORGIA_UTC_OFFSET_MS);
  return shifted.toISOString().slice(0, 10);
}

/**
 * Assemble the model pin. `currentRp` is the bot's real ranked RP (the caller
 * already loads the bot's profile for the ranked branch).
 */
export async function buildPersistentBotModelPin(
  botUserId: string,
  currentRp: number,
  now: Date = new Date(),
): Promise<PersistentBotModelPin | null> {
  const [active, skill, accuracies, tuning] = await Promise.all([
    botModelParamsRepo.getActive(),
    syntheticProfileRepo.getSkillInputs(botUserId),
    questionStatsRepo.getAllSmoothedAccuracies().catch(() => [] as number[]),
    loadBotTuning(),
  ]);
  if (!active || !skill) {
    logger.info(
      { botUserId, hasParams: !!active, hasProfile: !!skill },
      'Persistent-bot calibrated model unavailable; falling back to bridge',
    );
    return null;
  }

  // Apply the operator ceiling margin (PR10). The margin is the gap BELOW the
  // frozen S1 top-cohort accuracy, so a larger margin lowers the ceiling. The
  // rails only accept a margin at or above the frozen one, and Math.min below
  // makes that structural: the effective ceiling can only ever be TIGHTER than
  // the calibrated one, never looser, whatever is stored.
  //
  // Without this the knob was accepted and echoed as "effective" while gameplay
  // silently stayed at the frozen ceiling — a tightening the operator believed
  // was live but was not.
  const tunedCeilingAccuracy = Math.min(
    active.params.ceiling.ceilingAccuracy,
    ceilingAccuracyForMargin(tuning.ceilingMargin),
  );
  const tunedParams: BotModelParams = {
    ...active.params,
    ceiling: { ...active.params.ceiling, ceilingAccuracy: tunedCeilingAccuracy },
    clamps: {
      ...active.params.clamps,
      finalProbCap: Math.min(active.params.clamps.finalProbCap, tunedCeilingAccuracy),
    },
  };

  const thetaCeilingBound = solveCeilingBound(tunedParams, accuracies);

  // Kill switch (PR9): with the governor OFF the pin carries a ZERO offset, so
  // bots immediately fall back to base calibrated skill. Zeroing here rather
  // than relying on the settlement-time write matters — a stored offset would
  // otherwise keep being applied to every match of a bot that has not settled
  // since the switch was flipped, which is not a kill switch.
  const governorAdjustment = config.BOT_GOVERNOR_ENABLED ? skill.governorAdjustment : 0;

  return {
    paramsVersion: active.version,
    tuningVersion: tuning.version,
    // The TUNED params are pinned, so the whole match runs on the ceiling that
    // was in force at creation even if an operator changes it mid-match.
    params: tunedParams,
    botUserId,
    currentRp,
    personalOffset: skill.baseSkill,
    governorAdjustment,
    categoryAffinities: skill.categoryAffinities,
    dailyFormSeed: georgiaDaySeed(now),
    thetaCeilingBound,
  };
}

/**
 * Solve the ceiling-derived theta bound over the frozen difficulty distribution:
 * map each question's human smoothed_accuracy to beta via the link, then find the
 * max theta whose expected aggregate stays at/under the ceiling. Pinned so the
 * whole match uses ONE bound (immune to a mid-match stats refresh). An empty
 * accuracy list (fresh DB) yields the conservative frozen fallback inside
 * solveThetaCeilingBound.
 */
export function solveCeilingBound(params: BotModelParams, accuracies: readonly number[]): number {
  const { intercept, slope } = params.difficultyLink;
  const betas = accuracies.map((acc) => intercept + slope * logit(acc));
  return solveThetaCeilingBound(betas, params.ceiling.ceilingAccuracy, effectiveProbCap(params));
}
