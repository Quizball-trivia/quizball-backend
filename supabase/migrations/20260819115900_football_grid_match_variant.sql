-- Football Grid part 1: durable match/lobby game-variant column, trigger,
-- backfill procedure, and CHECK constraints.
--
-- Split from 20260819120000 so the exclusive lock taken by the hot
-- public.matches / public.lobbies ALTERs is held by this short transaction
-- instead of surviving across the entire original migration. Constraint
-- adds are guarded so environments that already applied the combined
-- migration stay no-ops here.

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Durable match/lobby variant
-- ---------------------------------------------------------------------------

ALTER TABLE public.matches
  ADD COLUMN IF NOT EXISTS game_variant text DEFAULT 'friendly_possession';

-- PostgreSQL stores a constant ADD COLUMN default as table metadata rather
-- than rewriting every historical match. Drop the default immediately so the
-- rolling-deploy trigger below remains authoritative for legacy writers.
ALTER TABLE public.matches ALTER COLUMN game_variant DROP DEFAULT;

-- Rolling-deploy compatibility for legacy writers and test fixtures that do
-- not yet send the new discriminator. The database derives it once at insert;
-- runtime dispatch still treats the persisted value as authoritative and
-- fails closed for anything outside the explicit constraint below.
CREATE OR REPLACE FUNCTION public.set_match_game_variant_on_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.game_variant IS NULL THEN
    NEW.game_variant := CASE
      WHEN NEW.mode = 'auction' THEN 'auction'
      WHEN NEW.mode = 'ranked' THEN 'ranked_sim'
      WHEN NEW.state_payload->>'variant' = 'friendly_party_quiz' THEN 'friendly_party_quiz'
      WHEN NEW.state_payload->>'variant' = 'football_grid' THEN 'football_grid'
      ELSE 'friendly_possession'
    END;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_match_game_variant_on_insert ON public.matches;
CREATE TRIGGER set_match_game_variant_on_insert
  BEFORE INSERT ON public.matches
  FOR EACH ROW EXECUTE FUNCTION public.set_match_game_variant_on_insert();

-- Called by the following non-transactional migration. Each iteration commits
-- independently, so historical ranked/auction/party rows never hold one large
-- lock set for the duration of the complete backfill.
-- Guarded creation: the validation migration on environments that already
-- applied the original combined migration drops this helper when it finishes,
-- so re-creating it unconditionally would leave dead cruft behind.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
     WHERE p.proname = 'football_grid_backfill_game_variants'
       AND p.pronamespace = 'public'::regnamespace
  ) THEN
    CREATE OR REPLACE PROCEDURE public.football_grid_backfill_game_variants(batch_size integer DEFAULT 1000)
    LANGUAGE plpgsql
    AS $inner$
DECLARE  updated_count integer;
  has_remaining boolean;
  stalled_rounds integer := 0;
BEGIN
  LOOP
    WITH batch AS (
      SELECT id,
             CASE
               WHEN mode = 'auction' THEN 'auction'
               WHEN mode = 'ranked' THEN 'ranked_sim'
               WHEN state_payload->>'variant' = 'friendly_party_quiz' THEN 'friendly_party_quiz'
               WHEN state_payload->>'variant' = 'football_grid' THEN 'football_grid'
               ELSE 'friendly_possession'
             END AS desired_variant
        FROM public.matches
       WHERE game_variant IS DISTINCT FROM CASE
               WHEN mode = 'auction' THEN 'auction'
               WHEN mode = 'ranked' THEN 'ranked_sim'
               WHEN state_payload->>'variant' = 'friendly_party_quiz' THEN 'friendly_party_quiz'
               WHEN state_payload->>'variant' = 'football_grid' THEN 'football_grid'
               ELSE 'friendly_possession'
             END
       ORDER BY id
       LIMIT GREATEST(batch_size, 1)
       FOR UPDATE SKIP LOCKED
    )
    UPDATE public.matches m
       SET game_variant = batch.desired_variant
      FROM batch
     WHERE m.id = batch.id;
    GET DIAGNOSTICS updated_count = ROW_COUNT;
    COMMIT;
    IF updated_count = 0 THEN
      SELECT EXISTS (
        SELECT 1
          FROM public.matches
         WHERE game_variant IS DISTINCT FROM CASE
                 WHEN mode = 'auction' THEN 'auction'
                 WHEN mode = 'ranked' THEN 'ranked_sim'
                 WHEN state_payload->>'variant' = 'friendly_party_quiz' THEN 'friendly_party_quiz'
                 WHEN state_payload->>'variant' = 'football_grid' THEN 'football_grid'
                 ELSE 'friendly_possession'
               END
      ) INTO has_remaining;
      EXIT WHEN NOT has_remaining;
      -- A zero-row SKIP LOCKED batch can mean the remaining candidates are
      -- temporarily locked, not that the backfill is complete.
      stalled_rounds := stalled_rounds + 1;
      IF stalled_rounds > 240 THEN
        RAISE EXCEPTION 'football_grid_backfill_game_variants stalled: candidate rows stayed locked for 60 seconds';
      END IF;
      PERFORM pg_sleep(0.25);
    ELSE
      stalled_rounds := 0;
    END IF;
  END LOOP;
END;
$$inner$;
  END IF;
END
$$;

REVOKE ALL ON PROCEDURE public.football_grid_backfill_game_variants(integer) FROM PUBLIC;

-- Guarded adds: environments that already applied the original combined
-- migration (e.g. staging) must treat this file as a no-op.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     WHERE c.conname = 'matches_game_variant_check'
       AND c.conrelid = 'public.matches'::regclass
  ) THEN
    ALTER TABLE public.matches
      DROP CONSTRAINT IF EXISTS matches_game_variant_check;
    ALTER TABLE public.matches
      ADD CONSTRAINT matches_game_variant_check CHECK (
        game_variant IN (
          'friendly_possession',
          'friendly_party_quiz',
          'ranked_sim',
          'auction',
          'football_grid'
        )
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     WHERE c.conname = 'matches_game_variant_not_null'
       AND c.conrelid = 'public.matches'::regclass
  ) THEN
    ALTER TABLE public.matches
      ADD CONSTRAINT matches_game_variant_not_null CHECK (game_variant IS NOT NULL) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     WHERE c.conname = 'lobbies_game_mode_check_v2'
       AND c.conrelid = 'public.lobbies'::regclass
  ) THEN
    ALTER TABLE public.lobbies
      ADD CONSTRAINT lobbies_game_mode_check_v2 CHECK (
        game_mode IN (
          'friendly_possession',
          'friendly_party_quiz',
          'auction',
          'ranked_sim',
          'football_grid'
        )
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     WHERE c.conname = 'matches_mode_game_variant_check'
       AND c.conrelid = 'public.matches'::regclass
  ) THEN
    ALTER TABLE public.matches
      ADD CONSTRAINT matches_mode_game_variant_check CHECK (
        (mode = 'auction' AND game_variant = 'auction')
        OR (mode = 'ranked' AND game_variant = 'ranked_sim')
        OR (
          mode = 'friendly'
          AND game_variant IN ('friendly_possession', 'friendly_party_quiz', 'football_grid')
        )
      ) NOT VALID;
  END IF;
END
$$;

