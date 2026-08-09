/**
 * Tournament config — the validated rules snapshot frozen onto each
 * wl_tournaments row at creation. ONLY this module writes config, so the
 * lenient readers (SQL predicates, service parsers) always see well-typed
 * values in practice; their leniency is defense in depth, not a contract.
 */

import { z } from 'zod';
import { WL_QP_TARGET } from './wl-week.js';
import {
  WL_BREAK_MS,
  WL_CHECKIN_WINDOW_MS,
  WL_DISPATCH_LEAD_MS,
  WL_QUESTION_TIME_MS,
} from './wl-rules.js';

export const wlTournamentConfigSchema = z.object({
  rules_version: z.literal(1),
  launch_edition: z.boolean(),
  /** Which engine drives this tournament. 'stub' is for orchestration tests
   *  only and is refused for real (non-test) tournaments at runtime. */
  engine: z.enum(['live', 'stub']).default('live'),
  /** Free entry (no QP spend/gate). Honored ONLY on is_test tournaments —
   *  real events always charge the balance. */
  free_entry: z.boolean().default(false),
  /** Final-rehearsal shape: ONE game (the full 5-round lineup) that crowns a
   *  champion at its end — no qualifier ladder, no Sunday. Honored only on
   *  is_test tournaments. */
  single_game: z.boolean().default(false),
  qp_target: z.number().int().min(0).max(999_999),
  question_time_ms: z.number().int().min(1_000).max(120_000),
  dispatch_lead_ms: z.number().int().min(0).max(30_000),
  break_ms: z.number().int().min(0).max(30 * 60_000),
  checkin_window_ms: z.number().int().min(10_000).max(60 * 60_000),
  /** Spectator delay — how far behind live the spec room runs. Fixed 30s in
   *  production; configurable so compressed test events stay testable. */
  spectator_delay_ms: z.number().int().min(1_000).max(120_000).default(30_000),
  /** Roster bots top the field up to this size at check-in (0 = no bots).
   *  Bots may qualify on merit but never win prizes (awards are humans-only). */
  bot_fill_min_field: z.number().int().min(0).max(2_000).default(0),
});

export type WlTournamentConfig = z.infer<typeof wlTournamentConfigSchema>;

export function buildWlConfig(overrides: Partial<WlTournamentConfig> = {}): WlTournamentConfig {
  return wlTournamentConfigSchema.parse({
    rules_version: 1,
    launch_edition: false,
    engine: 'live',
    qp_target: WL_QP_TARGET,
    question_time_ms: WL_QUESTION_TIME_MS,
    dispatch_lead_ms: WL_DISPATCH_LEAD_MS,
    break_ms: WL_BREAK_MS,
    checkin_window_ms: WL_CHECKIN_WINDOW_MS,
    spectator_delay_ms: 30_000,
    ...overrides,
  });
}

/** Reader with the same leniency contract as the service/SQL parsers. */
export function wlConfigFrom(raw: Record<string, unknown> | null | undefined): WlTournamentConfig {
  const parsed = wlTournamentConfigSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  return buildWlConfig();
}
