import { z } from 'zod';

export const wlTournamentStatusSchema = z.enum([
  'scheduled', 'content_pending', 'ready', 'entry_open', 'entry_closed',
  'checkin', 'game_live', 'break', 'qualifier_done', 'final_checkin',
  'final_live', 'completed', 'cancelled', 'voided', 'paused',
]);

export const wlEntryStateSchema = z.enum([
  'entered', 'playing', 'eliminated', 'finalist', 'champion',
  'no_show', 'withdrawn', 'disqualified', 'cancelled',
]);

export const wlQpResponseSchema = z.object({
  /** The upcoming event's week — display context only; QP is NOT weekly. */
  week_key: z.string().nullable(),
  /** RUNNING BALANCE: awards since the player's latest ticket purchase
   *  (entering a tournament resets it) — not this week's counter. */
  points: z.number().int(),
  wins: z.number().int(),
  losses: z.number().int(),
  target: z.number().int(),
  qualified: z.boolean(),
});

export const wlYouSchema = z.object({
  entered: z.boolean(),
  state: wlEntryStateSchema.nullable(),
  checked_in: z.boolean(),
  final_checked_in: z.boolean(),
  /** Your rank in the most recent finished game — the board broadcast is
      top-24 only, so players beyond the cut need this to see their number. */
  last_game_rank: z.number().int().nullable(),
  qp: wlQpResponseSchema,
});

export const wlTournamentSchema = z.object({
  id: z.string().uuid(),
  week_key: z.string().nullable(),
  status: wlTournamentStatusSchema,
  is_test: z.boolean(),
  entry_opens_at: z.string().nullable(),
  entry_closes_at: z.string().nullable(),
  qualifier_starts_at: z.string().nullable(),
  final_starts_at: z.string().nullable(),
  registered_count: z.number().int(),
  checked_in_count: z.number().int(),
  launch_edition: z.boolean(),
  qp_target: z.number().int(),
  /** 0-based index of the game currently running (or next to run). */
  current_game_index: z.number().int(),
  /** Server-clock epoch ms when the between-games break ends; null outside breaks. */
  break_until_ms: z.number().int().nullable(),
  /** How far behind live the spectator stream runs — spectator countdowns
   *  must shift by this or they finish before the delayed stream catches up. */
  spectator_delay_ms: z.number().int(),
  /** API server clock at response build — pre-game countdowns must tick
   *  against THIS (via an offset), never the device clock, or a skewed
   *  phone shows the wrong time to kickoff. */
  server_now_ms: z.number().int(),
});

export const wlCurrentResponseSchema = z.object({
  tournament: wlTournamentSchema.nullable(),
  you: wlYouSchema.nullable(),
});

export const wlEnterResponseSchema = z.object({
  entered: z.boolean(),
  already_entered: z.boolean(),
  reason: z.enum(['ok', 'no_tournament', 'window_closed', 'not_qualified']).optional(),
});

export const wlCheckinResponseSchema = z.object({
  checked_in: z.boolean(),
  already_checked_in: z.boolean(),
  reason: z.enum(['ok', 'no_tournament', 'window_closed', 'not_entered', 'not_finalist']).optional(),
});

export type WlTournamentStatus = z.infer<typeof wlTournamentStatusSchema>;
export type WlEntryState = z.infer<typeof wlEntryStateSchema>;
export type WlQpResponse = z.infer<typeof wlQpResponseSchema>;
export type WlCurrentResponse = z.infer<typeof wlCurrentResponseSchema>;
export type WlEnterResponse = z.infer<typeof wlEnterResponseSchema>;
export type WlCheckinResponse = z.infer<typeof wlCheckinResponseSchema>;
