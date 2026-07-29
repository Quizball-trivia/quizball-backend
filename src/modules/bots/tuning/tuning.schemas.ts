/**
 * Zod schemas + SAFETY RAILS for the PR10 live-tuning surface.
 *
 * The rails here are the FIRST of two independent layers. The second is the set
 * of CHECK constraints in 20260729100000_bot_tuning_controls.sql, which hold
 * even if a future caller bypasses this schema. Neither layer can loosen the
 * immutable clamps in hard-clamps.ts — those are code constants applied at
 * match time, strictly after every override here.
 *
 * THE MARGIN RAIL (the one that matters most)
 * `ceilingMargin` is the gap BELOW the frozen S1 top-cohort accuracy at which
 * the bot ceiling sits. Effective ceiling = S1_TOP_COHORT_ACCURACY_HOLDOUT -
 * margin, so a SMALLER margin means a HIGHER ceiling (stronger bots). The rail
 * therefore rejects any margin below the frozen S1_CEILING_MARGIN: the operator
 * may only ever TIGHTEN the ceiling, never raise bot ability above the frozen
 * HARD_PROB_CAP that PR8 shipped.
 */

import { z } from 'zod';
import {
  HARD_PROB_CAP,
  S1_CEILING_MARGIN,
  S1_TOP_COHORT_ACCURACY_HOLDOUT,
  MIN_CEILING_ACCURACY,
} from '../calibration/hard-clamps.js';

/** Win-rate targets may never steer a bot to beat humans more often than this. */
export const MAX_TARGET_WINRATE = 0.55;

/** One governor step may never exceed these — a step is a trim, not a re-skill. */
export const MAX_GOVERNOR_STEP = 0.25;
export const MAX_TOP_PROTECTION_STEP = 0.5;

/** Hard rail on any bot's effective daily match cap. */
export const MAX_DAILY_CAP = 12;

/** Widest sane top-protection ring, in RP. */
export const MAX_PROTECTION_RP = 2000;

/**
 * The margin floor. Equal to the frozen S1 margin: a smaller margin would raise
 * the effective ceiling above HARD_PROB_CAP, which is exactly what the rail
 * exists to forbid.
 */
export const MIN_CEILING_MARGIN = S1_CEILING_MARGIN;

/**
 * The widest margin we accept. Bounded so the ceiling cannot be driven below
 * MIN_CEILING_ACCURACY, where the theta-ceiling solver misbehaves (see
 * hard-clamps.ts).
 */
export const MAX_CEILING_MARGIN = Number(
  (S1_TOP_COHORT_ACCURACY_HOLDOUT - MIN_CEILING_ACCURACY).toFixed(4),
);

/** Effective bot accuracy ceiling implied by a margin. */
export function ceilingAccuracyForMargin(margin: number): number {
  return S1_TOP_COHORT_ACCURACY_HOLDOUT - margin;
}

/**
 * The margin rail as a predicate, so the service and the tests agree on one
 * definition. A margin is acceptable only when the ceiling it implies does not
 * exceed the frozen hard cap (with a tiny float tolerance, since the margin
 * arrives as a JSON number and 0.9031 - 0.04 is not exactly 0.8631).
 */
const CEILING_EPSILON = 1e-9;
export function marginRaisesCeiling(margin: number): boolean {
  return ceilingAccuracyForMargin(margin) > HARD_PROB_CAP + CEILING_EPSILON;
}

const nullableNumber = (schema: z.ZodTypeAny) => schema.nullable().optional();

/**
 * PUT body. Every field is optional; an OMITTED field is left untouched, an
 * explicit `null` CLEARS the override back to the code constant. That
 * distinction is why the fields are `.nullable().optional()` rather than merely
 * optional — "reset to default" must be expressible.
 */
export const updateBotTuningBodySchema = z
  .object({
    ceilingMargin: nullableNumber(
      z
        .number()
        .min(MIN_CEILING_MARGIN, {
          message: `ceilingMargin may only TIGHTEN the bot ceiling: it must be >= the frozen S1 margin ${MIN_CEILING_MARGIN}`,
        })
        .max(MAX_CEILING_MARGIN)
        .refine((value) => !marginRaisesCeiling(value), {
          message: `ceilingMargin would raise the effective bot ceiling above the frozen HARD_PROB_CAP ${HARD_PROB_CAP}`,
        }),
    ),
    topBandTargetWinrate: nullableNumber(z.number().positive().max(MAX_TARGET_WINRATE)),
    midLadderTargetWinrate: nullableNumber(z.number().positive().max(MAX_TARGET_WINRATE)),
    governorStep: nullableNumber(z.number().positive().max(MAX_GOVERNOR_STEP)),
    topProtectionStep: nullableNumber(z.number().positive().max(MAX_TOP_PROTECTION_STEP)),
    topProtectionMarginRp: nullableNumber(z.number().int().min(0).max(MAX_PROTECTION_RP)),
    topProtectionCriticalRp: nullableNumber(z.number().int().min(0).max(MAX_PROTECTION_RP)),
    activityScale: nullableNumber(z.number().min(0).max(2)),
    maxDailyCap: nullableNumber(z.number().int().min(1).max(MAX_DAILY_CAP)),
    /** Free-text operator note recorded on the row for the audit trail. */
    updatedBy: z.string().min(1).max(200).optional(),
  })
  .strict()
  .refine(
    (body) =>
      body.topProtectionCriticalRp == null ||
      body.topProtectionMarginRp == null ||
      body.topProtectionCriticalRp <= body.topProtectionMarginRp,
    {
      message:
        'topProtectionCriticalRp must be <= topProtectionMarginRp (the critical ring is inside the warn ring)',
      path: ['topProtectionCriticalRp'],
    },
  );

export type UpdateBotTuningBody = z.infer<typeof updateBotTuningBodySchema>;

/** Query for the paginated roster overview. */
export const rosterOverviewQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  /** Optional nickname substring filter. */
  search: z.string().trim().min(1).max(60).optional(),
  /** Restrict to frozen / unfrozen bots. */
  frozen: z
    .union([z.literal('true'), z.literal('false')])
    .transform((value) => value === 'true')
    .optional(),
  sort: z.enum(['rp', 'winrate', 'matches_today', 'nickname']).default('rp'),
  direction: z.enum(['asc', 'desc']).default('desc'),
});

export type RosterOverviewQuery = z.infer<typeof rosterOverviewQuerySchema>;

/** Body for POST freeze/unfreeze. */
export const freezeBotBodySchema = z
  .object({
    frozen: z.boolean(),
    reason: z.string().min(1).max(200).optional(),
  })
  .strict();

export type FreezeBotBody = z.infer<typeof freezeBotBodySchema>;

/** Params for the per-bot routes. */
export const botUserIdParamsSchema = z.object({
  botUserId: z.string().uuid(),
});

export type BotUserIdParams = z.infer<typeof botUserIdParamsSchema>;

/**
 * Body for the emergency zero-offsets action. Requires an explicit
 * `confirm: true` so the destructive roster-wide write cannot be triggered by a
 * stray empty POST.
 */
export const zeroOffsetsBodySchema = z
  .object({
    confirm: z.literal(true),
    reason: z.string().min(1).max(200).optional(),
  })
  .strict();

export type ZeroOffsetsBody = z.infer<typeof zeroOffsetsBodySchema>;
