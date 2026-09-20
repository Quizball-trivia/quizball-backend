-- Operator-only, append-only ownership evidence for changing runtime asset URLs.
-- Existing import receipts remain immutable. A binding records the full before
-- and after row so replay/undo can recognize this exact authorized change.
CREATE TABLE public.content_media_binding_batches (
  id text PRIMARY KEY CHECK (id ~ '^[a-f0-9]{64}$'),
  target_project text NOT NULL,
  manifest jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.content_media_binding_rows (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id text NOT NULL REFERENCES public.content_media_binding_batches(id),
  content_batch_id text NOT NULL CHECK (content_batch_id ~ '^[a-f0-9]{64}$'),
  table_name text NOT NULL CHECK (table_name IN ('question_payloads','football_players','fifa_cards','squad_spin_players','goal_choreographies')),
  row_id uuid NOT NULL,
  before_data jsonb NOT NULL,
  after_data jsonb NOT NULL,
  undo_before_data jsonb,
  undo_data jsonb,
  undo_sequence bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  undone_at timestamptz,
  UNIQUE (batch_id, table_name, row_id),
  CHECK ((undo_data IS NULL) = (undone_at IS NULL)),
  CHECK ((undo_data IS NULL) = (undo_before_data IS NULL)),
  CHECK ((undo_data IS NULL) = (undo_sequence IS NULL))
);
CREATE INDEX content_media_binding_rows_content_lookup
  ON public.content_media_binding_rows(content_batch_id,table_name,row_id,sequence DESC);
ALTER TABLE public.content_media_binding_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.content_media_binding_rows ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.content_media_binding_batches,public.content_media_binding_rows FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON SEQUENCE public.content_media_binding_rows_sequence_seq FROM PUBLIC,anon,authenticated,service_role;

-- Only the small Squad player chunks need per-row identity proof for media
-- binding. Large Grid answer chunks keep this nullable field empty.
ALTER TABLE public.feature_content_release_chunks ADD COLUMN source_row_ids uuid[];
