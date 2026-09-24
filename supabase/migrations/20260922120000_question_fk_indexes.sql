-- Deleting a question makes Postgres check every table that references it.
-- Four of those had no index on the referencing column, so each deleted row
-- cost a sequential scan of match_questions (1.6M rows on prod) and friends —
-- the CMS WL-content Undo (and the ordinary CMS question delete) hit the 30s
-- statement timeout. Plain CREATE INDEX (no CONCURRENTLY: the migration runner
-- holds an advisory-lock transaction); measured ~10s total on staging.
-- Guarded per table so local/test databases without every table still apply.
DO $$
BEGIN
  IF to_regclass('public.match_questions') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS match_questions_question_id_idx ON match_questions (question_id);
  END IF;
  IF to_regclass('public.road_to_goal_zone_question_calibrations') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS rtg_zone_question_calibrations_question_id_idx ON road_to_goal_zone_question_calibrations (question_id);
  END IF;
  IF to_regclass('public.daily_challenge_served_questions') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS daily_challenge_served_questions_question_id_idx ON daily_challenge_served_questions (question_id);
  END IF;
  -- Also speeds up every "was this source ever dealt?" lookup in the WL tooling.
  IF to_regclass('public.wl_questions') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS wl_questions_source_question_id_idx ON wl_questions (source_question_id) WHERE source_question_id IS NOT NULL;
  END IF;
END $$;
