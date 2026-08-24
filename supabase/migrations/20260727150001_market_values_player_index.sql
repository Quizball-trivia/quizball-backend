-- The current-value refresh joins latest valuation per player; without this
-- index the lateral join seq-scans 500k+ rows per player and times out.
CREATE INDEX IF NOT EXISTS idx_football_player_market_values_player_date
  ON public.football_player_market_values (football_player_id, valuation_date DESC);
