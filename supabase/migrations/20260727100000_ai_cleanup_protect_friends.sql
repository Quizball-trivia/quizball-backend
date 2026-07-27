-- Protect AI opponents that have become part of the social graph.
--
-- Why: humans can send friend requests to AI opponents after ranked matches.
-- Friendships must keep those bots stable indefinitely; pending requests only
-- protect them while the request is visible, so ignored requests do not keep
-- bots alive forever.
--
-- This is a pure CREATE OR REPLACE that preserves the 10-match visibility
-- window and the FK-clearing order from 20260629110000_ai_cleanup_window_10.sql.
-- It only extends victim selection with friendship and recent pending-request
-- protection. Idempotent.

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
  -- lost, opponent score -> 0, so a loss renders as a draw). Lowered 50 -> 10 to
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
        AND NOT EXISTS (
          SELECT 1
          FROM public.friendships f
          WHERE f.user_low_id = u.id
             OR f.user_high_id = u.id
        )
        AND NOT EXISTS (
          SELECT 1
          FROM public.friend_requests fr
          WHERE fr.status = 'pending'
            AND fr.created_at > NOW() - INTERVAL '14 days'
            AND (
              fr.sender_user_id = u.id
              OR fr.receiver_user_id = u.id
            )
        )
        -- Never delete a bot that is mid-match: the protected-matches window
        -- only covers completed/abandoned, so an old bot playing an active
        -- match right now would otherwise be deleted under its opponent. The
        -- started_at bound keeps orphaned stuck-'active' matches (known prod
        -- issue) from protecting their bots forever.
        AND NOT EXISTS (
          SELECT 1
          FROM public.match_players amp
          JOIN public.matches am ON am.id = amp.match_id
          WHERE amp.user_id = u.id
            AND am.status = 'active'
            AND am.started_at > NOW() - INTERVAL '1 day'
        )
      LIMIT 250
      -- Lock victims for the rest of this transaction. acceptRequest locks both
      -- users FOR UPDATE before inserting a friendship, so an in-flight accept
      -- makes us skip the bot (SKIP LOCKED) and a later accept blocks until our
      -- commit and then sees the user gone. Without this, a friendship created
      -- between selection and DELETE would be silently cascade-deleted.
      FOR UPDATE SKIP LOCKED
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
