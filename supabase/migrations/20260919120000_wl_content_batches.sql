-- WL content import (CMS): editor uploads into the wl_private pool.
--
-- wl_content_batches is created BEFORE any question is inserted and one
-- wl_content_batch_rows row exists per uploaded row from the start, so a
-- crash mid-import can never leave questions without an undo handle and a
-- row that failed before insertion is still reported with its position.
-- question_id is nullable with ON DELETE SET NULL: undo deletes the question
-- and keeps the row as the audit trail (summary + state). Batch membership is
-- also the "editor-authored" marker (older editor rows were script-ingested
-- with created_by NULL; agent rows carry the admin user id).
--
-- wl_content_reseeds keeps the previous wl_questions rows of a tournament
-- that was reseeded from the CMS, so a bad reseed can be restored.

CREATE TABLE IF NOT EXISTS wl_content_batches (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  kind            text NOT NULL,
  note            text,
  status          text NOT NULL DEFAULT 'processing'
                  CHECK (status IN ('processing', 'done', 'failed', 'undoing', 'undone')),
  row_count       integer NOT NULL DEFAULT 0,
  sync_to_staging boolean NOT NULL DEFAULT false,
  result          jsonb,
  error           text,
  undone_at       timestamptz
);

CREATE TABLE IF NOT EXISTS wl_content_batch_rows (
  batch_id    uuid NOT NULL REFERENCES wl_content_batches(id) ON DELETE CASCADE,
  row_index   integer NOT NULL,
  question_id uuid REFERENCES questions(id) ON DELETE SET NULL,
  summary     text NOT NULL DEFAULT '',
  state       text NOT NULL DEFAULT 'pending'
              CHECK (state IN ('pending', 'created', 'translated', 'published', 'failed', 'deleted')),
  error       text,
  PRIMARY KEY (batch_id, row_index)
);

CREATE INDEX IF NOT EXISTS wl_content_batch_rows_question_idx
  ON wl_content_batch_rows (question_id) WHERE question_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS wl_content_reseeds (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id uuid NOT NULL REFERENCES wl_tournaments(id) ON DELETE CASCADE,
  actor         text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  previous_rows jsonb NOT NULL,
  result        jsonb
);

CREATE INDEX IF NOT EXISTS wl_content_reseeds_tournament_idx ON wl_content_reseeds (tournament_id);

ALTER TABLE wl_content_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE wl_content_batch_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE wl_content_reseeds ENABLE ROW LEVEL SECURITY;
