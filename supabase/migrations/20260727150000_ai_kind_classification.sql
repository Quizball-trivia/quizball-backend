-- AI-user classification: `ai_kind` discriminates the synthetic populations so
-- destructive automation can name exactly what it may touch.
--
--   real user       is_ai=false  ai_kind=NULL
--   ranked-AI bot   is_ai=true   ai_kind='ephemeral'   (per-match throwaway; drained by cleanup)
--   roster bot      is_ai=true   ai_kind='persistent'  (permanent synthetic player; NEVER auto-deleted)
--   auction bot     is_ai=true   ai_kind='auction'     (auction-seat persistence rows; drained by cleanup)
--
-- Expand/contract: deploys run migrations while the previous app version still
-- serves, and that version inserts AI users without ai_kind. The BEFORE INSERT
-- bridge trigger classifies those as 'ephemeral' until every writer passes the
-- column explicitly. The strict `is_ai = (ai_kind IS NOT NULL)` consistency
-- CHECK is deliberately NOT added here — it ships in a follow-up migration
-- after the writer deploy is verified, which also drops the bridge trigger.
--
-- Idempotent: safe under manual apply + deploy runner re-run.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS ai_kind text
  CHECK (ai_kind IN ('ephemeral', 'persistent', 'auction'));

CREATE OR REPLACE FUNCTION public.users_default_ai_kind()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.is_ai AND NEW.ai_kind IS NULL THEN
    NEW.ai_kind := 'ephemeral';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_users_default_ai_kind ON public.users;
CREATE TRIGGER trg_users_default_ai_kind
  BEFORE INSERT ON public.users
  FOR EACH ROW
  EXECUTE FUNCTION public.users_default_ai_kind();

UPDATE public.users
SET ai_kind = 'ephemeral'
WHERE is_ai = true AND ai_kind IS NULL;

-- Index work on the live users table (idx_users_ai_kind, the nickname unique
-- index replacement) lives in 20260727150200_ai_kind_indexes.sql: standard
-- CREATE INDEX blocks writers for the whole surrounding transaction, so they live in
-- their own tiny migration where the block is only the ~100ms of the builds.

-- cleanup_ai_users v4: identical to 20260727100000 (10-match visibility window,
-- friendship + recent-pending-request protection, mid-match guard, FK-clearing
-- order, victim row locks) with ONE change: victim selection now requires
-- ai_kind IN ('ephemeral','auction'). Persistent roster bots — and any
-- malformed NULL-kind AI row — are structurally unreachable. 'auction' stays
-- deletable: auction-seat persistence keeps creating disposable rows that
-- previously drained through this same function.

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
        -- Strict allowlist: persistent roster bots (and malformed NULL-kind
        -- rows) are never candidates, no matter what the guards below say.
        AND u.ai_kind IN ('ephemeral', 'auction')
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

-- Account-deletion finalization must also be unable to reach AI users. Bots
-- cannot authenticate, so scheduling one requires an internal mistake — but
-- the roster guarantee is structural: NO destructive automation may accept an
-- AI row. requestDeletion() gains the same is_ai=false guard in code.
-- Body reproduced verbatim from 20260725180100_purge_nickname_history_on_deletion.sql
-- with ONE change: the expired-row selection adds `AND is_ai = false`.
CREATE OR REPLACE FUNCTION finalize_pending_account_deletions()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  expired_user_ids uuid[];
  auth_user_ids uuid[];
  finalized_count integer := 0;
BEGIN
  SELECT ARRAY_AGG(id)
  INTO expired_user_ids
  FROM (
    SELECT id
    FROM public.users
    WHERE pending_deletion_at IS NOT NULL
      AND pending_deletion_at <= NOW()
      AND deleted_at IS NULL
      AND is_deleted = false
      AND is_ai = false
    FOR UPDATE
  ) expired;

  IF expired_user_ids IS NULL OR ARRAY_LENGTH(expired_user_ids, 1) IS NULL THEN
    RETURN 0;
  END IF;

  -- Cast to uuid only after the regex filter has rejected malformed subjects.
  -- Postgres doesn't guarantee predicate evaluation order in WHERE, so a single-stage
  -- query risks `subject::uuid` running first and throwing on garbage data.
  SELECT ARRAY_AGG(DISTINCT subject::uuid)
  INTO auth_user_ids
  FROM (
    SELECT subject
    FROM public.user_identities
    WHERE user_id = ANY(expired_user_ids)
      AND provider = 'supabase'
      AND subject ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) valid_subjects;

  DELETE FROM public.user_identities
  WHERE user_id = ANY(expired_user_ids);

  DELETE FROM public.nickname_history
  WHERE user_id = ANY(expired_user_ids);

  UPDATE public.users
  SET
    email = NULL,
    nickname = 'Deleted Player',
    country = NULL,
    avatar_url = NULL,
    avatar_customization = NULL,
    favorite_club = NULL,
    deletion_requested_at = NULL,
    pending_deletion_at = NULL,
    deleted_at = NOW(),
    is_deleted = true,
    updated_at = NOW()
  WHERE id = ANY(expired_user_ids)
    AND deleted_at IS NULL
    AND is_deleted = false;

  GET DIAGNOSTICS finalized_count = ROW_COUNT;

  IF auth_user_ids IS NOT NULL AND ARRAY_LENGTH(auth_user_ids, 1) IS NOT NULL THEN
    DELETE FROM auth.users
    WHERE id = ANY(auth_user_ids);
  END IF;

  RETURN finalized_count;
END;
$$;

-- Re-assert the original execution restrictions: CREATE OR REPLACE resets grants,
-- and this SECURITY DEFINER function anonymizes users.
REVOKE EXECUTE ON FUNCTION finalize_pending_account_deletions() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION finalize_pending_account_deletions() FROM anon;
REVOKE EXECUTE ON FUNCTION finalize_pending_account_deletions() FROM authenticated;
