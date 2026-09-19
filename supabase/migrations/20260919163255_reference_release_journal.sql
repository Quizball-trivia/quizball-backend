-- Operator-only receipts for additive core-reference imports. No content or
-- publication state is changed by installing these tables.
CREATE TABLE public.reference_release_batches (
  id text PRIMARY KEY CHECK (id ~ '^[a-f0-9]{64}$'),
  source_project text NOT NULL,
  target_project text NOT NULL,
  policy text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (source_project <> target_project)
);
CREATE TABLE public.reference_release_rows (
  batch_id text NOT NULL REFERENCES public.reference_release_batches(id) ON DELETE RESTRICT,
  table_name text NOT NULL CHECK (table_name IN ('football_players','fifa_cards','goal_choreographies','player_clue_cards')),
  row_id uuid NOT NULL,
  operation text NOT NULL CHECK (operation IN ('insert','fill-null-labels')),
  before_data jsonb,
  after_data jsonb NOT NULL,
  undo_data jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  undone_at timestamptz,
  PRIMARY KEY (batch_id,table_name,row_id)
);
ALTER TABLE public.reference_release_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reference_release_rows ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.reference_release_batches, public.reference_release_rows FROM PUBLIC, anon, authenticated, service_role;
