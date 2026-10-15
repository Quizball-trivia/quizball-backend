-- Word games in Russian (matcher 2): each footballer's Russian name and the Russian name they are known by.
-- Nullable: matcher-1 releases have neither; a matcher-2 release carries both or neither per footballer.
ALTER TABLE public.wordgame_players
  ADD COLUMN IF NOT EXISTS name_ru text CHECK (name_ru IS NULL OR length(name_ru) BETWEEN 1 AND 80),
  ADD COLUMN IF NOT EXISTS game_name_ru text CHECK (game_name_ru IS NULL OR length(game_name_ru) BETWEEN 1 AND 80),
  ADD CONSTRAINT wordgame_players_ru_pair CHECK ((name_ru IS NULL) = (game_name_ru IS NULL));
