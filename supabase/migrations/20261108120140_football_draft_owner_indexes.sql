SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';

-- Deleting a user or a guest session cascades into these tables, and bulk guest cleanup would otherwise scan them.
CREATE INDEX IF NOT EXISTS idx_draft_free_runs_user ON public.draft_free_runs (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_draft_free_runs_guest ON public.draft_free_runs (guest_id) WHERE guest_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_draft_challenges_user ON public.draft_challenges (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_draft_challenges_guest ON public.draft_challenges (guest_id) WHERE guest_id IS NOT NULL;
