-- Match production's reviewed routine ACLs on databases whose historical
-- migration ledger already contains the earlier staging definitions.
-- These are trigger functions; trigger execution is unchanged.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '10s';

REVOKE EXECUTE ON FUNCTION
  public.football_grid_protect_approved_source(),
  public.football_grid_protect_published_release(),
  public.football_grid_reject_mutation(),
  public.football_grid_validate_board_criteria(),
  public.football_grid_validate_claim(),
  public.football_grid_validate_event_sequence(),
  public.free_kicks_rounds_touch_updated_at(),
  public.prevent_card_family_identity_change(),
  public.set_match_game_variant_on_insert()
FROM anon, authenticated;

-- The validation migration already removes this temporary procedure on fresh
-- installs and production. Reconcile the old staging ledger without rerunning
-- the backfill or changing any match rows. No CASCADE.
DROP PROCEDURE IF EXISTS public.football_grid_backfill_game_variants(integer);
