-- When a Freecroco player was first shown their ranked opponent. After that moment a search or match that ends without
-- a result returns the play only a few times a day, so cancelling until a favourable opponent appears does not pay.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE public.partner_ranked_entries ADD COLUMN IF NOT EXISTS opponent_shown_at timestamptz;

-- The daily count of plays returned after a reveal reads one player's recent entries.
CREATE INDEX IF NOT EXISTS idx_partner_ranked_entries_user_recent
  ON public.partner_ranked_entries (user_id, created_at);
