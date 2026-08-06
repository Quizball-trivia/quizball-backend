-- (1) Reading-grace backfill: dispatch_lead_ms lives in each tournament's
-- frozen config, so the new 3s default only reaches rows created after the
-- deploy. Non-terminal tournaments still carry 1200ms — including the live
-- Aug-8 event — and would give players no reading time.
UPDATE wl_tournaments
SET config = jsonb_set(config, '{dispatch_lead_ms}', '3000')
WHERE status NOT IN ('completed', 'cancelled', 'voided')
  AND (config->>'dispatch_lead_ms')::int < 3000;

-- (2) you.last_game_rank is polled by every entered client; the existing
-- index orders (tournament_id, game_index, user_id) which cannot serve
-- "newest game for THIS user" without a scan.
CREATE INDEX IF NOT EXISTS wl_game_results_user_latest
  ON wl_game_results (tournament_id, user_id, game_index DESC);
