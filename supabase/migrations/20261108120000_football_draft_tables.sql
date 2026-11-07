-- Football Draft: a release of real squads (written once by the private seed, read whole into memory), one setup a day, one
-- daily run per player per version on the daily-game kit, free and challenge runs, challenges and stored ties. Every table is
-- private (RLS on, no client grants): the server deals, judges and simulates; no client ever reads these directly.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE IF NOT EXISTS public.draft_packs (
  release text PRIMARY KEY,
  pack jsonb NOT NULL,
  active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_draft_packs_release CHECK (char_length(release) BETWEEN 1 AND 40),
  CONSTRAINT chk_draft_packs_pack CHECK (jsonb_typeof(pack) = 'object')
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_draft_packs_active ON public.draft_packs (active) WHERE active;

CREATE TABLE IF NOT EXISTS public.draft_days (
  day date PRIMARY KEY,
  number integer NOT NULL,
  content_version bigint NOT NULL,
  -- release, league, era, formation and the seed that decides the day's deal.
  setup jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_draft_days_number CHECK (number > 0),
  CONSTRAINT chk_draft_days_content_version CHECK (content_version > 0),
  CONSTRAINT chk_draft_days_setup CHECK (jsonb_typeof(setup) = 'object')
);

DROP TRIGGER IF EXISTS set_draft_days_updated_at ON public.draft_days;
CREATE TRIGGER set_draft_days_updated_at BEFORE UPDATE ON public.draft_days
  FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();

-- One table per version: the kit keeps one run per player per day, and each version has its own board.
DO $$
DECLARE
  v text;
BEGIN
  FOREACH v IN ARRAY ARRAY['budget', 'classic', 'knowledge'] LOOP
    EXECUTE format($f$
      CREATE TABLE IF NOT EXISTS public.draft_runs_%1$s (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid REFERENCES public.users(id) ON DELETE CASCADE,
        guest_id uuid REFERENCES public.guest_sessions(id) ON DELETE CASCADE,
        day date NOT NULL,
        ranked boolean NOT NULL DEFAULT false,
        content_version bigint NOT NULL,
        state jsonb NOT NULL,
        state_version integer NOT NULL DEFAULT 0,
        done boolean NOT NULL DEFAULT false,
        -- The board's whole order in one number (points, goal difference, goals).
        score integer,
        -- Wins, draws, losses, shown on the board.
        record integer,
        completed_at timestamptz,
        closes_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_draft_runs_%1$s_user_day UNIQUE (user_id, day),
        CONSTRAINT chk_draft_runs_%1$s_owner CHECK ((user_id IS NULL) <> (guest_id IS NULL)),
        CONSTRAINT chk_draft_runs_%1$s_ranked_member CHECK (NOT ranked OR user_id IS NOT NULL),
        CONSTRAINT chk_draft_runs_%1$s_content_version CHECK (content_version > 0),
        CONSTRAINT chk_draft_runs_%1$s_state_version CHECK (state_version >= 0),
        CONSTRAINT chk_draft_runs_%1$s_done CHECK (done = (completed_at IS NOT NULL)),
        CONSTRAINT chk_draft_runs_%1$s_done_result CHECK (NOT done OR (score IS NOT NULL AND record IS NOT NULL)),
        CONSTRAINT chk_draft_runs_%1$s_closes_at CHECK (closes_at > day::timestamp AT TIME ZONE 'UTC')
      )$f$, v);
    EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS uq_draft_runs_%1$s_guest_day ON public.draft_runs_%1$s (guest_id, day) WHERE guest_id IS NOT NULL', v);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_draft_runs_%1$s_leaderboard ON public.draft_runs_%1$s (day, score DESC NULLS LAST, completed_at) WHERE ranked AND done', v);
    EXECUTE format('ALTER TABLE public.draft_runs_%1$s ENABLE ROW LEVEL SECURITY', v);
    EXECUTE format('REVOKE ALL ON public.draft_runs_%1$s FROM PUBLIC, anon, authenticated', v);
  END LOOP;
END $$;

