-- Repair schema drift caused by index statements being added to historical
-- migration files after staging had already recorded those versions.
--
-- Production and freshly migrated local databases already have these indexes;
-- IF NOT EXISTS keeps this safe and idempotent everywhere. Staging needs them
-- before capacity testing so FK cleanup, user history, friend search, and
-- winner/opponent lookups exercise the same access paths as production.

CREATE INDEX IF NOT EXISTS idx_matches_winner_user_id
  ON public.matches (winner_user_id)
  WHERE winner_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_lobbies_host_user_id
  ON public.lobbies (host_user_id);

CREATE INDEX IF NOT EXISTS idx_lobby_category_bans_user_id
  ON public.lobby_category_bans (user_id);

CREATE INDEX IF NOT EXISTS idx_ranked_rp_changes_opponent_user_id
  ON public.ranked_rp_changes (opponent_user_id)
  WHERE opponent_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ranked_rp_changes_archive_user_id
  ON public.ranked_rp_changes_archive (user_id);

CREATE INDEX IF NOT EXISTS idx_ranked_rp_changes_archive_opponent_user_id
  ON public.ranked_rp_changes_archive (opponent_user_id)
  WHERE opponent_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_store_transaction_logs_actor_user_id
  ON public.store_transaction_logs (actor_user_id)
  WHERE actor_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ranked_profiles_archive_user_id
  ON public.ranked_profiles_archive (user_id);

CREATE INDEX IF NOT EXISTS idx_users_nickname_trgm
  ON public.users USING gin (nickname gin_trgm_ops)
  WHERE is_ai = false
    AND is_deleted = false
    AND deleted_at IS NULL
    AND pending_deletion_at IS NULL
    AND nickname IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_match_answers_user_id
  ON public.match_answers (user_id);
