-- WL lineup upload (CMS): a server-side record of each lineup preview.
--
-- The editor uploads the questions for chosen games of one event and gets a
-- preview of the exact placements (uploaded questions + reserves taken from
-- the pool) and of what they replace. Saving sends only the preview id: the
-- server commits the stored manifest, never a client-supplied one. The
-- fingerprint is the event's full lineup as it was when previewed; if the
-- event changed since, nothing is saved. batch_id makes the save idempotent
-- (a retried save returns the batch it already started).

CREATE TABLE IF NOT EXISTS wl_content_lineup_previews (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  tournament_id uuid NOT NULL REFERENCES wl_tournaments(id) ON DELETE CASCADE,
  scope         text NOT NULL,
  games         integer[] NOT NULL,
  fingerprint   text NOT NULL,
  manifest      jsonb NOT NULL,
  expires_at    timestamptz NOT NULL,
  batch_id      uuid REFERENCES wl_content_batches(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS wl_content_lineup_previews_tournament_idx ON wl_content_lineup_previews (tournament_id);

ALTER TABLE wl_content_lineup_previews ENABLE ROW LEVEL SECURITY;
