-- Per-season career snapshots for the auction "scouting snapshot" lots:
-- domestic-league stats aggregated from match data plus that season's
-- Transfermarkt value. One row per player per season. Written by the offline
-- content pipeline; read by the auction content layer.
CREATE TABLE IF NOT EXISTS public.player_season_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  football_player_id uuid NOT NULL
    REFERENCES public.football_players(id) ON DELETE CASCADE,
  transfermarkt_id text NOT NULL,
  -- 2023 means the 2023/24 season (Jul-Jun window as recorded upstream).
  season_start_year int NOT NULL,
  season_label text NOT NULL,
  competition_id text,
  league_name text NOT NULL,
  club_name text,
  -- Age at the end of that season.
  age int CHECK (age IS NULL OR age > 0),
  apps int NOT NULL CHECK (apps >= 0),
  goals int NOT NULL DEFAULT 0 CHECK (goals >= 0),
  assists int NOT NULL DEFAULT 0 CHECK (assists >= 0),
  minutes int NOT NULL DEFAULT 0 CHECK (minutes >= 0),
  -- Goalkeeper facets; null for outfield players.
  clean_sheets int CHECK (clean_sheets IS NULL OR clean_sheets >= 0),
  goals_conceded int CHECK (goals_conceded IS NULL OR goals_conceded >= 0),
  -- Last Transfermarkt valuation recorded within (or shortly after) the season.
  value_eur bigint CHECK (value_eur IS NULL OR value_eur > 0),
  value_date date,
  source text NOT NULL DEFAULT 'kaggle_transfermarkt'
    CHECK (source IN ('kaggle_transfermarkt', 'transfermarkt_live', 'manual')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (football_player_id, season_start_year)
);

CREATE INDEX IF NOT EXISTS idx_player_season_snapshots_player
  ON public.player_season_snapshots (football_player_id, season_start_year DESC);

ALTER TABLE public.player_season_snapshots ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS trg_player_season_snapshots_set_updated_at
  ON public.player_season_snapshots;
CREATE TRIGGER trg_player_season_snapshots_set_updated_at
  BEFORE UPDATE ON public.player_season_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();
