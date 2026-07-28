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
import type { PersistentBotModelPin } from '../lobbies/lobbies.types.js';
import { botModelParamsRepo } from './bot-model-params.repo.js';
import { syntheticProfileRepo } from './synthetic-profile.repo.js';
import { questionStatsRepo } from './question-stats.repo.js';
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
  const [active, skill, accuracies] = await Promise.all([
    botModelParamsRepo.getActive(),
    syntheticProfileRepo.getSkillInputs(botUserId),
    questionStatsRepo.getAllSmoothedAccuracies().catch(() => [] as number[]),
  ]);
  if (!active || !skill) {
    logger.info(
      { botUserId, hasParams: !!active, hasProfile: !!skill },
      'Persistent-bot calibrated model unavailable; falling back to bridge',
    );
    return null;
  }

  const thetaCeilingBound = solveCeilingBound(active.params, accuracies);

  return {
    paramsVersion: active.version,
    params: active.params,
    botUserId,
    currentRp,
    personalOffset: skill.baseSkill,
    governorAdjustment: skill.governorAdjustment,
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
