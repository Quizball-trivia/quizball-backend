-- Allow the weekly live-crawl source alongside the original Kaggle dataset
-- source (the dataset's valuations stalled in Feb 2026; live values come
-- from transfermarkt.com directly).
ALTER TABLE public.football_player_market_values
  DROP CONSTRAINT IF EXISTS football_player_market_values_source_check;
ALTER TABLE public.football_player_market_values
  ADD CONSTRAINT football_player_market_values_source_check
  CHECK (source IN ('transfermarkt_dataset', 'transfermarkt_live'));
