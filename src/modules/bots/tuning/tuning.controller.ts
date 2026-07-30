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

import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { config } from '../../../core/config.js';
import { sql } from '../../../db/index.js';
import {
  AuthenticationError,
  BadRequestError,
  ConflictError,
  InternalError,
  NotFoundError,
} from '../../../core/errors.js';
import { logger } from '../../../core/logger.js';
import { usersRepo } from '../../users/users.repo.js';
import { assertNicknameAllowed } from '../../users/users.service.js';
import { rankedRepo } from '../../ranked/ranked.repo.js';
import { tierFromRp } from '../../ranked/season-rp-formula.js';
import { governorRepo } from '../governor/governor.repo.js';
import { tuningRepo, type OverrideField, type BotAdminEditEntry } from './tuning.repo.js';
import { resolveTuning, invalidateBotTuningCache } from './tuning-config.service.js';
import {
  MAX_TARGET_WINRATE,
  MAX_GOVERNOR_STEP,
  MAX_TOP_PROTECTION_STEP,
  MAX_DAILY_CAP,
  MIN_CEILING_MARGIN,
  MAX_CEILING_MARGIN,
  MIN_TOP_PROTECTION_STEP,
  MIN_TOP_PROTECTION_MARGIN_RP,
  MIN_TOP_PROTECTION_CRITICAL_RP,
  ceilingAccuracyForMargin,
  validateMergedRings,
  RP_CEILING_MARGIN_BELOW_HUMAN_TOP10,
  MIN_BASE_SKILL,
  MAX_BASE_SKILL,
  type UpdateBotTuningBody,
  type RosterOverviewQuery,
  type FreezeBotBody,
  type BotUserIdParams,
  type ZeroOffsetsBody,
  type PatchBotBody,
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
    // Directional: each knob is bounded in its SAFE direction relative to the
    // frozen constant, not by an absolute limit.
    targetWinrate: {
      max: MAX_TARGET_WINRATE,
      note: 'May only be LOWERED below the frozen targets (0.425 top band / 0.50 mid ladder).',
    },
    governorStep: {
      max: MAX_GOVERNOR_STEP,
      note: 'Symmetric (drives nerfs AND boosts), so it may only be REDUCED.',
    },
    topProtectionStep: {
      min: MIN_TOP_PROTECTION_STEP,
      max: MAX_TOP_PROTECTION_STEP,
      note: 'May only be INCREASED: a bigger step pushes a bot off the top faster.',
    },
    topProtectionRings: {
      minMarginRp: MIN_TOP_PROTECTION_MARGIN_RP,
      minCriticalRp: MIN_TOP_PROTECTION_CRITICAL_RP,
      note: 'May only WIDEN, and the critical ring must stay inside the warn ring.',
    },
    dailyCap: { max: MAX_DAILY_CAP },
    // Per-bot admin edit rails (PATCH roster/:botUserId).
    perBotEdit: {
      baseSkill: {
        min: MIN_BASE_SKILL,
        max: MAX_BASE_SKILL,
        note: 'Roster band range. Hard clamps still apply after this value at match time.',
      },
      rp: {
        marginBelowHumanTop10: RP_CEILING_MARGIN_BELOW_HUMAN_TOP10,
        note: 'An admin-set RP must stay this far below the live human #10. RP also affects play strength.',
      },
      dailyCap: { min: 0, max: MAX_DAILY_CAP },
      noteRequired: true,
    },
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
    // ONE read, resolved locally. Reading the row and the cache in parallel
    // could report overrides.version = N beside effective.version = N-1 (the
    // cache lagging a just-committed write), which reads as a UI bug and makes
    // the operator distrust the screen. The cache is a gameplay-path
    // optimization; the CMS always sees committed truth.
    const overrides = await tuningRepo.getOverrides();
    const resolved = resolveTuning(overrides);
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

    // A partial update can invert the protection rings against values already
    // stored, which the per-request schema check cannot see. Merge with current
    // state and re-validate before writing.
    const current = resolveTuning(await tuningRepo.getOverrides());
    const ringError = validateMergedRings(body, {
      topProtectionMarginRp: current.governor.topProtectionMarginRp,
      topProtectionCriticalRp: current.governor.topProtectionCriticalRp,
    });
    if (ringError) throw new BadRequestError(ringError);

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

    // Resolve from the row we just wrote rather than re-reading the cache: the
    // response must reflect the committed write, not a possibly-stale fill.
    const resolved = resolveTuning(updated);
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
   * PATCH /api/v1/internal/bots/tuning/roster/:botUserId — per-bot admin edit.
   *
   * Accepts any subset of nickname / rpSet|rpAdjust / baseSkill / dailyCap plus
   * a MANDATORY note. Three things make this different from the other writes:
   *
   *   1. RP CEILING RAIL. An admin-set RP may not land within
   *      RP_CEILING_MARGIN_BELOW_HUMAN_TOP10 of the live human #10. The governor
   *      pushes bots off the top over time, but it cannot un-display a bot that
   *      was parked at rank 1 the moment the operator hit save.
   *   2. RP IS ALSO A DIFFICULTY KNOB. Effective skill is
   *      f(currentRp) + base_skill + governor (persistent-bot-gameplay.ts), so
   *      an RP edit moves how strongly the bot plays, not just its ladder slot.
   *      Echoed in the response so the CMS can warn.
   *   3. NICKNAME REUSES THE HUMAN RULES. Same profanity + uniqueness +
   *      freed-name reservation checks as PUT /users/me, and the history row is
   *      written changed_by='admin', counted=false: publicly visible (see
   *      getPublicNicknameHistory) without spending the bot's free renames.
   *
   * base_skill edits do NOT escape the hard clamps: effectiveSkillCap applies
   * HARD_SKILL_CAP after every override, so this can move a bot within the
   * band, never above the frozen cap. Stated in the response.
   */
  async patchBot(req: Request, res: Response): Promise<void> {
    assertOpsAuthorized(req);
    const { botUserId } = req.validated.params as BotUserIdParams;
    const body = req.validated.body as PatchBotBody;

    // ONE TRANSACTION for the whole patch: every validation that reads DB
    // state, every write, the nickname history row and the audit rows.
    //
    // Previously these were separate statements, so a failure part-way through
    // (a taken nickname after a valid rpSet) left the earlier writes committed
    // with NO audit rows — a silent, untraceable difficulty change. Anything
    // that throws below now rolls back the entire edit.
    const result = await sql.begin(async (tx) => {
      // Locked read: FOR UPDATE on users + ranked_profiles +
      // synthetic_player_profiles, held to commit. This is the before-image for
      // BOTH the audit rows and the rpAdjust arithmetic, so a concurrent PATCH
      // on the same bot waits here rather than computing off a stale snapshot.
      const before = await tuningRepo.getEditableBot(botUserId, { tx, lock: true });
      if (!before) throw new NotFoundError('No persistent-bot profile for that user id');

      const edits: BotAdminEditEntry[] = [];
      const applied: Record<string, unknown> = {};
      const warnings: string[] = [];

      // --- RP -----------------------------------------------------------------
      let newRp: number | undefined;
      if (body.rpSet !== undefined || body.rpAdjust !== undefined) {
        const currentRp = before.rp ?? 0;
        const target = body.rpSet !== undefined ? body.rpSet : currentRp + body.rpAdjust!;
        newRp = Math.max(0, Math.round(target));

        // UNCACHED and inside the tx on purpose. loadHumanTop10Rp() caches for
        // 60s, so the rail could be validated against a human #10 that has since
        // moved — letting an admin park a bot above the live top 10, the exact
        // outcome the rail exists to prevent.
        const humanTop10Rp = await governorRepo.getHumanTop10Rp(tx);
        if (humanTop10Rp !== null) {
          const ceiling = humanTop10Rp - RP_CEILING_MARGIN_BELOW_HUMAN_TOP10;
          if (newRp > ceiling) {
            throw new BadRequestError(
              `RP ${newRp} would place this bot above the safety ceiling of ${ceiling} `
                + `(live human #10 is ${humanTop10Rp}, minus the ${RP_CEILING_MARGIN_BELOW_HUMAN_TOP10} RP margin).`,
              { field: body.rpSet !== undefined ? 'rpSet' : 'rpAdjust', ceiling, humanTop10Rp },
            );
          }
        } else {
          // No placed humans yet: every bot is trivially in the public top 10, so
          // refuse rather than guess a threshold.
          throw new BadRequestError(
            'Cannot rail-check RP: no placed human players exist to derive the top-10 ceiling from.',
            { field: body.rpSet !== undefined ? 'rpSet' : 'rpAdjust' },
          );
        }

        if (newRp !== currentRp) {
          const tier = tierFromRp(newRp);
          const updated = await rankedRepo.setRankPoints(botUserId, newRp, tier, tx);
          if (updated === null) {
            throw new NotFoundError('Bot has no ranked profile; RP cannot be set');
          }
          edits.push({ botUserId, field: 'rp', oldValue: String(currentRp), newValue: String(newRp) });
          applied.rp = newRp;
          applied.tier = tier;
          warnings.push(
            'RP also affects how strongly this bot plays: effective skill is derived from current RP '
              + '+ hidden skill + governor offset.',
          );
        }
      }

      // --- nickname -----------------------------------------------------------
      if (body.nickname !== undefined && body.nickname !== before.nickname) {
        const nickname = body.nickname;
        assertNicknameAllowed(nickname, botUserId);
        if (await usersRepo.isNicknameTaken(nickname, botUserId, tx)) {
          throw new ConflictError('Nickname is already taken', { field: 'nickname' });
        }
        if (await usersRepo.isNicknameReserved(nickname, botUserId, tx)) {
          throw new ConflictError(
            'Nickname was recently released by another player and is temporarily reserved',
            { field: 'nickname' },
          );
        }
        // counted=false: an admin edit must not spend the bot's 2 free renames.
        // changed_by='admin' is what keeps the row publicly visible anyway.
        const updated = await usersRepo.changeNicknameInTx({
          userId: botUserId,
          oldNickname: before.nickname,
          newNickname: nickname,
          changedBy: 'admin',
          counted: false,
          // MUST join our tx: left to its own sql.begin it takes a separate pool
          // connection and commits the rename even when this patch rolls back.
          tx,
        });
        if (!updated) throw new InternalError('Nickname change failed unexpectedly');
        edits.push({ botUserId, field: 'nickname', oldValue: before.nickname, newValue: nickname });
        applied.nickname = nickname;
      }

      // --- profile fields -----------------------------------------------------
      const profileFields: { baseSkill?: number; dailyCap?: number } = {};
      if (body.baseSkill !== undefined && body.baseSkill !== before.baseSkill) {
        profileFields.baseSkill = body.baseSkill;
        edits.push({
          botUserId,
          field: 'base_skill',
          oldValue: String(before.baseSkill),
          newValue: String(body.baseSkill),
        });
        applied.baseSkill = body.baseSkill;
        warnings.push(
          `Hidden skill stays subject to the immutable clamps: HARD_SKILL_CAP (${HARD_SKILL_CAP}) and the `
            + 'ceiling bound are applied after this value at match time, so raising it cannot lift a bot '
            + 'above the frozen cap.',
        );
      }
      if (body.dailyCap !== undefined && body.dailyCap !== before.dailyCap) {
        profileFields.dailyCap = body.dailyCap;
        edits.push({
          botUserId,
          field: 'daily_cap',
          oldValue: String(before.dailyCap),
          newValue: String(body.dailyCap),
        });
        applied.dailyCap = body.dailyCap;
      }
      await tuningRepo.updateProfileFields(botUserId, profileFields, tx);

      // Nothing actually differed: commit an empty transaction and report it.
      if (edits.length === 0) {
        return { botUserId, changed: false as const, applied: {}, warnings: [], note: body.note };
      }

      const requestId = randomUUID();
      // Same transaction as the writes above: audit rows and the changes they
      // describe commit together or not at all.
      await tuningRepo.recordAdminEdits(edits, requestId, body.note, tx);

      return {
        botUserId,
        changed: true as const,
        requestId,
        applied,
        before: {
          nickname: before.nickname,
          rp: before.rp,
          baseSkill: before.baseSkill,
          dailyCap: before.dailyCap,
        },
        warnings,
        note: body.note,
      };
    });

    // Logged only after COMMIT: an "edit applied" line for a rolled-back patch
    // would be a lie in the operator's audit trail.
    if (result.changed) {
      logger.info(
        { botUserId, requestId: result.requestId, fields: Object.keys(result.applied), note: body.note },
        'Bot admin edit applied',
      );
    }

    res.json(result);
  },

  /**
   * GET /api/v1/internal/bots/tuning/roster/:botUserId/history — audit trail.
   */
  async getBotHistory(req: Request, res: Response): Promise<void> {
    assertOpsAuthorized(req);
    const { botUserId } = req.validated.params as BotUserIdParams;
    const edits = await tuningRepo.listAdminEdits(botUserId);
    res.json({ botUserId, edits });
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
