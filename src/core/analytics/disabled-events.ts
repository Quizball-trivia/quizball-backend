// Events nothing reads (audit 2026-10-21: no saved insight, alert, experiment or recurring report;
// a few appear only in launch funnel specs/checklists that were never queried after August).
// PostHog bills per event, so these are dropped at the choke point instead of being sent.
// Remove a name here to start collecting it again.
export const DISABLED_ANALYTICS_EVENTS: ReadonlySet<string> = new Set([
  'buscaminas_archive_open',
  'buscaminas_leaderboard_view',
  'draft_completed',
  'draft_started',
  'draft_ui_ready',
  'football_grid_engagement_ended',
  'football_grid_match_found',
  'football_grid_play_started',
  'football_grid_queue_joined',
  'football_grid_queue_left',
  'football_grid_rematch_response',
  'football_grid_viewed',
  'game_card_click',
  'game_exit',
  'game_replay',
  'ggt_guess_submitted',
  'grid_draw_offered',
  'grid_game_completed',
  'grid_series_completed',
  'lobby_left',
  'matchmaking_ai_fallback',
  'mini_game_intro_started',
  'minuto_archive_open',
  'minuto_leaderboard_view',
  'play_card_clicked',
  'ranked_match_found',
  'road_to_goal_question_resolved',

  // Gameplay telemetry the production DB records authoritatively (matches,
  // lobbies, mode rounds — surfaced on the CMS "Analytics (live)" page since
  // 2026-10-31). Duplicating it in PostHog burned ~45% of the event quota and
  // tripped the billing cap. Deliberately KEPT: match_started (feeds the
  // "Matches per day dropped" alert), guest_play_started and guest_converted
  // (pre-signup funnel + the guest-dedup anchor), account_created, api_error,
  // daily_challenge_completed (alert), registered_member_count_snapshot and
  // partner_* (alerts/tiles).
  'guest_member_play_completed',
  'guest_member_play_started',
  'guest_play_completed',
  'lobby_created',
  'lobby_joined',
  'match_abandoned',
  'match_completed',
  'match_created',
  'penalty_taken',
  'ranked_queue_joined',
]);

export function isAnalyticsEventEnabled(eventName: string): boolean {
  return !DISABLED_ANALYTICS_EVENTS.has(eventName);
}
