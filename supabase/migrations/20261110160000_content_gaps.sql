-- Content gaps: typed answers a game could not judge well (unknown name, a real person we hold no data for, a name that
-- matches several people, or a miss that may be our content's fault), aggregated per board and per judging context.
-- Read by the HQ Content Fixer agent through the admin API. No user or guest ids are kept. Private: RLS on, no grants.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE IF NOT EXISTS public.content_gaps (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  game text NOT NULL,
  mode text NOT NULL,
  -- The content unit the answer was judged against (a category, list, pair, board cell, round…).
  board_key text NOT NULL,
  -- What judged it: release + content revision + matcher version. A fix ships as a new context, so its gaps start fresh.
  context_fp text NOT NULL,
  verdict text NOT NULL,
  norm text NOT NULL,
  resolved_id text,
  candidate_ids text[],
  count integer NOT NULL DEFAULT 0,
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'open',
  lease_owner text,
  lease_token uuid,
  lease_until timestamptz,
  fix_id bigint,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_content_gaps_key UNIQUE (game, board_key, context_fp, verdict, norm),
  CONSTRAINT chk_content_gaps_game CHECK (char_length(game) BETWEEN 1 AND 40),
  CONSTRAINT chk_content_gaps_mode CHECK (mode IN ('daily', 'room', 'duel', 'realtime', 'practice')),
  CONSTRAINT chk_content_gaps_board_key CHECK (char_length(board_key) BETWEEN 1 AND 160),
  CONSTRAINT chk_content_gaps_context_fp CHECK (char_length(context_fp) BETWEEN 1 AND 200),
  CONSTRAINT chk_content_gaps_verdict CHECK (verdict IN ('unknown', 'uncovered', 'ambiguous', 'miss', 'reported')),
  CONSTRAINT chk_content_gaps_norm CHECK (char_length(norm) BETWEEN 1 AND 80),
  CONSTRAINT chk_content_gaps_resolved_id CHECK (resolved_id IS NULL OR char_length(resolved_id) BETWEEN 1 AND 80),
  CONSTRAINT chk_content_gaps_candidates CHECK (candidate_ids IS NULL OR cardinality(candidate_ids) <= 10),
  CONSTRAINT chk_content_gaps_count CHECK (count >= 0),
  CONSTRAINT chk_content_gaps_status CHECK (status IN ('open', 'checking', 'fixed', 'junk', 'correct', 'wontfix'))
);

CREATE INDEX IF NOT EXISTS idx_content_gaps_queue ON public.content_gaps (status, count DESC, last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_content_gaps_game ON public.content_gaps (game, status, last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_content_gaps_idle ON public.content_gaps (last_seen);

-- A few raw typings per gap and language (the agent needs the player's own spelling and script).
CREATE TABLE IF NOT EXISTS public.content_gap_samples (
  gap_id bigint NOT NULL REFERENCES public.content_gaps(id) ON DELETE CASCADE,
  locale text NOT NULL,
  typed text NOT NULL,
  seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (gap_id, locale, typed),
  CONSTRAINT chk_content_gap_samples_locale CHECK (locale IN ('es', 'en', 'ka', 'tr', 'ru', 'pt', 'de', 'fr', 'xx')),
  CONSTRAINT chk_content_gap_samples_typed CHECK (char_length(typed) BETWEEN 1 AND 160)
);

ALTER TABLE public.content_gaps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.content_gap_samples ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.content_gaps, public.content_gap_samples FROM PUBLIC, anon, authenticated;
