-- Ranked RP system:
-- - Current ranked state per user (ranked_profiles)
-- - Immutable RP change ledger (ranked_rp_changes)
-- - Archive tables for reset-before-new-cycle operations
-- - Ranked context payload for lobby/match lifecycle

ALTER TABLE public.lobbies
  ADD COLUMN IF NOT EXISTS ranked_context jsonb;

ALTER TABLE public.matches
  ADD COLUMN IF NOT EXISTS ranked_context jsonb;

CREATE TABLE IF NOT EXISTS public.ranked_profiles (
  user_id uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  rp integer NOT NULL DEFAULT 1200 CHECK (rp >= 0),
  tier text NOT NULL,
  placement_status text NOT NULL DEFAULT 'unplaced'
    CHECK (placement_status IN ('unplaced', 'in_progress', 'placed')),
  placement_required smallint NOT NULL DEFAULT 3 CHECK (placement_required = 3),
  placement_played smallint NOT NULL DEFAULT 0 CHECK (placement_played >= 0 AND placement_played <= 3),
  placement_wins smallint NOT NULL DEFAULT 0 CHECK (placement_wins >= 0 AND placement_wins <= 3),
  placement_seed_rp integer CHECK (placement_seed_rp >= 0),
  placement_perf_sum integer NOT NULL DEFAULT 0,
  placement_points_for_sum integer NOT NULL DEFAULT 0,
  placement_points_against_sum integer NOT NULL DEFAULT 0,
  current_win_streak smallint NOT NULL DEFAULT 0 CHECK (current_win_streak >= 0),
  last_ranked_match_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ranked_profiles_rp_desc
  ON public.ranked_profiles (rp DESC, updated_at ASC);

CREATE INDEX IF NOT EXISTS idx_ranked_profiles_tier
  ON public.ranked_profiles (tier);

CREATE TABLE IF NOT EXISTS public.ranked_rp_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id uuid NOT NULL REFERENCES public.matches(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  opponent_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  opponent_is_ai boolean NOT NULL,
  old_rp integer NOT NULL,
  delta_rp integer NOT NULL,
  new_rp integer NOT NULL,
  result text NOT NULL CHECK (result IN ('win', 'loss')),
  is_placement boolean NOT NULL DEFAULT false,
  placement_game_no smallint CHECK (placement_game_no IS NULL OR placement_game_no BETWEEN 1 AND 3),
  placement_anchor_rp integer,
  placement_perf_score integer,
  calculation_method text NOT NULL CHECK (calculation_method IN ('placement_seed', 'ranked_formula')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ranked_rp_changes_match_user_unique UNIQUE (match_id, user_id),
  CONSTRAINT ranked_rp_changes_consistent CHECK (new_rp = old_rp + delta_rp)
);

CREATE INDEX IF NOT EXISTS idx_ranked_rp_changes_user_created
  ON public.ranked_rp_changes (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ranked_rp_changes_match
  ON public.ranked_rp_changes (match_id);

CREATE TABLE IF NOT EXISTS public.ranked_reset_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  triggered_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  notes text
);

CREATE TABLE IF NOT EXISTS public.ranked_profiles_archive (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reset_batch_id uuid NOT NULL REFERENCES public.ranked_reset_batches(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  rp integer NOT NULL,
  tier text NOT NULL,
  placement_status text NOT NULL,
  placement_required smallint NOT NULL,
  placement_played smallint NOT NULL,
  placement_wins smallint NOT NULL,
  placement_seed_rp integer,
  placement_perf_sum integer NOT NULL,
  placement_points_for_sum integer NOT NULL,
  placement_points_against_sum integer NOT NULL,
  current_win_streak smallint NOT NULL,
  last_ranked_match_at timestamptz,
  archived_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ranked_profiles_archive_batch
  ON public.ranked_profiles_archive (reset_batch_id, rp DESC);

CREATE TABLE IF NOT EXISTS public.ranked_rp_changes_archive (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reset_batch_id uuid NOT NULL REFERENCES public.ranked_reset_batches(id) ON DELETE CASCADE,
  match_id uuid NOT NULL REFERENCES public.matches(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  opponent_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  opponent_is_ai boolean NOT NULL,
  old_rp integer NOT NULL,
  delta_rp integer NOT NULL,
  new_rp integer NOT NULL,
  result text NOT NULL,
  is_placement boolean NOT NULL,
  placement_game_no smallint,
  placement_anchor_rp integer,
  placement_perf_score integer,
  calculation_method text NOT NULL,
  source_created_at timestamptz NOT NULL,
  archived_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ranked_rp_changes_archive_batch
  ON public.ranked_rp_changes_archive (reset_batch_id, source_created_at DESC);
