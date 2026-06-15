-- Fix the weekly AI-user cleanup so it actually deletes (safely, and fast).
--
-- Background: `cleanup_ai_users()` (run by the `cleanup-ai-users-weekly`
-- pg_cron job, Sundays 03:00 UTC) deletes stale AI opponents. It has been
-- FAILING on every run since AI users started winning/hosting, rolling back the
-- whole transaction and deleting ZERO rows — which is why the AI user count
-- climbed into the tens of thousands.
--
-- (0) History safety (NEW). The old function deleted purely by age. But an AI
--     hard-delete cascade-removes its match_players row, so a still-visible past
--     match loses the opponent's name AND score (a 0–1 loss renders as 0–0).
--     The recent-matches UI shows up to 50 matches per user, so we now only
--     delete an AI once it has aged OUT of every human's most-recent-50 window.
--     AI still inside someone's window are kept and reaped on a later run once
--     newer matches push them past 50. Result: zero visible-history corruption.
--
-- TWO problems, both fixed here:
--
-- (1) FK violation. Two foreign keys to users.id have NO `ON DELETE` action, so
--     deleting a referenced AI user is rejected:
--       * matches.winner_user_id -> matches_winner_user_id_fkey  (AI won)
--       * lobbies.host_user_id   -> lobbies_host_user_id_fkey    (AI hosted)
--     Every other FK to users is ON DELETE CASCADE or SET NULL, so only these
--     two block the delete. The function now clears them first:
--       - matches.winner_user_id is NULLABLE → null it (match still happened;
--         it just no longer credits a now-deleted bot).
--       - lobbies.host_user_id is NOT NULL → can't null it, so delete the stale
--         AI-hosted lobby rows. Every child FK on lobbies cascades
--         (members/categories/bans/invitations) or is SET NULL (matches.lobby_id),
--         so this is self-contained. A 7-day-old AI-hosted lobby is dead state.
--
-- (2) Timeout. Two compounding causes:
--     (a) Unindexed FKs. Several columns that reference users.id had NO index,
--         so each AI-user delete forced a sequential scan of the referencing
--         table (for the FK check or the ON DELETE SET NULL/CASCADE mutation).
--         With ~16k deletes that is fatal. We add the missing indexes below.
--     (b) The job runs as role `postgres`, which carries a role-level
--         `statement_timeout = 30s`. Draining a 16k backlog (with cascades into
--         large tables like match_answers) cannot finish in 30s. A function-level
--         GUC override (`ALTER FUNCTION ... SET statement_timeout = 0`) lifts the
--         cap for this maintenance function only — authoritative whenever pg_cron
--         invokes it, in-database. We also delete in bounded 250-row batches so
--         each batch is small and lock windows stay short.
--
-- We deliberately do NOT alter the FK definitions; only add indexes and replace
-- the function. The cron schedule is unchanged and correct. Idempotent.
--
-- NOTE: this fix was dry-run against prod in a rolled-back transaction. Through
-- the connection pooler a hard 30s cap still applied (pooler-enforced, not the
-- role GUC), so the full drain could only be verified per-batch (~7s/250 rows,
-- FK fix correct, real users untouched). pg_cron runs in-database as `postgres`
-- where the function-level statement_timeout=0 applies, so the full drain
-- completes there. The first weekly run after deploy clears the backlog; verify
-- via cron.job_run_details.

-- (2a) Index every FK column that references users.id and was previously
-- UNINDEXED. On each user delete, Postgres checks (or SET NULL / CASCADE-mutates)
-- every referencing table; an unindexed referencing column means a full seq scan
-- of that table PER deleted user. With ~16k deletes that is fatal. These indexes
-- turn each check into a lookup. Partial WHERE ... IS NOT NULL where the column
-- is nullable keeps them small (only referencing rows are indexed).
CREATE INDEX IF NOT EXISTS idx_matches_winner_user_id
  ON public.matches (winner_user_id) WHERE winner_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lobbies_host_user_id
  ON public.lobbies (host_user_id);
CREATE INDEX IF NOT EXISTS idx_lobby_category_bans_user_id
  ON public.lobby_category_bans (user_id);
CREATE INDEX IF NOT EXISTS idx_ranked_rp_changes_opponent_user_id
  ON public.ranked_rp_changes (opponent_user_id) WHERE opponent_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ranked_rp_changes_archive_user_id
  ON public.ranked_rp_changes_archive (user_id);
CREATE INDEX IF NOT EXISTS idx_ranked_rp_changes_archive_opponent_user_id
  ON public.ranked_rp_changes_archive (opponent_user_id) WHERE opponent_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_store_transaction_logs_actor_user_id
  ON public.store_transaction_logs (actor_user_id) WHERE actor_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ranked_profiles_archive_user_id
  ON public.ranked_profiles_archive (user_id);

CREATE OR REPLACE FUNCTION cleanup_ai_users() RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  total_deleted integer := 0;
  batch_deleted integer;
  victim_ids uuid[];
  -- The recent-matches UI shows at most this many matches per user
  -- (stats.schemas.ts: limit max = 50). An AI is only safe to delete once it
  -- has aged OUT of every human's most-recent-N window, otherwise deleting it
  -- corrupts a still-visible match (opponent name lost, opponent score → 0,
  -- so a loss renders as a draw). We protect AI inside that window and let them
  -- be reaped on a later run once newer matches push them past N.
  recent_window constant integer := 50;
BEGIN
  -- Per-human set of their N most-recent non-dev matches. Any AI appearing in
  -- one of these matches is still shown somewhere and must NOT be deleted yet.
  -- Drop first in case a prior run in the same backend session left it behind.
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
    -- Take a bounded batch of stale AI user ids that are NOT referenced by any
    -- still-visible (recent-window) human match.
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
      LIMIT 250  -- verified ~7s/batch on prod; safely under statement_timeout
    ) batch;

    EXIT WHEN victim_ids IS NULL;  -- nothing left

    -- Clear the two FK pointers with no ON DELETE action, in order, BEFORE the
    -- user delete (so the FK checks pass):
    --   matches.winner_user_id is nullable → null it.
    UPDATE public.matches
    SET winner_user_id = NULL
    WHERE winner_user_id = ANY(victim_ids);

    --   lobbies.host_user_id is NOT NULL → delete the stale lobby (children
    --   cascade; matches.lobby_id is SET NULL).
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

-- Lift the role-level 30s statement_timeout for THIS function only, so the
-- weekly drain of a large backlog can't be cancelled mid-run. Applies whenever
-- the function executes (including under pg_cron). Batches keep each statement
-- short regardless; this is the safety net for the cumulative loop.
ALTER FUNCTION cleanup_ai_users() SET statement_timeout = 0;
