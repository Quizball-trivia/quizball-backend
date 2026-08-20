-- Detect an interrupted online index-build retry. IF NOT EXISTS sees an
-- invalid relation by name, so a separate transactional guard must prevent the
-- deploy from recording a silently unusable hot-path index.
DO $$
DECLARE
  question_index_ready boolean;
BEGIN
  SELECT index_row.indisvalid AND index_row.indisready
  INTO question_index_ready
  FROM pg_catalog.pg_index index_row
  WHERE index_row.indexrelid = pg_catalog.to_regclass(
    'public.idx_questions_road_to_goal_eligible'
  );

  IF question_index_ready IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Road to Goal eligible-question index is missing or invalid';
  END IF;
END;
$$;
