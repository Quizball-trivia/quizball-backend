/**
 * Internal live-tuning endpoints for the persistent-bot roster (PR10).
 *
 * Auth reuses PR9's ops shared-secret guard (x-ops-report-token) — same scheme
 * as the governor telemetry endpoint, fails closed when OPS_REPORT_TOKEN is
 * unset. These are operator surfaces consumed by the CMS, not user-facing.
 *
 * The WRITE endpoints here can change live bot difficulty, so every one of them
 * is rail-checked in tuning.schemas.ts AND by CHECK constraints in the
 * migration. Neither layer can loosen the immutable clamps in hard-clamps.ts:
 * those are applied at match time, strictly after any override resolved here.
 */

import { timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { config } from '../../../core/config.js';
import { AuthenticationError, InternalError, NotFoundError } from '../../../core/errors.js';
import { logger } from '../../../core/logger.js';
import { tuningRepo, type OverrideField } from './tuning.repo.js';
import { loadBotTuning, invalidateBotTuningCache } from './tuning-config.service.js';
import {
  MAX_TARGET_WINRATE,
  MAX_GOVERNOR_STEP,
  MAX_TOP_PROTECTION_STEP,
  MAX_DAILY_CAP,
  MIN_CEILING_MARGIN,
  MAX_CEILING_MARGIN,
  ceilingAccuracyForMargin,
  type UpdateBotTuningBody,
  type RosterOverviewQuery,
  type FreezeBotBody,
  type BotUserIdParams,
  type ZeroOffsetsBody,
} from './tuning.schemas.js';
import { HARD_PROB_CAP, HARD_SKILL_CAP, HARD_MIN_ANSWER_TIME_MS } from '../calibration/hard-clamps.js';

const OPS_TOKEN_HEADER = 'x-ops-report-token';

function secretsMatch(expected: string, actual: string | undefined): boolean {
  if (actual === undefined) return false;
  const expectedBuf = Buffer.from(expected, 'utf8');
  const actualBuf = Buffer.from(actual, 'utf8');
  // timingSafeEqual throws on unequal lengths; an unequal length is itself a
  // mismatch, so guard before comparing rather than leaking via the throw.
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

function getHeaderValue(value: string | string[] | undefined): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value[0];
  return undefined;
}

export function assertOpsAuthorized(req: Request): void {
  if (!config.OPS_REPORT_TOKEN) {
    throw new InternalError('Bot tuning endpoints are not configured (OPS_REPORT_TOKEN unset)');
  }
  const provided = getHeaderValue(req.headers[OPS_TOKEN_HEADER]);
  if (!secretsMatch(config.OPS_REPORT_TOKEN, provided)) {
    throw new AuthenticationError('Invalid ops token');
  }
}

/**
 * The rails, echoed to the CMS so the UI can render bounds/validation without
 * duplicating the numbers. Derived from the same constants the schema enforces,
 * so the UI can never drift from the server's actual limits.
 */
function railsPayload() {
  return {
    ceilingMargin: {
      min: MIN_CEILING_MARGIN,
      max: MAX_CEILING_MARGIN,
      note: 'May only TIGHTEN: a smaller margin would raise the bot ceiling above the frozen hard cap.',
    },
    targetWinrate: { max: MAX_TARGET_WINRATE },
    governorStep: { max: MAX_GOVERNOR_STEP },
    topProtectionStep: { max: MAX_TOP_PROTECTION_STEP },
    dailyCap: { max: MAX_DAILY_CAP },
    immutable: {
      hardProbCap: HARD_PROB_CAP,
      hardSkillCap: HARD_SKILL_CAP,
      hardMinAnswerTimeMs: HARD_MIN_ANSWER_TIME_MS,
      note: 'Code constants. No CMS value can loosen these; they are applied after every override.',
    },
  };
}

/** Body keys that map onto override columns (updatedBy is metadata, not a knob). */
const OVERRIDE_FIELDS: OverrideField[] = [
  'ceilingMargin',
  'topBandTargetWinrate',
  'midLadderTargetWinrate',
  'governorStep',
  'topProtectionStep',
  'topProtectionMarginRp',
  'topProtectionCriticalRp',
  'activityScale',
  'maxDailyCap',
];

export const tuningController = {
  /** GET /api/v1/internal/bots/tuning — current effective params + rails. */
  async getTuning(req: Request, res: Response): Promise<void> {
    assertOpsAuthorized(req);
    const [overrides, resolved] = await Promise.all([
      tuningRepo.getOverrides(),
      loadBotTuning(),
    ]);
    res.json({
      // What is actually in force right now (code constants + overrides).
      effective: {
        ...resolved,
        ceilingAccuracy: ceilingAccuracyForMargin(resolved.ceilingMargin),
      },
      // The raw override row: null = "not overridden, using the code constant".
      overrides,
      rails: railsPayload(),
    });
  },

  /**
   * PUT /api/v1/internal/bots/tuning — partial update of the override singleton.
   *
   * Omitted key = leave untouched; explicit null = reset to the code constant.
   * The cache is invalidated after the write so the change propagates to every
   * replica without a redeploy (the 30s TTL is the backstop).
   */
  async updateTuning(req: Request, res: Response): Promise<void> {
    assertOpsAuthorized(req);
    const body = req.validated.body as UpdateBotTuningBody;

    const fields: Partial<Record<OverrideField, number | null>> = {};
    for (const field of OVERRIDE_FIELDS) {
      if (field in body) fields[field] = body[field] ?? null;
    }

    const updated = await tuningRepo.updateOverrides(fields, body.updatedBy ?? null);
    await invalidateBotTuningCache();

    logger.info(
      { fields, updatedBy: body.updatedBy ?? null, version: updated.version },
      'Bot tuning overrides updated',
    );

    const resolved = await loadBotTuning();
    res.json({
      effective: {
        ...resolved,
        ceilingAccuracy: ceilingAccuracyForMargin(resolved.ceilingMargin),
      },
      overrides: updated,
      rails: railsPayload(),
    });
  },

  /** GET /api/v1/internal/bots/tuning/roster — paginated roster overview. */
  async getRoster(req: Request, res: Response): Promise<void> {
    assertOpsAuthorized(req);
    const query = req.validated.query as RosterOverviewQuery;
    res.json(await tuningRepo.getRosterOverview(query));
  },

  /** POST /api/v1/internal/bots/tuning/roster/:botUserId/freeze */
  async setFreeze(req: Request, res: Response): Promise<void> {
    assertOpsAuthorized(req);
    const { botUserId } = req.validated.params as BotUserIdParams;
    const { frozen, reason } = req.validated.body as FreezeBotBody;

    const updated = await tuningRepo.setSelectionFrozen(botUserId, frozen);
    if (!updated) throw new NotFoundError('No synthetic player profile for that user id');

    logger.info({ botUserId, frozen, reason: reason ?? null }, 'Bot selection freeze changed');
    res.json(updated);
  },

  /**
   * POST /api/v1/internal/bots/tuning/governor/zero-offsets — EMERGENCY.
   *
   * Clears every live governor offset. Deliberately leaves the EMA history
   * intact so the loop resumes from a warm estimate; see the repo method.
   */
  async zeroOffsets(req: Request, res: Response): Promise<void> {
    assertOpsAuthorized(req);
    const { reason } = req.validated.body as ZeroOffsetsBody;
    const cleared = await tuningRepo.zeroGovernorOffsets();
    logger.warn({ cleared, reason: reason ?? null }, 'EMERGENCY: governor offsets zeroed roster-wide');
    res.json({ cleared });
  },
};
