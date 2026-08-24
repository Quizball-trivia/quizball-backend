-- Shadow anti-cheat telemetry: client tab/app visibility transitions during
-- live realtime matches ("player left the tab mid-question" detection).
--
-- The client emits `match:visibility_signal` on Page Visibility / focus
-- transitions; the SERVER stamps the time and enriches question context from
-- the match cache, so rows are server-authoritative — client clocks are never
-- trusted. v1 is detection-only: nothing player-facing reads this table; an
-- offline suspicion query (scripts/anti-cheat/visibility-suspicion.sql) pairs
-- hidden->visible episodes with match_answers timing.
--
-- Named "visibility", NOT "presence": `match:presence_heartbeat` already means
-- "stage UI mounted" (Redis-only, unpersisted) and the two must not be
-- conflated.
--
-- Idempotent: IF NOT EXISTS on the table and indexes.

CREATE TABLE IF NOT EXISTS match_visibility_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  signal text NOT NULL CHECK (signal IN ('hidden', 'visible', 'blur', 'focus', 'pagehide')),
  q_index integer,
  question_id uuid,
  phase text,
  question_kind text,
  question_open boolean NOT NULL DEFAULT false,
  mode text,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Episode pairing scans (match, user, time); the user index serves
-- per-user investigation queries. Time-leading analysis over the whole
-- table stays cheap because retention keeps the table small (see purge job).
CREATE INDEX IF NOT EXISTS match_visibility_events_match_user_occurred_idx
  ON match_visibility_events (match_id, user_id, occurred_at);

CREATE INDEX IF NOT EXISTS match_visibility_events_user_occurred_idx
  ON match_visibility_events (user_id, occurred_at DESC);

-- Retention: shadow telemetry, 30 days is enough to tune heuristics and
-- investigate reports. Purge daily so the table (and its indexes) stay
-- bounded regardless of match volume.
CREATE EXTENSION IF NOT EXISTS pg_cron;

SELECT cron.unschedule('purge-match-visibility-events') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'purge-match-visibility-events'
);

SELECT cron.schedule(
  'purge-match-visibility-events',
  '40 2 * * *',
  $$DELETE FROM match_visibility_events WHERE occurred_at < now() - interval '30 days'$$
);

ALTER TABLE match_visibility_events ENABLE ROW LEVEL SECURITY;
-- No policies on purpose: deny-all for anon/authenticated; the backend's
-- service role bypasses RLS. Mirrors 20260702000000_enable_rls_all_public_tables.

COMMENT ON TABLE match_visibility_events IS
  'Server-stamped client visibility transitions during realtime matches (shadow anti-cheat telemetry, detection-only).';
COMMENT ON COLUMN match_visibility_events.signal IS
  'Client-reported transition: hidden/visible = Page Visibility API, blur/focus = window focus, pagehide = best-effort unload.';
COMMENT ON COLUMN match_visibility_events.q_index IS
  'cache.currentQIndex at receipt (server-derived, NOT client-supplied); null when no cache context.';
COMMENT ON COLUMN match_visibility_events.question_open IS
  'True when a question was live (cache.currentQuestion set) at receipt — the rows that matter for cheat analysis.';
COMMENT ON COLUMN match_visibility_events.occurred_at IS
  'Server clock at SOCKET RECEIPT. Inserts ride the socket DB task-limiter queue (up to 30s under load), so created_at can lag; all timing analysis must use occurred_at.';
