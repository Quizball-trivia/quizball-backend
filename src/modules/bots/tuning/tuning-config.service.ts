/**
 * Resolves the LIVE governor/model config: code constants overlaid with the
 * operator overrides from bot_tuning_overrides, cached in Redis so a CMS change
 * propagates across replicas without a redeploy.
 *
 * WHY A RESOLVER RATHER THAN CONFIG-AWARE CALLERS
 * stepGovernor stays PURE and IO-free (see governor-state-machine.ts): it takes
 * a GovernorConfig argument and never reaches for one. This module is the only
 * place that talks to the DB/cache, and the service layer resolves ONCE per
 * settlement and passes the result down. That keeps the state machine
 * deterministic and testable against arbitrary config, and keeps the blast
 * radius of a cache failure to "this settlement used the frozen defaults".
 *
 * FAILURE POLICY: a read failure resolves to the frozen code constants. The
 * defaults are the values PR9 shipped and soaked, so falling back to them is
 * always safe — it can only ever forget an operator's TIGHTENING, never invent
 * a loosening. Never let a tuning lookup break a match.
 */

import { logger } from '../../../core/logger.js';
import { getOrLoadJson, deleteJsonCacheKeys } from '../../../core/json-cache.js';
import {
  GOVERNOR_STEP,
  TOP_PROTECTION_STEP,
  TOP_PROTECTION_MARGIN_RP,
  TOP_PROTECTION_CRITICAL_RP,
  TOP_BAND_TARGET_WINRATE,
  MID_LADDER_TARGET_WINRATE,
  type GovernorConfig,
} from '../governor/governor-state-machine.js';
import { S1_CEILING_MARGIN } from '../calibration/hard-clamps.js';
import { MAX_DAILY_CAP } from './tuning.schemas.js';
import { tuningRepo, type BotTuningOverrides } from './tuning.repo.js';

/**
 * 30s. Short enough that an operator sees a change take effect within a match
 * or two (the pin is snapshotted at match creation, so nothing can apply
 * mid-match anyway), long enough that a settlement burst does not hammer the
 * singleton row.
 */
const TUNING_CACHE_KEY = 'bots:tuning:overrides:v1';
const TUNING_CACHE_TTL_SECONDS = 30;

/** The frozen code-constant defaults — what every NULL override falls back to. */
export const DEFAULT_GOVERNOR_CONFIG: GovernorConfig = {
  governorStep: GOVERNOR_STEP,
  topProtectionStep: TOP_PROTECTION_STEP,
  topProtectionMarginRp: TOP_PROTECTION_MARGIN_RP,
  topProtectionCriticalRp: TOP_PROTECTION_CRITICAL_RP,
  topBandTargetWinrate: TOP_BAND_TARGET_WINRATE,
  midLadderTargetWinrate: MID_LADDER_TARGET_WINRATE,
};

/** Everything the live-tuning layer resolves, including the provenance version. */
export interface ResolvedBotTuning {
  /** The overrides version in force; stamped into the per-match pin. */
  version: number;
  governor: GovernorConfig;
  /** Ceiling margin below the frozen S1 top-cohort accuracy. */
  ceilingMargin: number;
  /** Multiplier applied to each bot's daily_cap at selection time. */
  activityScale: number;
  /** Roster-wide ceiling on any single bot's effective daily cap. */
  maxDailyCap: number;
}

export const DEFAULT_RESOLVED_TUNING: ResolvedBotTuning = {
  version: 0,
  governor: DEFAULT_GOVERNOR_CONFIG,
  ceilingMargin: S1_CEILING_MARGIN,
  activityScale: 1,
  maxDailyCap: MAX_DAILY_CAP,
};

/** Overlay: a non-null override wins, a null falls back to the code constant. */
export function resolveTuning(overrides: BotTuningOverrides): ResolvedBotTuning {
  const pick = (value: number | null, fallback: number): number =>
    value == null || !Number.isFinite(value) ? fallback : value;
  return {
    version: overrides.version,
    governor: {
      governorStep: pick(overrides.governorStep, GOVERNOR_STEP),
      topProtectionStep: pick(overrides.topProtectionStep, TOP_PROTECTION_STEP),
      topProtectionMarginRp: pick(overrides.topProtectionMarginRp, TOP_PROTECTION_MARGIN_RP),
      topProtectionCriticalRp: pick(overrides.topProtectionCriticalRp, TOP_PROTECTION_CRITICAL_RP),
      topBandTargetWinrate: pick(overrides.topBandTargetWinrate, TOP_BAND_TARGET_WINRATE),
      midLadderTargetWinrate: pick(overrides.midLadderTargetWinrate, MID_LADDER_TARGET_WINRATE),
    },
    ceilingMargin: pick(overrides.ceilingMargin, S1_CEILING_MARGIN),
    activityScale: pick(overrides.activityScale, 1),
    maxDailyCap: pick(overrides.maxDailyCap, MAX_DAILY_CAP),
  };
}

/**
 * The live resolved config, Redis-cached cross-replica. Falls back to the frozen
 * defaults on any failure (see FAILURE POLICY above).
 */
export async function loadBotTuning(): Promise<ResolvedBotTuning> {
  try {
    const overrides = await getOrLoadJson<BotTuningOverrides>(
      TUNING_CACHE_KEY,
      TUNING_CACHE_TTL_SECONDS,
      () => tuningRepo.getOverrides(),
    );
    return resolveTuning(overrides);
  } catch (error) {
    logger.warn({ error }, 'Bot tuning lookup failed; using frozen code defaults');
    return DEFAULT_RESOLVED_TUNING;
  }
}

/**
 * Drop the cached overrides so the next read sees a fresh write. Called by the
 * PUT handler; the 30s TTL is the backstop if this invalidation is ever missed
 * (or lands on a replica whose Redis is down).
 */
export async function invalidateBotTuningCache(): Promise<void> {
  await deleteJsonCacheKeys([TUNING_CACHE_KEY]);
}

export const tuningConfigService = {
  load: loadBotTuning,
  invalidate: invalidateBotTuningCache,
  resolve: resolveTuning,
  DEFAULT_RESOLVED_TUNING,
};
