-- League/category packs for Football Grid ("choose what you play on").
--
-- Boards and matches carry a theme key; matchmaking pairs searchers within
-- the same theme and board selection filters on it. Existing boards are the
-- all-of-Europe mix, so they become the default 'european' pack.
--
-- The theme list mirrors the launch pack lineup (Box2Box parity, owner
-- decision 2026-08-27): european + eight league packs. Thin leagues stay
-- playable from day one because bots backfill every pack's queue.

ALTER TABLE public.football_grid_boards
  ADD COLUMN IF NOT EXISTS theme text NOT NULL DEFAULT 'european'
  CONSTRAINT football_grid_boards_theme_check CHECK (theme IN (
    'european', 'england', 'italy', 'spain', 'france',
    'netherlands', 'brazil', 'turkey', 'argentina'
  ));

CREATE INDEX IF NOT EXISTS football_grid_boards_theme_idx
  ON public.football_grid_boards (release_id, theme, difficulty);

ALTER TABLE public.football_grid_matches
  ADD COLUMN IF NOT EXISTS theme text NOT NULL DEFAULT 'european'
  CONSTRAINT football_grid_matches_theme_check CHECK (theme IN (
    'european', 'england', 'italy', 'spain', 'france',
    'netherlands', 'brazil', 'turkey', 'argentina'
  ));
