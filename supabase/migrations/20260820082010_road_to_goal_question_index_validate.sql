DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index index_row
    WHERE index_row.indexrelid = pg_catalog.to_regclass(
      'public.idx_questions_road_to_goal_eligible'
    )
      AND index_row.indisvalid
      AND index_row.indisready
  ) THEN
    RAISE EXCEPTION 'Road to Goal eligible-question index is missing or invalid';
  END IF;
END;
$$;
