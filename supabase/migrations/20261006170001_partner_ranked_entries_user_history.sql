-- The same-opponent cap is checked on every pairing of two Freecroco players: without a user-led index on the match
-- history that check reads the whole ranked ledger, which grows by every match.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE INDEX IF NOT EXISTS idx_partner_ranked_entries_user_history
  ON public.partner_ranked_entries (user_id, match_id)
  INCLUDE (play_id)
  WHERE match_id IS NOT NULL;
