-- Freecroco ranked (contract §7.1): a ranked play is reserved when the player joins matchmaking and follows the
-- player through search, pairing, lobby and match (searches are re-created on requeue, so the entry is keyed by the
-- player, not the search). matches.partner_pool marks a partner match at creation; settlement dispatches on it
-- before any Quizball reward runs. The entry row is the settlement ledger: one per (match, player), settled once.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Nullable, no default: a metadata-only change. The check is added NOT VALID (no scan of existing rows, all NULL):
-- it still binds every new or updated row.
ALTER TABLE public.matches ADD COLUMN IF NOT EXISTS partner_pool text;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_matches_partner_pool' AND conrelid = 'public.matches'::regclass) THEN
    ALTER TABLE public.matches
      ADD CONSTRAINT chk_matches_partner_pool
      CHECK (partner_pool IS NULL OR (partner_pool ~ '^[a-z][a-z0-9-]{0,31}-(test|production)$' AND mode = 'ranked')) NOT VALID;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.partner_ranked_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  play_id uuid NOT NULL UNIQUE REFERENCES public.partner_plays(id),
  partner_slug text NOT NULL,
  environment text NOT NULL,
  partner_player_id uuid NOT NULL REFERENCES public.partner_players(id),
  user_id uuid NOT NULL REFERENCES public.users(id),
  -- searching: play reserved, no match row yet (queue, pairing, lobby, draft); playing: a match row exists;
  -- settled: the play finished (or was cancelled by a block) with its score; cancelled: no event (refunded or not).
  state text NOT NULL DEFAULT 'searching',
  lobby_id uuid,
  match_id uuid REFERENCES public.matches(id),
  -- Set with the result, or staged on a 'playing' entry (with the leaver) when settlement must be retried.
  terminal_cause text,
  leaver_user_id uuid REFERENCES public.users(id),
  outcome text,
  score integer,
  refunded boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  CONSTRAINT chk_partner_ranked_entries_environment CHECK (environment IN ('test', 'production')),
  CONSTRAINT chk_partner_ranked_entries_state CHECK (state IN ('searching', 'playing', 'settled', 'cancelled')),
  CONSTRAINT chk_partner_ranked_entries_playing CHECK (state <> 'playing' OR match_id IS NOT NULL),
  CONSTRAINT chk_partner_ranked_entries_searching CHECK (state <> 'searching' OR match_id IS NULL),
  CONSTRAINT chk_partner_ranked_entries_scored CHECK (state = 'settled' OR score IS NULL),
  CONSTRAINT chk_partner_ranked_entries_closed CHECK ((state IN ('settled', 'cancelled')) = (settled_at IS NOT NULL)),
  CONSTRAINT chk_partner_ranked_entries_cause CHECK (terminal_cause IS NULL OR terminal_cause IN (
    'natural', 'left', 'early_leave', 'both_dropped', 'server_failure', 'search_cancelled', 'blocked', 'no_contest')),
  CONSTRAINT chk_partner_ranked_entries_outcome CHECK (outcome IS NULL OR outcome IN ('win', 'loss', 'draw')),
  CONSTRAINT chk_partner_ranked_entries_score CHECK (score IS NULL OR score BETWEEN 0 AND 500)
);
-- At most one open ranked play per player: a re-sent queue join reuses it instead of reserving another.
CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_ranked_entries_open
  ON public.partner_ranked_entries (user_id) WHERE state IN ('searching', 'playing');
-- The settlement ledger: a player is settled once per match.
CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_ranked_entries_match_user
  ON public.partner_ranked_entries (match_id, user_id) WHERE match_id IS NOT NULL;
-- The reconciler's work list.
CREATE INDEX IF NOT EXISTS idx_partner_ranked_entries_open_updated
  ON public.partner_ranked_entries (updated_at) WHERE state IN ('searching', 'playing');

ALTER TABLE public.partner_ranked_entries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.partner_ranked_entries FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.partner_ranked_entries TO service_role;
