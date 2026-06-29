-- Lower the AI-cleanup protection window from 50 to 10 matches.
--
-- Why: cleanup_ai_users() (see 20260615210000_fix_ai_cleanup_fk.sql) refuses to
-- delete an AI opponent while it still appears in any human's most-recent-N
-- matches, so deleting it can't corrupt visible match history. N was set to 50
-- to match the recent-matches API schema's `.max(50)`. But no client ever
-- requests more than 10 (mobile home/profile=5, web default=10), and there is no
-- UI that shows a 50-deep match history. Protecting 50 kept ~8,800 deletable-age
-- AI alive for no user-visible reason (at N=50 only ~6 were reapable; at N=10,
-- ~8,827 become reapable — measured on prod 2026-06-29).
--
-- Companion change: the recent-matches query schema max is lowered 50 -> 10 in
-- src/modules/stats/stats.schemas.ts in the same change set, so the API can never
-- return a match beyond the protection window. The window and the API max MUST
-- stay equal: if the endpoint can return N matches, cleanup must protect N.
--
-- This is a pure CREATE OR REPLACE that changes ONLY `recent_window` (50 -> 10).
-- Everything else — the FK-clearing order, batching, SECURITY DEFINER, search_path
-- pin, statement_timeout=0, and the EXECUTE revokes — is preserved verbatim from
-- 20260615210000_fix_ai_cleanup_fk.sql. Idempotent.

CREATE OR REPLACE FUNCTION cleanup_ai_users() RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  total_deleted integer := 0;
  batch_deleted integer;
  victim_ids uuid[];
  -- Must equal the recent-matches API `limit` max (stats.schemas.ts). An AI is
  -- only safe to delete once it has aged OUT of every human's most-recent-N
  -- window, otherwise deleting it corrupts a still-visible match (opponent name
  -- lost, opponent score → 0, so a loss renders as a draw). Lowered 50 -> 10 to
  -- match what the UI/endpoint actually exposes.
  recent_window constant integer := 10;
BEGIN
  -- Per-human set of their N most-recent non-dev matches. Any AI appearing in
  -- one of these matches is still shown somewhere and must NOT be deleted yet.
  DROP TABLE IF EXISTS _protected_match_ids;
  CREATE TEMP TABLE _protected_match_ids ON COMMIT DROP AS
    SELECT match_id FROM (
      SELECT mp.match_id,
             row_number() OVER (
               PARTITION BY mp.user_id
               ORDER BY COALESCE(m.ended_at, m.started_at) DESC
             ) AS rn
      FROM public.match_players mp
      JOIN public.matches m ON m.id = mp.match_id
      JOIN public.users u  ON u.id = mp.user_id
      WHERE u.is_ai = false
        AND m.is_dev = false
        AND m.status IN ('completed', 'abandoned')
    ) ranked
    WHERE rn <= recent_window;
  CREATE INDEX ON _protected_match_ids (match_id);

  LOOP
    SELECT array_agg(id) INTO victim_ids
    FROM (
      SELECT u.id
      FROM public.users u
      WHERE u.is_ai = true
        AND u.created_at < NOW() - INTERVAL '7 days'
        AND NOT EXISTS (
          SELECT 1
          FROM public.match_players mp
          JOIN _protected_match_ids p ON p.match_id = mp.match_id
          WHERE mp.user_id = u.id
        )
      LIMIT 250
    ) batch;

    EXIT WHEN victim_ids IS NULL;

    UPDATE public.matches
    SET winner_user_id = NULL
    WHERE winner_user_id = ANY(victim_ids);

    DELETE FROM public.lobbies
    WHERE host_user_id = ANY(victim_ids);

    DELETE FROM public.users
    WHERE id = ANY(victim_ids);
    GET DIAGNOSTICS batch_deleted = ROW_COUNT;

    total_deleted := total_deleted + batch_deleted;
    EXIT WHEN batch_deleted = 0;
  END LOOP;

  RETURN total_deleted;
END;
$$;

ALTER FUNCTION cleanup_ai_users() SET statement_timeout = 0;

REVOKE EXECUTE ON FUNCTION cleanup_ai_users() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION cleanup_ai_users() FROM anon;
REVOKE EXECUTE ON FUNCTION cleanup_ai_users() FROM authenticated;
REVOKE EXECUTE ON FUNCTION cleanup_ai_users() FROM service_role;
