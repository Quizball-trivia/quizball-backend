-- These internal views must use the caller's privileges/RLS. Production's
-- service_role and qb_readonly both have BYPASSRLS; their reads are preserved.
ALTER VIEW public.auction_player_eligibility_summary SET (security_invoker = true);
ALTER VIEW public.auction_player_pricing SET (security_invoker = true);
ALTER VIEW public.player_clue_generation_candidates SET (security_invoker = true);

-- Retain production's backend-only table access on staging as well.
REVOKE ALL ON TABLE public.auction_scout_encounters, public.auction_seen_cards,
  public.card_generation_attempts, public.card_generation_tasks,
  public.card_pipeline_controls, public.card_pipeline_runs,
  public.content_snapshot_players, public.content_snapshot_valuations,
  public.content_snapshots, public.pipeline_prompts, public.pipeline_workers,
  public.player_season_snapshots FROM PUBLIC, anon, authenticated;

ALTER FUNCTION public.free_kicks_rounds_touch_updated_at() SET search_path = pg_catalog;

-- Remove redundant expand-phase checks only after proving the final invariant
-- already protects writes. Existing CHECK/NOT NULL enforcement remains.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.lobbies'::regclass AND conname='lobbies_game_mode_check_v2') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint final JOIN pg_constraint bridge ON bridge.conrelid=final.conrelid
      WHERE final.conrelid='public.lobbies'::regclass AND final.conname='lobbies_game_mode_check'
        AND final.convalidated AND bridge.conname='lobbies_game_mode_check_v2'
        AND pg_get_expr(final.conbin,final.conrelid)=pg_get_expr(bridge.conbin,bridge.conrelid)
    ) THEN RAISE EXCEPTION 'Final lobby game-mode constraint is not equivalent and validated'; END IF;
    ALTER TABLE public.lobbies DROP CONSTRAINT lobbies_game_mode_check_v2;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.matches'::regclass AND conname='matches_game_variant_not_null') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='public.matches'::regclass AND attname='game_variant' AND attnotnull) THEN
      RAISE EXCEPTION 'Final match variant NOT NULL is missing';
    END IF;
    ALTER TABLE public.matches DROP CONSTRAINT matches_game_variant_not_null;
  END IF;
END;
$$;
