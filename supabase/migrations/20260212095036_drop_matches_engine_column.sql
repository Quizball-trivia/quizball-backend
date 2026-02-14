-- Drop the engine column from matches table
-- This column was used to support multiple game engines, but we now only have possession_v1
-- All matches use the same engine, so this column is redundant

ALTER TABLE matches DROP COLUMN IF EXISTS engine;
