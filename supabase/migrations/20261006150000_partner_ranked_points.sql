-- Freecroco ranked points (contract §7.1) become editable by Quizball admins in the CMS. Every save is a new,
-- immutable version row; partner_config_versions.ranked_points_version points at the one in force. A ranked entry
-- records the version in force when its match started (next migration), so an edit never touches a running match.
-- Version 1 is the contract's table: nothing changes until someone saves.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- A constant default: metadata only, no rewrite.
ALTER TABLE public.partner_config_versions ADD COLUMN IF NOT EXISTS ranked_points_version integer NOT NULL DEFAULT 1;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_partner_config_versions_ranked_points' AND conrelid = 'public.partner_config_versions'::regclass
  ) THEN
    ALTER TABLE public.partner_config_versions
      ADD CONSTRAINT chk_partner_config_versions_ranked_points CHECK (ranked_points_version > 0);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.partner_ranked_points (
  partner_slug text NOT NULL,
  environment text NOT NULL,
  version integer NOT NULL,
  -- Index 1..5: win by 1..5 goals; index 6: by 6 or more.
  margin_winner integer[] NOT NULL,
  margin_loser integer[] NOT NULL,
  penalty_winner integer NOT NULL,
  penalty_loser integer NOT NULL,
  draw_after_penalties integer NOT NULL,
  left_not_ahead integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- NULL for the seeded version.
  created_by uuid,
  PRIMARY KEY (partner_slug, environment, version),
  FOREIGN KEY (partner_slug, environment) REFERENCES public.partner_config_versions (partner_slug, environment),
  CONSTRAINT chk_partner_ranked_points_version CHECK (version > 0),
  CONSTRAINT chk_partner_ranked_points_margin_shape CHECK (
    array_ndims(margin_winner) = 1 AND array_ndims(margin_loser) = 1
    AND array_lower(margin_winner, 1) = 1 AND array_lower(margin_loser, 1) = 1
    AND cardinality(margin_winner) = 6 AND cardinality(margin_loser) = 6
    AND array_position(margin_winner, NULL) IS NULL AND array_position(margin_loser, NULL) IS NULL),
  CONSTRAINT chk_partner_ranked_points_bounds CHECK (
    0 <= ALL (margin_winner) AND 5000 >= ALL (margin_winner) AND 0 <= ALL (margin_loser) AND 5000 >= ALL (margin_loser)
    AND penalty_winner BETWEEN 0 AND 5000 AND penalty_loser BETWEEN 0 AND 5000
    AND draw_after_penalties BETWEEN 0 AND 5000 AND left_not_ahead BETWEEN 0 AND 5000),
  CONSTRAINT chk_partner_ranked_points_winner_ge_loser CHECK (
    margin_winner[1] >= margin_loser[1] AND margin_winner[2] >= margin_loser[2] AND margin_winner[3] >= margin_loser[3]
    AND margin_winner[4] >= margin_loser[4] AND margin_winner[5] >= margin_loser[5]
    AND margin_winner[6] >= margin_loser[6] AND penalty_winner >= penalty_loser)
);

ALTER TABLE public.partner_ranked_points ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.partner_ranked_points FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.partner_ranked_points TO service_role;

INSERT INTO public.partner_ranked_points
  (partner_slug, environment, version, margin_winner, margin_loser, penalty_winner, penalty_loser,
   draw_after_penalties, left_not_ahead)
SELECT partner_slug, environment, 1, ARRAY[100, 150, 200, 250, 300, 500], ARRAY[50, 40, 30, 20, 10, 0], 100, 50, 60, 100
FROM public.partner_config_versions
ON CONFLICT (partner_slug, environment, version) DO NOTHING;