CREATE TABLE IF NOT EXISTS public.draft_free_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES public.users(id) ON DELETE CASCADE,
  guest_id uuid REFERENCES public.guest_sessions(id) ON DELETE CASCADE,
  kind text NOT NULL,
  challenge_code text,
  setup jsonb NOT NULL,
  state jsonb NOT NULL,
  state_version integer NOT NULL DEFAULT 0,
  done boolean NOT NULL DEFAULT false,
  score integer,
  coins_earned integer NOT NULL DEFAULT 0,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_draft_free_runs_owner CHECK ((user_id IS NULL) <> (guest_id IS NULL)),
  CONSTRAINT chk_draft_free_runs_kind CHECK (kind IN ('free', 'challenge')),
  CONSTRAINT chk_draft_free_runs_challenge CHECK ((kind = 'challenge') = (challenge_code IS NOT NULL)),
  CONSTRAINT chk_draft_free_runs_state_version CHECK (state_version >= 0)
);
CREATE INDEX IF NOT EXISTS idx_draft_free_runs_abandoned ON public.draft_free_runs (created_at) WHERE NOT done;
-- One go at a challenge per player: more would be new luck on a deal already seen.
CREATE UNIQUE INDEX IF NOT EXISTS uq_draft_free_runs_challenge_user ON public.draft_free_runs (challenge_code, user_id) WHERE challenge_code IS NOT NULL AND user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_draft_free_runs_challenge_guest ON public.draft_free_runs (challenge_code, guest_id) WHERE challenge_code IS NOT NULL AND guest_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_draft_free_runs_done ON public.draft_free_runs (completed_at) WHERE done;
CREATE INDEX IF NOT EXISTS idx_draft_free_runs_user ON public.draft_free_runs (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_draft_free_runs_guest ON public.draft_free_runs (guest_id) WHERE guest_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.draft_coin_awards (
  run_id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  day date NOT NULL,
  source text NOT NULL,
  coins integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_draft_coin_awards_source CHECK (source IN ('daily', 'free')),
  CONSTRAINT chk_draft_coin_awards_coins CHECK (coins > 0)
);
CREATE INDEX IF NOT EXISTS idx_draft_coin_awards_user_day ON public.draft_coin_awards (user_id, day, source);

CREATE TABLE IF NOT EXISTS public.draft_challenges (
  code text PRIMARY KEY,
  user_id uuid REFERENCES public.users(id) ON DELETE CASCADE,
  guest_id uuid REFERENCES public.guest_sessions(id) ON DELETE CASCADE,
  from_name text NOT NULL,
  setup jsonb NOT NULL,
  day date,
  picks jsonb NOT NULL,
  record jsonb NOT NULL,
  respins_used integer NOT NULL,
  source_run uuid NOT NULL UNIQUE,
  source_user uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_draft_challenges_owner CHECK ((user_id IS NULL) <> (guest_id IS NULL)),
  CONSTRAINT chk_draft_challenges_code CHECK (char_length(code) BETWEEN 6 AND 16),
  CONSTRAINT chk_draft_challenges_name CHECK (char_length(from_name) BETWEEN 1 AND 40)
);
CREATE INDEX IF NOT EXISTS idx_draft_challenges_user ON public.draft_challenges (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_draft_challenges_guest ON public.draft_challenges (guest_id) WHERE guest_id IS NOT NULL;

-- A pairing is played once, whichever side asks: a_run sorts before b_run, and the stored result is what anyone sees again.
CREATE TABLE IF NOT EXISTS public.draft_ties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  a_run uuid NOT NULL,
  b_run uuid NOT NULL,
  a_user uuid REFERENCES public.users(id) ON DELETE CASCADE,
  a_guest uuid REFERENCES public.guest_sessions(id) ON DELETE CASCADE,
  b_user uuid REFERENCES public.users(id) ON DELETE CASCADE,
  b_guest uuid REFERENCES public.guest_sessions(id) ON DELETE CASCADE,
  a_name text NOT NULL,
  b_name text NOT NULL,
  a_picks jsonb NOT NULL,
  b_picks jsonb NOT NULL,
  seed text NOT NULL,
  result jsonb NOT NULL,
  formation text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_draft_ties_pairing UNIQUE (a_run, b_run),
  CONSTRAINT chk_draft_ties_order CHECK (a_run < b_run),
  CONSTRAINT chk_draft_ties_a_owner CHECK ((a_user IS NULL) <> (a_guest IS NULL)),
  CONSTRAINT chk_draft_ties_b_owner CHECK ((b_user IS NULL) <> (b_guest IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_draft_ties_a_user ON public.draft_ties (a_user, created_at DESC) WHERE a_user IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_draft_ties_b_user ON public.draft_ties (b_user, created_at DESC) WHERE b_user IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_draft_ties_a_guest ON public.draft_ties (a_guest, created_at DESC) WHERE a_guest IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_draft_ties_b_guest ON public.draft_ties (b_guest, created_at DESC) WHERE b_guest IS NOT NULL;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['draft_packs', 'draft_days', 'draft_free_runs', 'draft_coin_awards', 'draft_challenges', 'draft_ties'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', t);
  END LOOP;
END $$;
