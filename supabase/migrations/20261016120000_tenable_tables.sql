-- Football Tenable: one hidden top-10 list a day (solo, on the daily-game kit) and a private pool of lists for rooms
-- (room_pool, game 'tenable'). Lists name entities by id: players from the word-game footballer releases, managers /
-- clubs / nations from tenable_entities. New, empty tables: the plain index builds block nothing.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE IF NOT EXISTS public.tenable_days (
  day date PRIMARY KEY,
  number integer NOT NULL,
  -- A hash of the stored content (up to 2^32), wider than int4: any content change is a new version.
  content_version bigint NOT NULL,
  -- Server-only: one list {id, kind, release, matcher, tier, topicKey, title, note, asOf, slots: [{eid, figure}] x10}.
  list jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_tenable_days_number CHECK (number > 0),
  CONSTRAINT chk_tenable_days_content_version CHECK (content_version > 0),
  CONSTRAINT chk_tenable_days_list CHECK (jsonb_typeof(list) = 'object')
);

-- A run belongs to a member (user_id) or to a guest session (guest_id), never both; guest runs go with their
-- session when the guest sweeper retires it.
CREATE TABLE IF NOT EXISTS public.tenable_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES public.users(id) ON DELETE CASCADE,
  guest_id uuid REFERENCES public.guest_sessions(id) ON DELETE CASCADE,
  day date NOT NULL,
  ranked boolean NOT NULL DEFAULT false,
  content_version bigint NOT NULL,
  state jsonb NOT NULL,
  state_version integer NOT NULL DEFAULT 0,
  done boolean NOT NULL DEFAULT false,
  -- Slots found, 0–10.
  score integer,
  -- Lives left at the end (the board's tie-break: more lives = fewer misses, ranks higher).
  lives integer,
  completed_at timestamptz,
  -- Buenos Aires midnight ending `day`: ranked writes are fenced against the database clock at this instant.
  closes_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_tenable_runs_user_day UNIQUE (user_id, day),
  CONSTRAINT chk_tenable_runs_owner CHECK ((user_id IS NULL) <> (guest_id IS NULL)),
  CONSTRAINT chk_tenable_runs_ranked_member CHECK (NOT ranked OR user_id IS NOT NULL),
  CONSTRAINT chk_tenable_runs_content_version CHECK (content_version > 0),
  CONSTRAINT chk_tenable_runs_state_version CHECK (state_version >= 0),
  CONSTRAINT chk_tenable_runs_score CHECK (score BETWEEN 0 AND 10),
  CONSTRAINT chk_tenable_runs_lives CHECK (lives BETWEEN 0 AND 3),
  CONSTRAINT chk_tenable_runs_done CHECK (done = (completed_at IS NOT NULL)),
  CONSTRAINT chk_tenable_runs_done_result CHECK (NOT done OR (score IS NOT NULL AND lives IS NOT NULL)),
  CONSTRAINT chk_tenable_runs_closes_at CHECK (closes_at > day::timestamp AT TIME ZONE 'UTC')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_tenable_runs_guest_day ON public.tenable_runs (guest_id, day) WHERE guest_id IS NOT NULL;
-- The board reads ranked, finished runs only, best first (score, then lives left, then who finished first).
CREATE INDEX IF NOT EXISTS idx_tenable_runs_leaderboard ON public.tenable_runs (day, score DESC NULLS LAST, lives DESC NULLS LAST, completed_at) WHERE ranked AND done;

-- Managers, clubs and national teams (players live in wordgame_players). A release is immutable once published:
-- content names the release its ids were checked against.
CREATE TABLE IF NOT EXISTS public.tenable_entity_releases (
  id text PRIMARY KEY,
  fingerprint text NOT NULL,
  matcher_version integer NOT NULL,
  -- Rows per kind, checked on load: {"manager": n, "club": n, "nation": n}.
  counts jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_tenable_entity_releases_id CHECK (char_length(id) BETWEEN 3 AND 40),
  CONSTRAINT chk_tenable_entity_releases_counts CHECK (jsonb_typeof(counts) = 'object')
);

CREATE TABLE IF NOT EXISTS public.tenable_entities (
  release_id text NOT NULL REFERENCES public.tenable_entity_releases(id) ON DELETE CASCADE,
  kind text NOT NULL,
  eid text NOT NULL,
  name text NOT NULL,
  known text NOT NULL,
  fame integer NOT NULL,
  aliases text[] NOT NULL DEFAULT '{}',
  -- Tells namesakes apart in suggestions ("ESP" for a club, "ARG · 1962" for a manager).
  qualifier text,
  PRIMARY KEY (release_id, kind, eid),
  CONSTRAINT chk_tenable_entities_kind CHECK (kind IN ('manager', 'club', 'nation')),
  CONSTRAINT chk_tenable_entities_eid CHECK (char_length(eid) BETWEEN 1 AND 64),
  CONSTRAINT chk_tenable_entities_name CHECK (char_length(name) BETWEEN 1 AND 80 AND char_length(known) BETWEEN 1 AND 80),
  CONSTRAINT chk_tenable_entities_fame CHECK (fame BETWEEN 0 AND 100),
  CONSTRAINT chk_tenable_entities_aliases CHECK (cardinality(aliases) <= 24),
  CONSTRAINT chk_tenable_entities_qualifier CHECK (qualifier IS NULL OR char_length(qualifier) <= 40)
);

-- Everything ever published on either side (days, room pool), append-only, written in the same transaction as the
-- publication: the seeds refuse a list whose topic or entities overlap the other side, retired content included.
CREATE TABLE IF NOT EXISTS public.tenable_content_ledger (
  id bigserial PRIMARY KEY,
  side text NOT NULL,
  list_id text NOT NULL,
  topic_key text NOT NULL,
  kind text NOT NULL,
  -- The ten entity ids, best first.
  eids text[] NOT NULL,
  -- The day it was published for (days side), null for the pool.
  day date,
  -- A replacement (a recheck or a correction) names the list it replaces: a successor may share its predecessor's
  -- topic and entities on the same side and day; it may never move to the other side.
  supersedes text,
  published_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_tenable_ledger_side CHECK (side IN ('day', 'room', 'reserved')),
  CONSTRAINT chk_tenable_ledger_kind CHECK (kind IN ('player', 'manager', 'club', 'nation')),
  CONSTRAINT chk_tenable_ledger_eids CHECK (cardinality(eids) = 10)
);
CREATE INDEX IF NOT EXISTS idx_tenable_ledger_topic ON public.tenable_content_ledger (topic_key);
CREATE INDEX IF NOT EXISTS idx_tenable_ledger_eids ON public.tenable_content_ledger USING gin (eids);

-- Server-only (RLS without policies, no client grants): lists and runs must never be readable through the Data API.
ALTER TABLE public.tenable_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenable_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenable_entity_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenable_entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenable_content_ledger ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tenable_days, public.tenable_runs, public.tenable_entity_releases, public.tenable_entities, public.tenable_content_ledger FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.tenable_days, public.tenable_runs, public.tenable_entity_releases, public.tenable_entities, public.tenable_content_ledger TO service_role;
REVOKE ALL ON SEQUENCE public.tenable_content_ledger_id_seq FROM PUBLIC, anon, authenticated;
GRANT ALL ON SEQUENCE public.tenable_content_ledger_id_seq TO service_role;

DROP TRIGGER IF EXISTS set_tenable_days_updated_at ON public.tenable_days;
CREATE TRIGGER set_tenable_days_updated_at BEFORE UPDATE ON public.tenable_days FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();
DROP TRIGGER IF EXISTS set_tenable_runs_updated_at ON public.tenable_runs;
CREATE TRIGGER set_tenable_runs_updated_at BEFORE UPDATE ON public.tenable_runs FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();
