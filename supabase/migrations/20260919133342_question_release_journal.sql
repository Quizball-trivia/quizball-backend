-- Durable receipts for the additive question release. No content is imported
-- or published by this migration. Browser roles cannot read these snapshots.
CREATE TABLE public.question_release_batches (
  id text PRIMARY KEY CHECK (id ~ '^[a-f0-9]{64}$'),
  source_project text NOT NULL,
  target_project text NOT NULL,
  manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^[a-f0-9]{64}$'),
  preservation_map jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(preservation_map) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (source_project <> target_project)
);

CREATE TABLE public.question_release_rows (
  batch_id text NOT NULL REFERENCES public.question_release_batches(id) ON DELETE RESTRICT,
  table_name text NOT NULL CHECK (table_name IN ('categories', 'questions', 'question_payloads')),
  row_id uuid NOT NULL,
  phase text NOT NULL CHECK (phase IN ('import', 'publish', 'undo')),
  before_data jsonb,
  after_data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (batch_id, table_name, row_id, phase)
);

ALTER TABLE public.question_release_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.question_release_rows ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.question_release_batches, public.question_release_rows FROM PUBLIC, anon, authenticated, service_role;
-- The release operator connects through the normal migration/admin role.
-- No client-facing policy or runtime publishing permission is added.
