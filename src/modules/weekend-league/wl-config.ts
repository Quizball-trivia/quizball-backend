/**
 * Tournament config — the validated rules snapshot frozen onto each
 * wl_tournaments row at creation. ONLY this module writes config, so the
 * lenient readers (SQL predicates, service parsers) always see well-typed
 * values in practice; their leniency is defense in depth, not a contract.
 */

import { z } from 'zod';
import { SHOW_KINDS } from './show-packs/show-pack.js';
import { WL_QP_TARGET } from './wl-week.js';
import {
  WL_BREAK_MS,
  WL_CHECKIN_WINDOW_MS,
  WL_DISPATCH_LEAD_MS,
  WL_QUESTION_TIME_MS,
} from './wl-rules.js';

export const wlTournamentConfigSchema = z.object({
  /** 1 = launch scoring (30/40-pt steps, 300-pt who-am-i, 1000 max).
   *  2 = ranked-parity scoring (every question 0-100 on the ranked curve,
   *      who-am-i 100..20 by clue, 2100 max) — 2026-08-25 rework.
   *  3 = v2 + career_path pays flat 100 on correct (typed round, no speed
   *      decay), 45s breaks, 20s put-in-order — 2026-08-25 weekend fixes.
   *  NOTE: scoring itself reads deployment-global constants, not this field;
   *  the version documents which rules were live so past results stay
   *  interpretable. Readers accept all. */
  rules_version: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  launch_edition: z.boolean(),
  /** Which engine drives this tournament. 'stub' is for orchestration tests
   *  only and is refused for real (non-test) tournaments at runtime. */
  engine: z.enum(['live', 'stub']).default('live'),
  /** Free entry (no QP spend/gate). Honored ONLY on is_test tournaments —
   *  real events always charge the balance. */
  free_entry: z.boolean().default(false),
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
  /** Pay coin/item rewards for this event. Honored ONLY on is_test tournaments
   *  outside prod (staging rehearsal); real events pay by the global flag. */
  reward_payout: z.boolean().default(false),
  /** One game and done: game 0 is the final. Honored ONLY on is_test
   *  tournaments (host-run events are created as is_test rows). */
  single_game: z.boolean().optional(),
  /** Host-run event (e.g. a podcast quiz night): no scheduled kickoff. The
   *  account with this email starts it by hand (POST /weekend-league/host-start). */
  host_email: z.string().email().max(320).optional(),
  /** Branding key for a host-run event (the web picks title and art by it). */
  event_slug: z.string().regex(/^[a-z0-9-]{1,40}$/).optional(),
  /** When the hosts plan to press Start — shown on the event card only. */
  scheduled_at: z.string().datetime({ offset: true }).optional(),
  /** Weekly host-run events: the Monday (YYYY-MM-DD, Georgian) this row is
   *  for. Unique per event_slug (DB index), so a week gets exactly one row. */
  event_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** Host-run show with a hand-written pack: the round layout (replaces the
   *  WL round order for slot sequencing) and the loaded pack's hash. */
  show_rounds: z.array(z.object({
    kind: z.enum(SHOW_KINDS),
    count: z.number().int().min(1).max(15),
  })).min(1).max(12).optional(),
  show_pack_hash: z.string().max(64).optional(),
});

export type WlTournamentConfig = z.infer<typeof wlTournamentConfigSchema>;

export function buildWlConfig(overrides: Partial<WlTournamentConfig> = {}): WlTournamentConfig {
  return wlTournamentConfigSchema.parse({
    rules_version: 3,
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

/** A host-run event: no scheduled kickoff; one named account starts it. */
export function wlHostEmailOf(raw: Record<string, unknown> | null | undefined): string | null {
  const v = raw?.['host_email'];
  return typeof v === 'string' && v.includes('@') ? v.trim().toLowerCase() : null;
}

/** Questions per round for a show-pack event, or null (standard WL layout). */
export function wlShowLayoutOf(raw: Record<string, unknown> | null | undefined): number[] | null {
  const rounds = raw?.['show_rounds'];
  if (!Array.isArray(rounds) || rounds.length === 0) return null;
  const counts = rounds.map((r) => Number((r as Record<string, unknown> | null)?.['count']));
  return counts.every((n) => Number.isInteger(n) && n >= 1 && n <= 15) ? counts : null;
}

export function wlIsHostRun(raw: Record<string, unknown> | null | undefined): boolean {
  return wlHostEmailOf(raw) != null;
}
