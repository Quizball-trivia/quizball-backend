-- Operator-only progress receipts for the first additive Grid/Squad content seed.
-- No game content, publication state, existing history or scheduler is changed.
CREATE TABLE public.feature_content_release_batches (
  id text PRIMARY KEY CHECK (id ~ '^[a-f0-9]{64}$'),
  source_project text NOT NULL,
  target_project text NOT NULL,
  feature_group text NOT NULL CHECK (feature_group IN ('grid', 'squad')),
  state text NOT NULL DEFAULT 'importing' CHECK (state IN ('importing', 'imported', 'retained')),
  manifest jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK (source_project <> target_project)
);
CREATE TABLE public.feature_content_release_chunks (
  batch_id text NOT NULL REFERENCES public.feature_content_release_batches(id) ON DELETE RESTRICT,
  table_name text NOT NULL CHECK (table_name IN (
    'squad_spin_players', 'squad_spin_criteria', 'squad_spin_player_aliases',
    'squad_spin_combos', 'squad_spin_calibrations',
    'football_grid_content_releases', 'football_grid_criteria',
    'football_grid_criterion_memberships', 'football_grid_data_sources',
    'football_grid_membership_evidence', 'football_grid_boards',
    'football_grid_board_answers', 'football_grid_player_aliases',
    'football_grid_content_quarantines'
  )),
  chunk_index integer NOT NULL CHECK (chunk_index >= 0),
  row_count integer NOT NULL CHECK (row_count BETWEEN 1 AND 500),
  input_hash text NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  after_hash text NOT NULL CHECK (after_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (batch_id, table_name, chunk_index)
);
ALTER TABLE public.feature_content_release_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feature_content_release_chunks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.feature_content_release_batches, public.feature_content_release_chunks
  FROM PUBLIC, anon, authenticated, service_role;
