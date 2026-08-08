-- Event-day forensics: durable connect/disconnect + rejected-answer traces.
-- Append-only, service-role only (no RLS exposure to clients).

CREATE TABLE IF NOT EXISTS wl_client_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tournament_id UUID NOT NULL,
  user_id UUID NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('subscribe', 'disconnect')),
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wl_client_events_tournament_at_idx
  ON wl_client_events (tournament_id, at);
CREATE INDEX IF NOT EXISTS wl_client_events_user_idx
  ON wl_client_events (tournament_id, user_id, at);

CREATE TABLE IF NOT EXISTS wl_answer_rejects (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tournament_id UUID NOT NULL,
  attempt_id UUID,
  user_id UUID NOT NULL,
  reason TEXT NOT NULL,
  answer JSONB,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wl_answer_rejects_tournament_at_idx
  ON wl_answer_rejects (tournament_id, at);

ALTER TABLE wl_client_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE wl_answer_rejects ENABLE ROW LEVEL SECURITY;
