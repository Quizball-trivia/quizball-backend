-- Complete original rows for the staging-only canonical catalogue alignment.
-- This is an operator journal, never an application or browser API.
CREATE TABLE public.core_staging_alignment_batches (
  id text PRIMARY KEY CHECK (id ~ '^[a-f0-9]{64}$'),
  source_project text NOT NULL CHECK (source_project = 'lfbwhxvwubzeqkztghok'),
  target_project text NOT NULL CHECK (target_project = 'nsdfiprfmhdqhbfxfwpv'),
  before_data jsonb NOT NULL,
  after_data jsonb,
  undo_data jsonb,
  verification jsonb NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  undone_at timestamptz
);
ALTER TABLE public.core_staging_alignment_batches ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.core_staging_alignment_batches FROM PUBLIC, anon, authenticated, service_role;
