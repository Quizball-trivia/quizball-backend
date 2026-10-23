// Events nothing reads (no insight, alert, experiment, report or runbook — audit 2026-10-21).
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
]);

export function isAnalyticsEventEnabled(eventName: string): boolean {
  return !DISABLED_ANALYTICS_EVENTS.has(eventName);
}
