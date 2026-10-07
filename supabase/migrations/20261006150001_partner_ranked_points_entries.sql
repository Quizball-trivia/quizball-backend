-- The ranked points version in force when a partner match started, recorded on each entry at match creation and
-- read at settlement. NULL only on entries attached before this release: those settle on version 1.
-- The per-play score cap follows the editable table (at most 5000 per value), so the entry's 0..500 check widens.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';

ALTER TABLE public.partner_ranked_entries ADD COLUMN IF NOT EXISTS points_version integer;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_partner_ranked_entries_points_version' AND conrelid = 'public.partner_ranked_entries'::regclass
  ) THEN
    ALTER TABLE public.partner_ranked_entries
      ADD CONSTRAINT chk_partner_ranked_entries_points_version CHECK (points_version IS NULL OR points_version > 0) NOT VALID;
  END IF;
  -- Wider than the check it replaces, so every existing row already satisfies it; validated in the next migration.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_partner_ranked_entries_score_v2' AND conrelid = 'public.partner_ranked_entries'::regclass
  ) THEN
    ALTER TABLE public.partner_ranked_entries
      ADD CONSTRAINT chk_partner_ranked_entries_score_v2 CHECK (score IS NULL OR score BETWEEN 0 AND 5000) NOT VALID;
  END IF;
END $$;
ALTER TABLE public.partner_ranked_entries DROP CONSTRAINT IF EXISTS chk_partner_ranked_entries_score;
