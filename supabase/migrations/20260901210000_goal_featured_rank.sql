-- Curated onboarding order: a new player's first goals are the most famous
-- ones (owner-picked), then selection falls back to random. NULL = unranked.
ALTER TABLE goal_choreographies ADD COLUMN IF NOT EXISTS featured_rank int;

COMMENT ON COLUMN goal_choreographies.featured_rank IS
  'Serve order for a player''s first sessions; NULL ranks after all featured goals.';
