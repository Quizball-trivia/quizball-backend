/**
 * The governor's write path (PR9): one settled ranked match in, one updated
 * per-bot governor state out.
 *
 * Called from ranked settlement (see rankedService.settleCompletedRankedMatch)
 * for each FRESHLY settled persistent bot whose opponent was a HUMAN. The
 * decision itself is the pure state machine in governor-state-machine.ts; this
 * module only supplies the world (top-10 human RP, kill switch) and persists.
 *
 * FAILURE POLICY: every entry point swallows its own errors. The governor is a
 * slow feedback loop on bot difficulty — a failed adjustment costs one sample,
 * whereas letting the exception escape would fail the whole settlement (and
 * strand the bot's reservation, since the release is gated on settlement
 * completing). Never let telemetry break the match.
 */

import { logger } from '../../../core/logger.js';
import { config } from '../../../core/config.js';
import { getOrLoadJson } from '../../../core/json-cache.js';
import { governorRepo } from './governor.repo.js';
import { stepGovernor, type GovernorDecision } from './governor-state-machine.js';

/**
 * Cache key + TTL for the human top-10 RP snapshot. §1.5 requires a PERIODIC
 * BATCH snapshot rather than the 300s per-user rank cache (which only
 * invalidates the settled user and would leave every other bot reading stale
 * data). 60s is short enough that a climbing bot is caught within a match or
 * two, and long enough that a settlement burst does not hammer the query.
 */
const HUMAN_TOP10_CACHE_KEY = 'bots:governor:human-top10-rp:v1';
const HUMAN_TOP10_CACHE_TTL_SECONDS = 60;

/** Kill switch (§1.10). OFF ⇒ every offset is driven to 0 on next settlement. */
export function governorEnabled(): boolean {
  return config.BOT_GOVERNOR_ENABLED === true;
}

/**
 * The #10 human's RP, cached cross-replica. A failure resolves to null, which
 * DISABLES top-protection for that settlement rather than acting on a guess —
 * the safe direction, since a wrong non-null value could either nerf a
 * mid-ladder bot or (worse) fail to nerf a climbing one.
 */
export async function loadHumanTop10Rp(): Promise<number | null> {
  try {
    return await getOrLoadJson<number | null>(
      HUMAN_TOP10_CACHE_KEY,
      HUMAN_TOP10_CACHE_TTL_SECONDS,
      () => governorRepo.getHumanTop10Rp(),
    );
  } catch (error) {
    logger.warn({ error }, 'Governor: human top-10 RP lookup failed; top-protection disabled for this settlement');
    return null;
  }
}

export interface GovernorSettlementInput {
  botUserId: string;
  /** The bot's RP AFTER settlement (settlement.newRp). */
  botRp: number;
  /** Did the bot win this match? */
  won: boolean;
  matchId: string;
  now?: Date;
}

/**
 * Advance one bot's governor after a settled match against a human. Returns the
 * decision when one was applied, else null (no profile, write lost a race, or
 * the call failed — all non-fatal).
 */
export async function recordSettledMatch(
  input: GovernorSettlementInput,
): Promise<GovernorDecision | null> {
  try {
    const state = await governorRepo.getState(input.botUserId);
    if (!state) {
      // A persistent bot without a roster profile: nothing to govern. Expected
      // for a hand-made test bot; never for a generated roster bot.
      logger.debug({ botUserId: input.botUserId }, 'Governor: no synthetic profile; skipping');
      return null;
    }

    const humanTop10Rp = await loadHumanTop10Rp();
    const decision = stepGovernor(state, {
      botRp: input.botRp,
      humanTop10Rp,
      won: input.won,
      now: input.now ?? new Date(),
      enabled: governorEnabled(),
    });

    const saved = await governorRepo.saveState(input.botUserId, decision.next, state.winrateSamples);
    if (!saved) {
      logger.info(
        { botUserId: input.botUserId, matchId: input.matchId },
        'Governor: state write lost a concurrent race; sample dropped',
      );
      return null;
    }

    if (decision.trigger !== 'none') {
      logger.info({
        botUserId: input.botUserId,
        matchId: input.matchId,
        trigger: decision.trigger,
        botRp: input.botRp,
        humanTop10Rp,
        previousAdjustment: state.adjustment,
        adjustment: decision.next.adjustment,
        winrateEma: decision.next.winrateEma,
        winrateSamples: decision.next.winrateSamples,
      }, 'Governor: bot adjustment changed');
    }
    return decision;
  } catch (error) {
    // Never propagate: settlement (and the reservation release gated on it)
    // must not fail because a difficulty nudge did.
    logger.error({ error, botUserId: input.botUserId, matchId: input.matchId }, 'Governor: update failed');
    return null;
  }
}

export interface GovernorTelemetry {
  enabled: boolean;
  offsets: Awaited<ReturnType<typeof governorRepo.getOffsetSummary>>;
  humanTop10Rp: number | null;
  daily: Awaited<ReturnType<typeof governorRepo.getDailyWinrates>>;
}

/** The aggregate behind the internal telemetry endpoint (§1.10). */
export async function getGovernorTelemetry(days: number): Promise<GovernorTelemetry> {
  const [offsets, daily, humanTop10Rp] = await Promise.all([
    governorRepo.getOffsetSummary(),
    governorRepo.getDailyWinrates(days),
    loadHumanTop10Rp(),
  ]);
  return { enabled: governorEnabled(), offsets, humanTop10Rp, daily };
}

export const governorService = {
  isEnabled: governorEnabled,
  recordSettledMatch,
  getTelemetry: getGovernorTelemetry,
  loadHumanTop10Rp,
};
